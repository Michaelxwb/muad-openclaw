// Package api wires the console's HTTP surface: routing, auth, and audit.
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/web"
)

// Server holds the console's dependencies and builds the HTTP handler.
type Server struct {
	cfg            *config.Config
	store          *repo.Store
	cipher         *crypto.Cipher
	bindingCodec   *crypto.BindingCodeCodec
	drv            driver.RuntimeDriver
	cache          *monitor.Cache
	reconcile      ReconcileEnqueuer
	operations     PodOperationRunner
	bindingLimiter *bindingAttemptLimiter
	loginLimiter   *bindingAttemptLimiter
}

// ReconcileEnqueuer receives Pod IDs whose desired runtime generation changed.
type ReconcileEnqueuer interface {
	Enqueue(podID string)
}

// PodOperationRunner serializes runtime mutations with config reconciliation.
type PodOperationRunner interface {
	RunExclusive(ctx context.Context, podID string, operation func(context.Context) error) error
}

var errRuntimeCoordinatorUnavailable = errors.New("runtime coordinator unavailable")

// NewServer constructs the API server.
func NewServer(
	cfg *config.Config, store *repo.Store, cipher *crypto.Cipher,
	drv driver.RuntimeDriver, cache *monitor.Cache, enqueuers ...ReconcileEnqueuer,
) *Server {
	server := &Server{
		cfg: cfg, store: store, cipher: cipher, drv: drv, cache: cache,
		bindingLimiter: newBindingAttemptLimiter(10*time.Minute, 10, 4096),
		loginLimiter:   newBindingAttemptLimiter(10*time.Minute, 5, 4096),
	}
	if cfg != nil {
		codec, err := crypto.NewBindingCodeCodec(cfg.MasterKey)
		if err != nil {
			log.Printf("binding_code_codec_unavailable error=%v", err)
		} else {
			server.bindingCodec = codec
		}
	}
	if len(enqueuers) > 0 {
		server.reconcile = enqueuers[0]
		server.operations, _ = enqueuers[0].(PodOperationRunner)
	}
	return server
}

func (s *Server) runPodExclusive(
	ctx context.Context, podID string, operation func(context.Context) error,
) error {
	if s.operations == nil {
		return errRuntimeCoordinatorUnavailable
	}
	return s.operations.RunExclusive(ctx, podID, operation)
}

func (s *Server) enqueueReconcile(podID string) {
	if s.reconcile != nil {
		s.reconcile.Enqueue(podID)
	}
}

// Handler builds the routed, middleware-wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)

	// Authenticated + audited API surface.
	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/v1/me", s.handleMe)
	s.registerAdminRoutes(protected)
	mux.Handle("/api/v1/", s.authMiddleware(s.auditMiddleware(protected)))

	internal := http.NewServeMux()
	s.registerInternalRoutes(internal)
	mux.Handle("/internal/v1/", s.internalAuthMiddleware(internal))

	// Serve the embedded SPA for everything else (prod build only; /healthz and
	// /api/v1/ take precedence as more specific patterns).
	if h, ok := web.Handler(); ok {
		mux.Handle("/", h)
	}
	return requestErrorLogMiddleware(mux)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"actor": actorFrom(r.Context())})
}

// --- response helpers (uniform envelope, §3.4) ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data}); err != nil {
		log.Printf("api_response_encode_failed status=%d error=%v", status, err)
	}
}

func writeErr(w http.ResponseWriter, status, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]any{"code": code, "message": msg}); err != nil {
		log.Printf("api_error_encode_failed status=%d code=%d error=%v", status, code, err)
	}
}

type errorLogRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (recorder *errorLogRecorder) WriteHeader(status int) {
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *errorLogRecorder) Write(value []byte) (int, error) {
	if recorder.status == 0 {
		recorder.status = http.StatusOK
	}
	if recorder.status >= http.StatusBadRequest && recorder.body.Len() < 4096 {
		remaining := 4096 - recorder.body.Len()
		recorder.body.Write(value[:min(len(value), remaining)])
	}
	return recorder.ResponseWriter.Write(value)
}

func requestErrorLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := requestID(r)
		w.Header().Set("X-Request-ID", requestID)
		recorder := &errorLogRecorder{ResponseWriter: w}
		started := time.Now()
		next.ServeHTTP(recorder, r)
		logErrorResponse(recorder, r, requestID, time.Since(started))
	})
}

func logErrorResponse(recorder *errorLogRecorder, r *http.Request, requestID string, elapsed time.Duration) {
	if recorder.status < http.StatusBadRequest {
		return
	}
	var envelope struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(recorder.body.Bytes(), &envelope)
	level := "WARN"
	if recorder.status >= http.StatusInternalServerError {
		level = "ERROR"
	}
	log.Printf("level=%s request_id=%s method=%s route=%q status=%d code=%d latency_ms=%d message=%q",
		level, requestID, r.Method, r.URL.Path, recorder.status, envelope.Code, elapsed.Milliseconds(), envelope.Message)
}

func requestID(r *http.Request) string {
	if value := r.Header.Get("X-Request-ID"); value != "" {
		return value
	}
	var value [8]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return "request-id-unavailable"
}

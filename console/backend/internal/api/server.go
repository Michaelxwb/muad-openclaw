// Package api wires the console's HTTP surface: routing, auth, and audit.
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeupgrade"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/skillsync"
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
	skillSyncer    *skillsync.Syncer
	reconcile      ReconcileEnqueuer
	reconcileNow   ReconcileRunner
	operations     PodOperationRunner
	upgradeSvc     *runtimeupgrade.Service
	cleanupWaker   CleanupWaker
	skillUploadMu  sync.Mutex
	bindingLimiter *bindingAttemptLimiter
	loginLimiter   *bindingAttemptLimiter
}

// ReconcileEnqueuer receives Pod IDs whose desired runtime generation changed.
type ReconcileEnqueuer interface {
	Enqueue(podID string)
}

// ReconcileRunner applies a Pod's current desired runtime generation before returning.
type ReconcileRunner interface {
	ReconcileNow(ctx context.Context, podID string) error
}

// PodOperationRunner serializes runtime mutations with config reconciliation.
type PodOperationRunner interface {
	RunExclusive(ctx context.Context, podID string, operation func(context.Context) error) error
}

// CleanupWaker requests an immediate sweep of deleting Human Users. It lets the
// delete endpoint wake the background cleaner right after marking a user
// deleting, instead of waiting for the cleaner's next ticker.
type CleanupWaker interface {
	Wake()
}

var errRuntimeCoordinatorUnavailable = errors.New("runtime coordinator unavailable")

// NewServer constructs the API server.
func NewServer(
	cfg *config.Config, store *repo.Store, cipher *crypto.Cipher,
	drv driver.RuntimeDriver, cache *monitor.Cache, skillSyncer *skillsync.Syncer,
	enqueuers ...ReconcileEnqueuer,
) *Server {
	server := &Server{
		cfg: cfg, store: store, cipher: cipher, drv: drv, cache: cache, skillSyncer: skillSyncer,
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
		server.reconcileNow, _ = enqueuers[0].(ReconcileRunner)
		server.operations, _ = enqueuers[0].(PodOperationRunner)
	}
	return server
}

// WithUpgradeService wires the one-way upgrade journal/maintenance gate.
func (s *Server) WithUpgradeService(service *runtimeupgrade.Service) *Server {
	s.upgradeSvc = service
	return s
}

// upgradeInProgress reports whether the pod's one-way runtime upgrade holds the
// maintenance freeze.
func (s *Server) upgradeInProgress(podID string) bool {
	return s.upgradeSvc != nil && s.upgradeSvc.Maintenance(podID)
}

// blockIfUpgradeInProgress freezes pod-scoped writes while a one-way upgrade is
// in flight. Returns true when the request must stop.
func (s *Server) blockIfUpgradeInProgress(w http.ResponseWriter, r *http.Request, podID string) bool {
	if !s.upgradeInProgress(podID) {
		return false
	}
	writeErr(w, r, errcode.ConflictPodUpgradeInProgress)
	return true
}

// upgradeDrainTimeout bounds the pre-switch drain: in-flight work that cannot
// be quiesced within the window aborts the upgrade before anything is rewritten
// (design §4.2: 超时不能安全排空时中止). The HTTP request context alone is not
// a bound — the UI keeps the request open while it waits.
const upgradeDrainTimeout = 2 * time.Minute

// WaitForQuiesce drains in-flight skills, long tasks and browser leases before
// the old runtime is stopped. It polls the real guard health RPC and is bounded
// by ctx; a drain failure aborts the upgrade before any state is rewritten.
func (s *Server) WaitForQuiesce(ctx context.Context, podID string) error {
	// error 态 Pod 的运行时已经崩溃（例如失败升级停在 error），没有在跑的
	// 任务可排空；这是"error 态改镜像"修复出口的必经路径，必须放行而不是
	// 等待一个永远不会健康的 gateway（2026-10-07 pod02 演练实证）。
	if pod, err := s.store.GetPod(podID); err == nil && pod.State == repo.PodStateError {
		return nil
	}
	drainCtx, cancel := context.WithTimeout(ctx, upgradeDrainTimeout)
	defer cancel()
	interval := 500 * time.Millisecond
	for {
		status := gateway.Probe(drainCtx, s.drv, podID)
		drained := status.Healthy &&
			status.SkillActive+status.SkillQueued == 0 &&
			status.LongTaskActive+status.LongTaskQueued == 0 &&
			status.BrowserActive+status.BrowserQueued == 0
		if drained {
			return nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-drainCtx.Done():
			timer.Stop()
			return fmt.Errorf("drain in-flight work for %s: %w", podID, drainCtx.Err())
		case <-timer.C:
		}
	}
}

// WithCleanupWaker wires the background cleaner so delete endpoints can wake it
// immediately. Optional: without a waker, deletion still converges through the
// cleaner's periodic sweep.
func (s *Server) WithCleanupWaker(waker CleanupWaker) *Server {
	s.cleanupWaker = waker
	return s
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
	return withLanguage(requestErrorLogMiddleware(mux))
}

// withLanguage resolves the request language from Accept-Language and injects it
// into the context so error responses can be localized (default zh). Mounted
// outermost so it also covers unauthenticated routes such as login.
func withLanguage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), langKey, parseLang(r.Header.Get("Accept-Language")))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
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

type errorLogRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (recorder *errorLogRecorder) Unwrap() http.ResponseWriter {
	return recorder.ResponseWriter
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
	var envelope struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(recorder.body.Bytes(), &envelope)
	level := "INFO"
	if recorder.status >= http.StatusBadRequest {
		level = "WARN"
	}
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

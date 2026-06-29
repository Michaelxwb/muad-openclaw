// Package api wires the console's HTTP surface: routing, auth, and audit.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/config"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/web"
)

// Server holds the console's dependencies and builds the HTTP handler.
type Server struct {
	cfg    *config.Config
	store  *repo.Store
	cipher *crypto.Cipher
	drv    driver.RuntimeDriver
	cache  *monitor.Cache
}

// NewServer constructs the API server.
func NewServer(cfg *config.Config, store *repo.Store, cipher *crypto.Cipher, drv driver.RuntimeDriver, cache *monitor.Cache) *Server {
	return &Server{cfg: cfg, store: store, cipher: cipher, drv: drv, cache: cache}
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

	// Containers (FEAT-01/02/03/05).
	protected.HandleFunc("POST /api/v1/containers", s.handleCreateContainer)
	protected.HandleFunc("GET /api/v1/containers", s.handleListContainers)
	protected.HandleFunc("DELETE /api/v1/containers/{userId}", s.handleDeleteContainer)
	protected.HandleFunc("GET /api/v1/containers/{userId}/logs", s.handleLogs)
	protected.HandleFunc("GET /api/v1/containers/{userId}/qrcode", s.handleQRCode)

	// LLM config (FEAT-04).
	protected.HandleFunc("GET /api/v1/llm", s.handleGetLLM)
	protected.HandleFunc("PUT /api/v1/llm", s.handleSetLLM)
	protected.HandleFunc("POST /api/v1/llm/test", s.handleTestLLM)
	protected.HandleFunc("PUT /api/v1/containers/{userId}/llm", s.handleSetUserLLM)
	protected.HandleFunc("POST /api/v1/llm/apply", s.handleApplyLLM)

	// Lifecycle / skills / upgrade / audit / alerts (FEAT-09/10/12/13/14).
	protected.HandleFunc("POST /api/v1/containers/{userId}/actions/{action}", s.handleAction)
	protected.HandleFunc("POST /api/v1/containers/{userId}/upgrade", s.handleUpgrade)
	protected.HandleFunc("POST /api/v1/skills/reload", s.handleSkillsReload)
	protected.HandleFunc("GET /api/v1/audit", s.handleAuditQuery)
	protected.HandleFunc("GET /api/v1/alerts", s.handleAlerts)

	// Container resource limits: global default + per-user override (dynamic config).
	protected.HandleFunc("GET /api/v1/settings/resources", s.handleGetResources)
	protected.HandleFunc("PUT /api/v1/settings/resources", s.handleSetResources)
	protected.HandleFunc("PUT /api/v1/containers/{userId}/resources", s.handleSetUserResources)

	mux.Handle("/api/v1/", s.authMiddleware(s.auditMiddleware(protected)))

	// Serve the embedded SPA for everything else (prod build only; /healthz and
	// /api/v1/ take precedence as more specific patterns).
	if h, ok := web.Handler(); ok {
		mux.Handle("/", h)
	}
	return mux
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"actor": actorFrom(r.Context())})
}

// --- response helpers (uniform envelope, §3.4) ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
}

func writeErr(w http.ResponseWriter, status, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "message": msg})
}

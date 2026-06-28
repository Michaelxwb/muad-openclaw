package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/auth"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type ctxKey string

const actorKey ctxKey = "actor"

const sessionTTL = 12 * time.Hour

// handleLogin verifies admin credentials and issues a session token (API-14).
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	admin, err := s.store.GetAdmin(req.Username)
	if err != nil || !auth.CheckPassword(admin.PasswordHash, req.Password) {
		writeErr(w, http.StatusUnauthorized, 40101, "invalid credentials")
		return
	}
	token := auth.Sign(s.cfg.JWTSecret, admin.Username, sessionTTL)
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expiresIn": int(sessionTTL.Seconds())})
}

// authMiddleware rejects requests without a valid Bearer token (NFR-SEC-01).
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		subject, err := auth.Verify(s.cfg.JWTSecret, strings.TrimSpace(token))
		if err != nil {
			writeErr(w, http.StatusUnauthorized, 40101, "unauthorized")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), actorKey, subject)))
	})
}

func actorFrom(ctx context.Context) string {
	if v, ok := ctx.Value(actorKey).(string); ok {
		return v
	}
	return ""
}

// BootstrapAdmin creates the initial admin from config if credentials are set.
func BootstrapAdmin(store *repo.Store, username, password string) error {
	if username == "" || password == "" {
		return nil
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	return store.CreateAdminIfAbsent(repo.Admin{Username: username, PasswordHash: hash})
}

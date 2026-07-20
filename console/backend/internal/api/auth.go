package api

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/auth"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type ctxKey string

const actorKey ctxKey = "actor"

const sessionTTL = 12 * time.Hour

// loginDummyPasswordHash is bcrypt of a fixed placeholder that is never used as a
// real admin password. It exists only so unknown-username logins still pay the
// bcrypt cost (timing parity with known usernames).
const loginDummyPasswordHash = "$2b$10$c5pYnJJG9o/BAuz1LJ499eu8MvcToGMMIrRNEyGyj5s3LWAFCM9zu"

// handleLogin verifies admin credentials and issues a session token (API-14).
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	// Cap body size (unauthenticated); reuse decodeJSONBody MaxBytesReader semantics.
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusUnauthorized, 40101, "invalid credentials")
		return
	}
	limitKey := loginRateLimitKey(r, req.Username)
	if ok, _ := s.loginLimiter.Allow(limitKey, time.Now().UTC()); !ok {
		writeErr(w, http.StatusTooManyRequests, codeRateLimited, "login attempts are rate limited")
		return
	}
	// Always bcrypt-compare (dummy hash on miss) to reduce username enumeration timing.
	admin, err := s.store.GetAdmin(req.Username)
	hash := admin.PasswordHash
	if err != nil {
		// bcrypt of a fixed non-admin placeholder password (not "x"/empty/common).
		// Only used when GetAdmin misses so CheckPassword still runs ~constant time.
		hash = loginDummyPasswordHash
	}
	if !auth.CheckPassword(hash, req.Password) || err != nil {
		writeErr(w, http.StatusUnauthorized, 40101, "invalid credentials")
		return
	}
	s.loginLimiter.Reset(limitKey)
	token := auth.Sign(s.cfg.JWTSecret, admin.Username, sessionTTL)
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expiresIn": int(sessionTTL.Seconds())})
}

func loginRateLimitKey(r *http.Request, username string) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || strings.TrimSpace(host) == "" {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	return host + "|" + username
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

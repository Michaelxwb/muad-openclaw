package api

import (
	"log"
	"net/http"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// auditMiddleware records every mutating request (POST/PUT/DELETE/PATCH) to the
// audit log after the handler runs (RULE-05). Reads are not audited.
func (s *Server) auditMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(auditlog.WithRequestTracker(r.Context()))
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		if isMutating(r.Method) && !auditlog.HasSemanticEvent(r.Context()) {
			entry := repo.AuditEntry{
				Actor:   actorFrom(r.Context()),
				Action:  r.Method + " " + r.URL.Path,
				Target:  fallbackAuditTarget(r),
				Payload: httpStatusNote(rec.status),
			}
			if err := s.store.AddAudit(entry); err != nil {
				log.Printf("audit_write_failed action=%q target=%q error=%v", entry.Action, entry.Target, err)
			}
		}
	})
}

func fallbackAuditTarget(r *http.Request) string {
	for _, key := range []string{"identityId", "humanUserId", "podId", "userId"} {
		if value := r.PathValue(key); value != "" {
			return value
		}
	}
	return ""
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		return true
	default:
		return false
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func httpStatusNote(code int) string {
	if code >= 200 && code < 300 {
		return "ok"
	}
	return "failed"
}

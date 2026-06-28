package api

import (
	"net/http"
	"strconv"
	"time"
)

const (
	defaultAuditLimit  = 20
	maxAuditLimit      = 100
	defaultAuditOffset = 0
)

// handleAuditQuery returns audit entries filtered by actor and time range
// with pagination (API-12, FEAT-12).
func (s *Server) handleAuditQuery(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from := parseRFC3339(q.Get("from"))
	to := parseRFC3339(q.Get("to"))

	offset, limit := parsePagination(r)

	entries, total, err := s.store.QueryAudit(q.Get("actor"), from, to, offset, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "query audit")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": entries, "total": total})
}

// parsePagination extracts offset/limit from query string with defaults and bounds.
func parsePagination(r *http.Request) (offset, limit int) {
	offset = defaultAuditOffset
	limit = defaultAuditLimit

	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v >= 0 {
		offset = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		if v <= 0 {
			limit = defaultAuditLimit
		} else if v > maxAuditLimit {
			limit = maxAuditLimit
		} else {
			limit = v
		}
	}
	return
}

type alert struct {
	UserID  string `json:"userId"`
	Level   string `json:"level"` // P1 / P2 / P3
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// memAlertMiB is 85% of the 2 GiB container limit (§4.3).
const memAlertMiB = 2048 * 85 / 100

// nearReapWindow is how close to reaping triggers a P3 alert.
const nearReapWindow = 24 * time.Hour

// handleAlerts evaluates current alert conditions from the monitor cache
// (API, FEAT-13). Markers only; external notification channels are out of scope.
func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request) {
	users, _, err := s.store.ListUsers(0, 0) // 0,0 = all, unpaginated
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "list users")
		return
	}
	alerts := make([]alert, 0)
	for _, u := range users {
		snap, ok := s.cache.Get(u.UserID)

		if u.State != "archived" && (!ok || !snap.Healthy) {
			alerts = append(alerts, alert{u.UserID, "P1", "down", "container down or unreachable"})
			continue
		}
		if !ok || !snap.Healthy {
			continue
		}
		if !snap.ChannelConnected {
			alerts = append(alerts, alert{u.UserID, "P1", "channel_disconnected", "message channel offline"})
		}
		if snap.MemMiB > memAlertMiB {
			alerts = append(alerts, alert{u.UserID, "P2", "high_mem", "memory near the 2GiB limit"})
		}
		if !snap.LastActiveAt.IsZero() {
			if reapWindow-time.Since(snap.LastActiveAt) < nearReapWindow {
				alerts = append(alerts, alert{u.UserID, "P3", "near_reap", "approaching idle reap window"})
			}
		}
	}
	writeJSON(w, http.StatusOK, alerts)
}

func parseRFC3339(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

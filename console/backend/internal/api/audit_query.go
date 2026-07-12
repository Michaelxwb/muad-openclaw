package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
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
	offset, limit := parsePagination(r)
	entries, total, err := s.store.QueryAuditFiltered(repo.AuditFilter{
		Actor: q.Get("actor"), Action: q.Get("action"), Target: q.Get("target"),
		PodID: q.Get("podId"), HumanUserID: q.Get("humanUserId"),
		IdentityID: q.Get("identityId"), BindingCodeID: q.Get("bindingCodeId"),
		From: parseRFC3339(q.Get("from")), To: parseRFC3339(q.Get("to")),
		Offset: offset, Limit: limit,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "query audit")
		return
	}
	items := make([]auditItem, 0, len(entries))
	for _, entry := range entries {
		items = append(items, makeAuditItem(entry))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

type auditItem struct {
	ID         int64             `json:"id"`
	Actor      string            `json:"actor"`
	Action     string            `json:"action"`
	Target     string            `json:"target"`
	TargetType string            `json:"targetType"`
	Payload    string            `json:"payload"`
	Metadata   auditlog.Metadata `json:"metadata"`
	TS         time.Time         `json:"ts"`
}

func makeAuditItem(entry repo.AuditEntry) auditItem {
	metadata, payload := safeAuditPayload(entry.Payload)
	return auditItem{
		ID: entry.ID, Actor: entry.Actor, Action: entry.Action,
		Target: entry.Target, TargetType: auditTargetType(entry.Action, metadata),
		Payload: payload, Metadata: metadata, TS: entry.TS,
	}
}

func safeAuditPayload(payload string) (auditlog.Metadata, string) {
	var metadata auditlog.Metadata
	if json.Unmarshal([]byte(payload), &metadata) == nil && strings.HasPrefix(strings.TrimSpace(payload), "{") {
		encoded, err := json.Marshal(metadata)
		if err == nil {
			return metadata, string(encoded)
		}
	}
	if payload == "ok" || payload == "failed" {
		return metadata, payload
	}
	return metadata, "[redacted]"
}

func auditTargetType(action string, metadata auditlog.Metadata) string {
	switch {
	case metadata.IdentityID != "" || strings.HasPrefix(action, "identity."):
		return "identity"
	case metadata.BindingCodeID != "" || strings.HasPrefix(action, "binding_code."):
		return "binding_code"
	case metadata.HumanUserID != "" || strings.HasPrefix(action, "human_user."):
		return "human_user"
	case metadata.PodID != "" || strings.HasPrefix(action, "pod") || strings.HasPrefix(action, "runtime_guard."):
		return "pod"
	case strings.HasPrefix(action, "platform_config."):
		return "platform"
	default:
		return "generic"
	}
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
	PodID   string         `json:"podId"`
	Level   string         `json:"level"` // P1 / P2 / P3
	Kind    string         `json:"kind"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

const (
	idleReapWindow = 10 * 24 * time.Hour
	nearReapWindow = 24 * time.Hour
)

const (
	auditFailureWindow       = 5 * time.Minute
	resolverFailureThreshold = 3
	bindingFailureThreshold  = 5
	guardRejectThreshold     = 3
)

// handleAlerts evaluates current alert conditions from the monitor cache
// (API, FEAT-13). Markers only; external notification channels are out of scope.
func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request) {
	pods, _, err := s.store.ListPods(repo.PodListFilter{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Pods")
		return
	}
	counts, err := s.store.CountAuditActionsSince([]string{
		string(auditlog.ActionSessionResolveFail), string(auditlog.ActionBindingCodeFail),
		string(auditlog.ActionRuntimeGuardReject),
	}, time.Now().Add(-auditFailureWindow))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "query runtime failure alerts")
		return
	}
	failures := indexAuditActionCounts(counts)
	alerts := make([]alert, 0, len(pods))
	for _, pod := range pods {
		snapshot, ok := s.cache.Get(pod.PodID)
		alerts = append(alerts, evaluatePodAlerts(pod.Pod, snapshot, ok, failures[pod.PodID])...)
	}
	sort.Slice(alerts, func(i, j int) bool {
		if alerts[i].PodID == alerts[j].PodID {
			return alerts[i].Kind < alerts[j].Kind
		}
		return alerts[i].PodID < alerts[j].PodID
	})
	writeJSON(w, http.StatusOK, alerts)
}

func evaluatePodAlerts(
	pod repo.Pod, snapshot monitor.Snapshot, present bool, failures map[string]int,
) []alert {
	if pod.State == repo.PodStateStopped || pod.State == repo.PodStateDeleting {
		return nil
	}
	alerts := configAlerts(pod)
	alerts = append(alerts, failureAlerts(pod.PodID, failures)...)
	if !present || !snapshot.Healthy {
		return append(alerts, alert{PodID: pod.PodID, Level: "P1", Kind: "down", Message: "Pod down or unreachable"})
	}
	return append(alerts, runtimeAlerts(pod, snapshot)...)
}

func configAlerts(pod repo.Pod) []alert {
	alerts := make([]alert, 0, 2)
	lag := max(int64(0), pod.ConfigGeneration-pod.AppliedGeneration)
	if lag > 0 {
		alerts = append(alerts, alert{
			PodID: pod.PodID, Level: "P2", Kind: "generation_lag",
			Message: "runtime configuration has not converged",
			Details: map[string]any{"generation": pod.ConfigGeneration, "appliedGeneration": pod.AppliedGeneration, "lag": lag},
		})
	}
	if pod.LastApplyStatus == repo.ApplyStatusFailed {
		alerts = append(alerts, alert{
			PodID: pod.PodID, Level: "P1", Kind: "config_apply_failed",
			Message: "runtime configuration apply failed",
			Details: map[string]any{"error": auditlog.RedactDiagnostic(pod.LastApplyError), "generation": pod.ConfigGeneration},
		})
	}
	return alerts
}

func runtimeAlerts(pod repo.Pod, snapshot monitor.Snapshot) []alert {
	alerts := make([]alert, 0, 7)
	if !snapshot.ChannelConnected {
		alerts = append(alerts, alert{PodID: pod.PodID, Level: "P1", Kind: "channel_disconnected", Message: "message channel offline"})
	}
	if !snapshot.RuntimeGuardHealthy {
		alerts = append(alerts, alert{PodID: pod.PodID, Level: "P1", Kind: "runtime_guard_unhealthy", Message: "Runtime Guard health check failed"})
	}
	if pod.AppliedGeneration > 0 && snapshot.RuntimeGeneration != pod.AppliedGeneration {
		alerts = append(alerts, alert{
			PodID: pod.PodID, Level: "P1", Kind: "runtime_generation_mismatch",
			Message: "runtime reports a different applied generation",
			Details: map[string]any{"runtimeGeneration": snapshot.RuntimeGeneration, "appliedGeneration": pod.AppliedGeneration},
		})
	}
	if snapshot.MemAlertThresholdMiB > 0 && snapshot.MemMiB > snapshot.MemAlertThresholdMiB {
		alerts = append(alerts, alert{PodID: pod.PodID, Level: "P2", Kind: "high_mem", Message: "memory near the effective Pod limit"})
	}
	alerts = append(alerts, queueAlerts(pod.PodID, snapshot)...)
	return append(alerts, nearReapAlert(pod.PodID, snapshot)...)
}

func queueAlerts(podID string, snapshot monitor.Snapshot) []alert {
	alerts := make([]alert, 0, 2)
	if snapshot.SkillQueued > 0 {
		alerts = append(alerts, alert{
			PodID: podID, Level: "P2", Kind: "skill_queue", Message: "Skill executions are waiting for capacity",
			Details: map[string]any{"active": snapshot.SkillActive, "queued": snapshot.SkillQueued, "limit": snapshot.MaxSkillConcurrency},
		})
	}
	if snapshot.BrowserQueued > 0 {
		alerts = append(alerts, alert{
			PodID: podID, Level: "P2", Kind: "browser_queue", Message: "Browser calls are waiting for capacity",
			Details: map[string]any{"active": snapshot.BrowserActive, "queued": snapshot.BrowserQueued, "limit": snapshot.MaxBrowserConcurrency},
		})
	}
	return alerts
}

func nearReapAlert(podID string, snapshot monitor.Snapshot) []alert {
	if snapshot.LastMessageAt.IsZero() {
		return nil
	}
	remaining := idleReapWindow - time.Since(snapshot.LastMessageAt)
	if remaining <= 0 || remaining >= nearReapWindow {
		return nil
	}
	return []alert{{PodID: podID, Level: "P3", Kind: "near_reap", Message: "approaching idle reap window"}}
}

func indexAuditActionCounts(counts []repo.AuditActionCount) map[string]map[string]int {
	indexed := make(map[string]map[string]int)
	for _, count := range counts {
		if indexed[count.PodID] == nil {
			indexed[count.PodID] = map[string]int{}
		}
		indexed[count.PodID][count.Action] = count.Count
	}
	return indexed
}

func failureAlerts(podID string, counts map[string]int) []alert {
	definitions := []struct {
		action string
		limit  int
		kind   string
		text   string
	}{
		{string(auditlog.ActionSessionResolveFail), resolverFailureThreshold, "resolver_failures", "credential Resolver failures exceeded threshold"},
		{string(auditlog.ActionBindingCodeFail), bindingFailureThreshold, "binding_failures", "binding failures exceeded threshold"},
		{string(auditlog.ActionRuntimeGuardReject), guardRejectThreshold, "runtime_guard_rejections", "Runtime Guard rejections exceeded threshold"},
	}
	alerts := make([]alert, 0, len(definitions))
	for _, definition := range definitions {
		if count := counts[definition.action]; count >= definition.limit {
			alerts = append(alerts, alert{
				PodID: podID, Level: "P2", Kind: definition.kind, Message: definition.text,
				Details: map[string]any{"count": count, "windowSeconds": int(auditFailureWindow.Seconds())},
			})
		}
	}
	return alerts
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

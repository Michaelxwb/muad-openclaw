package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type longTaskView struct {
	TaskID                  string     `json:"taskId"`
	PodID                   string     `json:"podId"`
	HumanUserID             string     `json:"humanUserId"`
	PoolKey                 string     `json:"poolKey"`
	PoolQueued              int        `json:"poolQueued"`
	PoolRunning             int        `json:"poolRunning"`
	PoolLimit               int        `json:"poolLimit"`
	AgentID                 string     `json:"agentId"`
	PeerID                  string     `json:"peerId"`
	SkillName               string     `json:"skillName"`
	SkillRoot               string     `json:"skillRoot"`
	Status                  string     `json:"status"`
	StateRevision           int64      `json:"stateRevision"`
	CancelRequestedAt       *time.Time `json:"cancelRequestedAt,omitempty"`
	CancelRequestedBy       string     `json:"cancelRequestedBy,omitempty"`
	CancelledAt             *time.Time `json:"cancelledAt,omitempty"`
	CanCancel               bool       `json:"canCancel"`
	CancelUnavailableReason string     `json:"cancelUnavailableReason,omitempty"`
	SubmittedAt             time.Time  `json:"submittedAt"`
	StartedAt               *time.Time `json:"startedAt,omitempty"`
	EndedAt                 *time.Time `json:"endedAt,omitempty"`
	TerminalReason          string     `json:"terminalReason"`
	ErrorCode               string     `json:"errorCode"`
	UpdatedAt               time.Time  `json:"updatedAt"`
	LastSeenAt              time.Time  `json:"lastSeenAt"`
}

type longTaskPoolView struct {
	PodID       string    `json:"podId"`
	HumanUserID string    `json:"humanUserId"`
	PoolKey     string    `json:"poolKey"`
	PoolQueued  int       `json:"poolQueued"`
	PoolRunning int       `json:"poolRunning"`
	PoolLimit   int       `json:"poolLimit"`
	AgentID     string    `json:"agentId"`
	PeerID      string    `json:"peerId"`
	UpdatedAt   time.Time `json:"updatedAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

func (s *Server) handleListLongTasks(w http.ResponseWriter, r *http.Request) {
	filter, page, pageSize, ok := longTaskFilterFromRequest(w, r)
	if !ok {
		return
	}
	tasks, total, err := s.store.ListLongTaskTasks(filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListLongTasks)
		return
	}
	pools, err := s.store.ListLongTaskPools(filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListLongTasks)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": s.longTaskViews(tasks), "pools": longTaskPoolViews(pools),
		"total": total, "page": page, "pageSize": pageSize,
	})
}

func longTaskFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.LongTaskListFilter, int, int, bool) {
	page, pageSize := parsePodPagination(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validLongTaskStatus(status) {
		writeErr(w, r, errcode.InvalidLongTaskStatus)
		return repo.LongTaskListFilter{}, 0, 0, false
	}
	return repo.LongTaskListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize,
		Query: strings.TrimSpace(r.URL.Query().Get("q")), Status: status,
		PodID:       strings.TrimSpace(r.URL.Query().Get("podId")),
		HumanUserID: strings.TrimSpace(r.URL.Query().Get("humanUserId")),
		AgentID:     strings.TrimSpace(r.URL.Query().Get("agentId")),
		SkillName:   strings.TrimSpace(r.URL.Query().Get("skillName")),
		PoolKey:     strings.TrimSpace(r.URL.Query().Get("poolKey")),
	}, page, pageSize, true
}

func validLongTaskStatus(status string) bool {
	switch status {
	case repo.LongTaskQueued, repo.LongTaskRunning, repo.LongTaskCancelling, repo.LongTaskCancelled,
		repo.LongTaskSucceeded, repo.LongTaskFailed:
		return true
	default:
		return false
	}
}

func (s *Server) longTaskViews(tasks []repo.LongTaskTask) []longTaskView {
	views := make([]longTaskView, 0, len(tasks))
	for _, task := range tasks {
		views = append(views, s.longTaskToView(task))
	}
	return views
}

// longTaskCanCancel 依据任务状态与 Pod 能力缓存判定，未知能力一律不可取消
// （不推断 canCancel=true），原因稳定可展示。
func (s *Server) longTaskCanCancel(task repo.LongTaskTask) (bool, string) {
	switch task.Status {
	case repo.LongTaskQueued, repo.LongTaskRunning:
	default:
		return false, "task_not_cancellable"
	}
	capability, known := s.longTaskCapabilities.Lookup(task.PodID)
	if !known {
		return false, "capability_unknown"
	}
	if !capability.Available {
		return false, "worker_unsupported"
	}
	return true, ""
}

func longTaskPoolViews(pools []repo.LongTaskPool) []longTaskPoolView {
	views := make([]longTaskPoolView, 0, len(pools))
	for _, pool := range pools {
		views = append(views, longTaskPoolToView(pool))
	}
	return views
}

func longTaskPoolToView(pool repo.LongTaskPool) longTaskPoolView {
	return longTaskPoolView{
		PodID: pool.PodID, HumanUserID: pool.HumanUserID, PoolKey: pool.PoolKey,
		PoolQueued: pool.PoolQueued, PoolRunning: pool.PoolRunning, PoolLimit: pool.PoolLimit,
		AgentID: pool.AgentID, PeerID: pool.PeerID, UpdatedAt: pool.UpdatedAt,
		LastSeenAt: pool.LastSeenAt,
	}
}

func (s *Server) longTaskToView(task repo.LongTaskTask) longTaskView {
	canCancel, reason := s.longTaskCanCancel(task)
	return longTaskView{
		TaskID: task.TaskID, PodID: task.PodID, HumanUserID: task.HumanUserID,
		PoolKey: task.PoolKey, PoolQueued: task.PoolQueued, PoolRunning: task.PoolRunning,
		PoolLimit: task.PoolLimit, AgentID: task.AgentID, PeerID: task.PeerID,
		SkillName: task.SkillName, SkillRoot: task.SkillRoot, Status: task.Status,
		StateRevision:           int64(task.StateRevision),
		CancelRequestedAt:       optionalLongTaskTime(task.CancelRequestedAt),
		CancelRequestedBy:       task.CancelRequestedBy,
		CancelledAt:             optionalLongTaskTime(task.CancelledAt),
		CanCancel:               canCancel,
		CancelUnavailableReason: reason,
		SubmittedAt:             task.SubmittedAt, StartedAt: optionalLongTaskTime(task.StartedAt),
		EndedAt:        optionalLongTaskTime(task.EndedAt),
		TerminalReason: task.TerminalReason, ErrorCode: task.ErrorCode,
		UpdatedAt: task.UpdatedAt, LastSeenAt: task.LastSeenAt,
	}
}

func optionalLongTaskTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

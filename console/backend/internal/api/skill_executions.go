package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type skillExecutionUpsertRequest struct {
	ExecutionID string    `json:"executionId"`
	AgentID     string    `json:"agentId"`
	SkillName   string    `json:"skillName"`
	SkillScope  string    `json:"skillScope"`
	StartedAt   time.Time `json:"startedAt"`
}

type skillExecutionView struct {
	ExecutionID string    `json:"executionId"`
	PodID       string    `json:"podId"`
	HumanUserID string    `json:"humanUserId"`
	AgentID     string    `json:"agentId"`
	SkillName   string    `json:"skillName"`
	SkillScope  string    `json:"skillScope"`
	StartedAt   time.Time `json:"startedAt"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (s *Server) handleUpsertSkillExecution(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, r, errcode.UnauthorizedPodToken)
		return
	}
	var request skillExecutionUpsertRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	record, err := s.skillExecutionRecordFromRequest(pod, request)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	conflict, err := s.skillExecutionConflict(record)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	if conflict {
		// INSERT OR IGNORE would return the pre-existing row owned by another
		// Pod; reject instead of leaking a cross-Pod execution record.
		writeErrDetail(w, r, errcode.ConflictExists,
			"该 executionId 已属于其他 Pod 的 Agent")
		return
	}
	stored, err := s.store.UpsertSkillExecutionRecord(record)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, skillExecutionToView(stored))
}

// skillExecutionConflict reports whether executionID already exists but belongs
// to a different Pod/user than the authenticated one.
func (s *Server) skillExecutionConflict(record repo.SkillExecutionRecord) (bool, error) {
	existing, err := s.store.GetSkillExecutionRecord(record.ExecutionID)
	if errors.Is(err, repo.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return existing.PodID != record.PodID || existing.HumanUserID != record.HumanUserID, nil
}

func (s *Server) skillExecutionRecordFromRequest(
	pod repo.Pod, request skillExecutionUpsertRequest,
) (repo.SkillExecutionRecord, error) {
	user, err := s.store.GetHumanUserByAgent(pod.PodID, strings.TrimSpace(request.AgentID))
	if err != nil {
		return repo.SkillExecutionRecord{}, err
	}
	if user.Status != repo.HumanUserStatusActive && user.Status != repo.HumanUserStatusPending {
		return repo.SkillExecutionRecord{}, repo.ErrNotFound
	}
	return repo.SkillExecutionRecord{
		ExecutionID: request.ExecutionID, PodID: pod.PodID, HumanUserID: user.HumanUserID,
		AgentID: user.AgentID, SkillName: request.SkillName, SkillScope: request.SkillScope,
		StartedAt: request.StartedAt,
	}, nil
}

func (s *Server) handleGetSkillExecution(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.GetSkillExecutionRecord(strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, skillExecutionToView(record))
}

func (s *Server) handleListSkillExecutions(w http.ResponseWriter, r *http.Request) {
	filter, page, pageSize, ok := skillExecutionFilterFromRequest(w, r)
	if !ok {
		return
	}
	records, total, err := s.store.ListSkillExecutionRecords(filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListSkillExecutions)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": skillExecutionViews(records), "total": total, "page": page, "pageSize": pageSize,
	})
}

func skillExecutionFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.SkillExecutionListFilter, int, int, bool) {
	page, pageSize, ok := skillExecutionPagination(w, r)
	if !ok {
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	from, to, ok := skillExecutionTimeRange(w, r)
	if !ok {
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	if !validOptionalSkillExecutionScope(scope) {
		writeErr(w, r, errcode.InvalidSkillExecutionFilter)
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	return repo.SkillExecutionListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize,
		Query:       strings.TrimSpace(r.URL.Query().Get("q")),
		PodID:       strings.TrimSpace(r.URL.Query().Get("podId")),
		HumanUserID: strings.TrimSpace(r.URL.Query().Get("humanUserId")),
		AgentID:     strings.TrimSpace(r.URL.Query().Get("agentId")),
		SkillName:   strings.TrimSpace(r.URL.Query().Get("skillName")),
		SkillScope:  scope, From: from, To: to,
	}, page, pageSize, true
}

func skillExecutionPagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	page, pageSize := parsePodPagination(r)
	raw := strings.TrimSpace(r.URL.Query().Get("pageSize"))
	if raw == "" {
		return page, defaultPodPageSize, true
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || !validSkillExecutionPageSize(parsed) {
		writeErr(w, r, errcode.InvalidPageSize)
		return 0, 0, false
	}
	return page, pageSize, true
}

func validSkillExecutionPageSize(size int) bool {
	return size == 10 || size == 20 || size == 50 || size == 100
}

func skillExecutionTimeRange(w http.ResponseWriter, r *http.Request) (time.Time, time.Time, bool) {
	from, err := parseOptionalExecutionTime(r.URL.Query().Get("startedFrom"))
	if err != nil {
		writeErr(w, r, errcode.InvalidStartTime)
		return time.Time{}, time.Time{}, false
	}
	to, err := parseOptionalExecutionTime(r.URL.Query().Get("startedTo"))
	if err != nil || (!from.IsZero() && !to.IsZero() && from.After(to)) {
		writeErr(w, r, errcode.InvalidEndTime)
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

func parseOptionalExecutionTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339, value)
}

func validOptionalSkillExecutionScope(scope string) bool {
	return scope == "" || scope == repo.SkillScopeSystem ||
		scope == repo.SkillScopePublic || scope == repo.SkillScopePrivate
}

func skillExecutionViews(records []repo.SkillExecutionRecord) []skillExecutionView {
	views := make([]skillExecutionView, 0, len(records))
	for _, record := range records {
		views = append(views, skillExecutionToView(record))
	}
	return views
}

func skillExecutionToView(record repo.SkillExecutionRecord) skillExecutionView {
	return skillExecutionView{
		ExecutionID: record.ExecutionID, PodID: record.PodID, HumanUserID: record.HumanUserID,
		AgentID: record.AgentID, SkillName: record.SkillName, SkillScope: record.SkillScope,
		StartedAt: record.StartedAt, CreatedAt: record.CreatedAt,
	}
}

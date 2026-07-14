package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	maxSkillSummaryBytes = 512
	maxSkillProgressText = 256
	maxSkillProgressRows = 20
)

type skillExecutionUpsertRequest struct {
	ExecutionID   string              `json:"executionId"`
	AgentID       string              `json:"agentId"`
	SkillName     string              `json:"skillName"`
	SkillScope    string              `json:"skillScope"`
	SkillVersion  string              `json:"skillVersion"`
	Status        string              `json:"status"`
	StartedAt     time.Time           `json:"startedAt"`
	EndedAt       time.Time           `json:"endedAt"`
	DurationMS    int64               `json:"durationMs"`
	Progress      []skillProgressItem `json:"progress"`
	ErrorCode     string              `json:"errorCode"`
	ErrorMessage  string              `json:"errorMessage"`
	InputSummary  string              `json:"inputSummary"`
	OutputSummary string              `json:"outputSummary"`
}

type skillProgressItem struct {
	Type  string `json:"type,omitempty"`
	Stage string `json:"stage,omitempty"`
	Text  string `json:"text,omitempty"`
	TS    string `json:"ts,omitempty"`
}

type skillExecutionView struct {
	ExecutionID   string    `json:"executionId"`
	PodID         string    `json:"podId"`
	HumanUserID   string    `json:"humanUserId"`
	AgentID       string    `json:"agentId"`
	SkillName     string    `json:"skillName"`
	SkillScope    string    `json:"skillScope"`
	SkillVersion  string    `json:"skillVersion"`
	Status        string    `json:"status"`
	StartedAt     time.Time `json:"startedAt"`
	EndedAt       time.Time `json:"endedAt,omitempty"`
	DurationMS    int64     `json:"durationMs"`
	ProgressJSON  string    `json:"progressJson"`
	ErrorCode     string    `json:"errorCode,omitempty"`
	ErrorMessage  string    `json:"errorMessage,omitempty"`
	InputSummary  string    `json:"inputSummary,omitempty"`
	OutputSummary string    `json:"outputSummary,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

func (s *Server) handleUpsertSkillExecution(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, codePodUnauthorized, "invalid Pod service token")
		return
	}
	var request skillExecutionUpsertRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	record, err := s.skillExecutionRecordFromRequest(pod, request)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	stored, err := s.store.UpsertSkillExecutionRecord(record)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if stored.Status == repo.SkillExecutionFailed {
		s.auditSkillExecutionFail(r, stored)
	}
	writeJSON(w, http.StatusOK, skillExecutionToView(stored))
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
	progressJSON, err := marshalSkillProgress(request.Progress)
	if err != nil {
		return repo.SkillExecutionRecord{}, repo.ErrInvalidSkill
	}
	return repo.SkillExecutionRecord{
		ExecutionID: request.ExecutionID, PodID: pod.PodID, HumanUserID: user.HumanUserID,
		AgentID: user.AgentID, SkillName: request.SkillName, SkillScope: request.SkillScope,
		SkillVersion: request.SkillVersion, Status: request.Status, StartedAt: request.StartedAt,
		EndedAt: request.EndedAt, DurationMS: request.DurationMS, ProgressJSON: progressJSON,
		ErrorCode:     trimRunText(request.ErrorCode, 128),
		ErrorMessage:  trimRunText(request.ErrorMessage, maxSkillSummaryBytes),
		InputSummary:  trimRunText(request.InputSummary, maxSkillSummaryBytes),
		OutputSummary: trimRunText(request.OutputSummary, maxSkillSummaryBytes),
	}, nil
}

func (s *Server) handleListSkillExecutions(w http.ResponseWriter, r *http.Request) {
	filter, page, pageSize, ok := skillExecutionFilterFromRequest(w, r)
	if !ok {
		return
	}
	records, total, err := s.store.ListSkillExecutionRecords(filter)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Skill executions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": skillExecutionViews(records), "total": total, "page": page, "pageSize": pageSize,
	})
}

func skillExecutionFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.SkillExecutionListFilter, int, int, bool) {
	page, pageSize := parsePodPagination(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validSkillExecutionStatus(status) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Skill execution status")
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	return repo.SkillExecutionListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize,
		PodID:       strings.TrimSpace(r.URL.Query().Get("podId")),
		HumanUserID: strings.TrimSpace(r.URL.Query().Get("humanUserId")),
		AgentID:     strings.TrimSpace(r.URL.Query().Get("agentId")),
		SkillName:   strings.TrimSpace(r.URL.Query().Get("skillName")),
		Status:      status,
	}, page, pageSize, true
}

func validSkillExecutionStatus(status string) bool {
	switch status {
	case repo.SkillExecutionRunning, repo.SkillExecutionSucceeded,
		repo.SkillExecutionFailed, repo.SkillExecutionCancelled:
		return true
	default:
		return false
	}
}

func marshalSkillProgress(input []skillProgressItem) (string, error) {
	if len(input) > maxSkillProgressRows {
		input = input[len(input)-maxSkillProgressRows:]
	}
	output := make([]skillProgressItem, 0, len(input))
	for _, item := range input {
		output = append(output, skillProgressItem{
			Type: trimRunText(item.Type, 32), Stage: trimRunText(item.Stage, 80),
			Text: trimRunText(item.Text, maxSkillProgressText), TS: trimRunText(item.TS, 64),
		})
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func trimRunText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
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
		SkillVersion: record.SkillVersion, Status: record.Status, StartedAt: record.StartedAt,
		EndedAt: record.EndedAt, DurationMS: record.DurationMS, ProgressJSON: record.ProgressJSON,
		ErrorCode: record.ErrorCode, ErrorMessage: record.ErrorMessage,
		InputSummary: record.InputSummary, OutputSummary: record.OutputSummary,
		CreatedAt: record.CreatedAt,
	}
}

func (s *Server) auditSkillExecutionFail(r *http.Request, record repo.SkillExecutionRecord) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.PodActor(record.PodID), Action: auditlog.ActionSkillExecutionFail,
		Target: record.ExecutionID,
		Metadata: auditlog.Metadata{
			PodID: record.PodID, HumanUserID: record.HumanUserID, AgentID: record.AgentID,
			SkillName: record.SkillName, Status: record.Status, ErrorCode: record.ErrorCode,
		},
	})
	if err != nil {
		log.Printf("skill_execution_audit_failed execution=%s error=%v", record.ExecutionID, err)
	}
}

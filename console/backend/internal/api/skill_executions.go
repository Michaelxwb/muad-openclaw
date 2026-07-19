package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	maxSkillSummaryBytes = 512
	maxSkillProgressText = 256
	maxSkillProgressRows = 20
)

var (
	runSecretPairPattern = regexp.MustCompile(`(?i)\b(api[_-]?key|token|cookie|authorization|secret|password)\s*[:=]\s*[^\s,;]+`)
	runBearerPattern     = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`)
)

type skillExecutionUpsertRequest struct {
	ExecutionID    string              `json:"executionId"`
	AgentID        string              `json:"agentId"`
	SkillName      string              `json:"skillName"`
	SkillScope     string              `json:"skillScope"`
	SkillVersion   string              `json:"skillVersion"`
	EntryType      string              `json:"entryType"`
	ActivationMode string              `json:"activationMode"`
	EventSeq       int64               `json:"eventSeq"`
	Status         string              `json:"status"`
	StartedAt      time.Time           `json:"startedAt"`
	EndedAt        time.Time           `json:"endedAt"`
	DurationMS     int64               `json:"durationMs"`
	Progress       []skillProgressItem `json:"progress"`
	LastToolName   string              `json:"lastToolName"`
	TerminalReason string              `json:"terminalReason"`
	ErrorCode      string              `json:"errorCode"`
	ErrorMessage   string              `json:"errorMessage"`
	InputSummary   string              `json:"inputSummary"`
	OutputSummary  string              `json:"outputSummary"`
}

type skillProgressItem struct {
	Type  string `json:"type,omitempty"`
	Stage string `json:"stage,omitempty"`
	Text  string `json:"text,omitempty"`
	TS    string `json:"ts,omitempty"`
}

type skillExecutionView struct {
	ExecutionID    string    `json:"executionId"`
	PodID          string    `json:"podId"`
	HumanUserID    string    `json:"humanUserId"`
	AgentID        string    `json:"agentId"`
	SkillName      string    `json:"skillName"`
	SkillScope     string    `json:"skillScope"`
	SkillVersion   string    `json:"skillVersion"`
	EntryType      string    `json:"entryType"`
	ActivationMode string    `json:"activationMode"`
	EventSeq       int64     `json:"eventSeq"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"startedAt"`
	EndedAt        time.Time `json:"endedAt,omitempty"`
	DurationMS     int64     `json:"durationMs"`
	LastToolName   string    `json:"lastToolName,omitempty"`
	TerminalReason string    `json:"terminalReason,omitempty"`
	ErrorCode      string    `json:"errorCode,omitempty"`
	ErrorMessage   string    `json:"errorMessage,omitempty"`
	InputSummary   string    `json:"inputSummary,omitempty"`
	OutputSummary  string    `json:"outputSummary,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
}

type skillExecutionDetailView struct {
	skillExecutionView
	ProgressJSON string `json:"progressJson"`
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
	writeJSON(w, http.StatusOK, skillExecutionDetail(stored))
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
		SkillVersion: request.SkillVersion, EntryType: request.EntryType,
		ActivationMode: request.ActivationMode, EventSeq: request.EventSeq,
		Status: request.Status, StartedAt: request.StartedAt,
		EndedAt: request.EndedAt, DurationMS: request.DurationMS, ProgressJSON: progressJSON,
		LastToolName:   sanitizeRunText(request.LastToolName, 128),
		TerminalReason: sanitizeRunText(request.TerminalReason, 128),
		ErrorCode:      sanitizeRunText(request.ErrorCode, 128),
		ErrorMessage:   sanitizeRunText(request.ErrorMessage, maxSkillSummaryBytes),
		InputSummary:   sanitizeRunText(request.InputSummary, maxSkillSummaryBytes),
		OutputSummary:  sanitizeRunText(request.OutputSummary, maxSkillSummaryBytes),
	}, nil
}

func (s *Server) handleGetSkillExecution(w http.ResponseWriter, r *http.Request) {
	record, err := s.store.GetSkillExecutionRecord(strings.TrimSpace(r.PathValue("executionId")))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, skillExecutionDetail(record))
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
	page, pageSize, ok := skillExecutionPagination(w, r)
	if !ok {
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validSkillExecutionStatus(status) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Skill execution status")
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	from, to, ok := skillExecutionTimeRange(w, r)
	if !ok {
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	entryType := strings.TrimSpace(r.URL.Query().Get("entryType"))
	if !validOptionalSkillExecutionClass(scope, entryType) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Skill execution filter")
		return repo.SkillExecutionListFilter{}, 0, 0, false
	}
	return repo.SkillExecutionListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize,
		Query:       strings.TrimSpace(r.URL.Query().Get("q")),
		PodID:       strings.TrimSpace(r.URL.Query().Get("podId")),
		HumanUserID: strings.TrimSpace(r.URL.Query().Get("humanUserId")),
		AgentID:     strings.TrimSpace(r.URL.Query().Get("agentId")),
		SkillName:   strings.TrimSpace(r.URL.Query().Get("skillName")),
		SkillScope:  scope, EntryType: entryType, Status: status, From: from, To: to,
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
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid page size")
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
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid start time")
		return time.Time{}, time.Time{}, false
	}
	to, err := parseOptionalExecutionTime(r.URL.Query().Get("startedTo"))
	if err != nil || (!from.IsZero() && !to.IsZero() && from.After(to)) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid end time")
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

func validSkillExecutionStatus(status string) bool {
	switch status {
	case repo.SkillExecutionRunning, repo.SkillExecutionSucceeded,
		repo.SkillExecutionFailed, repo.SkillExecutionCancelled, repo.SkillExecutionRejected:
		return true
	default:
		return false
	}
}

func validOptionalSkillExecutionClass(scope, entryType string) bool {
	validScope := scope == "" || scope == repo.SkillScopeSystem ||
		scope == repo.SkillScopePublic || scope == repo.SkillScopePrivate
	validEntry := entryType == "" || entryType == repo.SkillEntryManaged ||
		entryType == repo.SkillEntryTraditionalScript || entryType == repo.SkillEntryTraditionalPrompt
	return validScope && validEntry
}

func marshalSkillProgress(input []skillProgressItem) (string, error) {
	if len(input) > maxSkillProgressRows {
		input = input[len(input)-maxSkillProgressRows:]
	}
	output := make([]skillProgressItem, 0, len(input))
	for _, item := range input {
		output = append(output, skillProgressItem{
			Type: sanitizeRunText(item.Type, 32), Stage: sanitizeRunText(item.Stage, 80),
			Text: sanitizeRunText(item.Text, maxSkillProgressText), TS: sanitizeRunText(item.TS, 64),
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
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func sanitizeRunText(value string, limit int) string {
	trimmed := trimRunText(value, limit)
	trimmed = runBearerPattern.ReplaceAllString(trimmed, "Bearer [REDACTED]")
	return runSecretPairPattern.ReplaceAllString(trimmed, "$1=[REDACTED]")
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
		SkillVersion: record.SkillVersion, EntryType: record.EntryType,
		ActivationMode: record.ActivationMode, EventSeq: record.EventSeq,
		Status: record.Status, StartedAt: record.StartedAt,
		EndedAt: record.EndedAt, DurationMS: record.DurationMS,
		LastToolName: record.LastToolName, TerminalReason: record.TerminalReason,
		ErrorCode: record.ErrorCode, ErrorMessage: record.ErrorMessage,
		InputSummary: record.InputSummary, OutputSummary: record.OutputSummary,
		CreatedAt: record.CreatedAt,
	}
}

func skillExecutionDetail(record repo.SkillExecutionRecord) skillExecutionDetailView {
	return skillExecutionDetailView{
		skillExecutionView: skillExecutionToView(record),
		ProgressJSON:       record.ProgressJSON,
	}
}

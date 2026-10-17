package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	skillTraceWriteTimeout   = 15 * time.Second
	skillTraceReadTimeout    = 5 * time.Second
	skillStatsReadTimeout    = 10 * time.Second
	maxSkillTraceBodyBytes   = 8 << 20
	maxSkillTraceDetailBytes = 2 << 10
)

// Skill health flag rule: aborted, request count >= min(max, limit x ratio), or
// error rate >= threshold. Keep the numeric thresholds in one place.
const (
	skillHealthDefaultWindow   = "7d"
	skillHealthDefaultLimit    = 50
	skillHealthMaxLimit        = 200
	skillHealthFlagMaxRequests = 200
	skillHealthFlagLimitRatio  = 0.2
	skillHealthFlagErrorRate   = 0.2
)

type skillTraceInterface struct {
	Host   string `json:"host"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Count  int    `json:"count"`
}

type skillTraceWriteRequest struct {
	AgentID string                    `json:"agentId"`
	Metrics *skillTraceMetricsRequest `json:"metrics"`
	Events  []skillTraceEventRequest  `json:"events"`
}

type skillTraceMetricsRequest struct {
	RequestCount    int                   `json:"requestCount"`
	ErrorCount      int                   `json:"errorCount"`
	DistinctHosts   int                   `json:"distinctHosts"`
	MaxBurstPer10s  int                   `json:"maxBurstPer10s"`
	TopInterfaces   []skillTraceInterface `json:"topInterfaces"`
	DetailTruncated bool                  `json:"detailTruncated"`
	Aborted         bool                  `json:"aborted"`
	AbortReason     string                `json:"abortReason"`
	AbortInterface  string                `json:"abortInterface"`
	AbortCount      *int                  `json:"abortCount"`
}

type skillTraceEventRequest struct {
	EventID    string    `json:"eventId"`
	Seq        int       `json:"seq"`
	OccurredAt time.Time `json:"occurredAt"`
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	DurationMS *int      `json:"durationMs"`
	Summary    string    `json:"summary"`
	Detail     string    `json:"detail"`
}

type skillTraceEventView struct {
	EventID    string    `json:"eventId"`
	Seq        int       `json:"seq"`
	OccurredAt time.Time `json:"occurredAt"`
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	DurationMS *int      `json:"durationMs,omitempty"`
	Summary    string    `json:"summary"`
	Detail     string    `json:"detail,omitempty"`
}

type skillExecutionMetricsView struct {
	RequestCount    int                   `json:"requestCount"`
	ErrorCount      int                   `json:"errorCount"`
	DistinctHosts   int                   `json:"distinctHosts"`
	MaxBurstPer10s  int                   `json:"maxBurstPer10s"`
	TopInterfaces   []skillTraceInterface `json:"topInterfaces"`
	DetailTruncated bool                  `json:"detailTruncated"`
	Aborted         bool                  `json:"aborted"`
	AbortReason     string                `json:"abortReason,omitempty"`
	AbortInterface  string                `json:"abortInterface,omitempty"`
	AbortCount      *int                  `json:"abortCount,omitempty"`
	UpdatedAt       time.Time             `json:"updatedAt"`
}

type skillExecutionTraceView struct {
	Metrics *skillExecutionMetricsView `json:"metrics"`
	Events  []skillTraceEventView      `json:"events"`
}

type skillExecutionStatView struct {
	SkillName       string                `json:"skillName"`
	SkillScope      string                `json:"skillScope"`
	HumanUserID     string                `json:"humanUserId"`
	HumanUserName   string                `json:"humanUserName"`
	Executions      int                   `json:"executions"`
	AbortedCount    int                   `json:"abortedCount"`
	FlaggedCount    int                   `json:"flaggedCount"`
	MaxRequests     int                   `json:"maxRequests"`
	ErrorRate       float64               `json:"errorRate"`
	TopInterfaces   []skillTraceInterface `json:"topInterfaces"`
	LastExecutionAt time.Time             `json:"lastExecutionAt"`
}

// handleSkillExecutionTrace ingests one execution's summary and event batch.
// The pod token authenticates the Pod; the execution record must belong to that
// Pod and to the reported agent.
func (s *Server) handleSkillExecutionTrace(w http.ResponseWriter, r *http.Request) {
	pod, ok := podFromContext(r.Context())
	if !ok {
		writeErr(w, r, errcode.UnauthorizedPodToken)
		return
	}
	var request skillTraceWriteRequest
	if err := decodeJSONBodyLimit(w, r, &request, maxSkillTraceBodyBytes); err != nil {
		writeErr(w, r, errcode.InvalidSkillTrace)
		return
	}
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	metrics, events, ok := skillTracePayload(w, r, request)
	if !ok {
		return
	}
	metrics.ExecutionID = executionID

	ctx, cancel := context.WithTimeout(r.Context(), skillTraceWriteTimeout)
	defer cancel()
	record, err := s.store.GetSkillExecutionRecordContext(ctx, executionID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	if record.PodID != pod.PodID || record.AgentID != strings.TrimSpace(request.AgentID) {
		writeErr(w, r, errcode.ConflictSkillTraceOwner)
		return
	}
	stored, err := s.store.StoreSkillExecutionTrace(ctx, executionID, metrics, events)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	storedMetrics, err := s.store.GetSkillExecutionMetrics(ctx, executionID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"storedEvents": stored, "aborted": storedMetrics.Aborted,
	})
}

// skillTracePayload validates the request envelope and converts it to repo
// models. It writes the error response itself and reports whether to continue.
func skillTracePayload(
	w http.ResponseWriter, r *http.Request, request skillTraceWriteRequest,
) (repo.SkillExecutionMetrics, []repo.SkillTraceEvent, bool) {
	if strings.TrimSpace(request.AgentID) == "" || request.Metrics == nil ||
		len(request.Events) > repo.MaxSkillTraceEvents {
		writeErr(w, r, errcode.InvalidSkillTrace)
		return repo.SkillExecutionMetrics{}, nil, false
	}
	topInterfaces, ok := skillTraceTopInterfaces(request.Metrics.TopInterfaces)
	if !ok {
		writeErr(w, r, errcode.InvalidSkillTrace)
		return repo.SkillExecutionMetrics{}, nil, false
	}
	encodedInterfaces, err := json.Marshal(topInterfaces)
	if err != nil {
		writeErr(w, r, errcode.InvalidSkillTrace)
		return repo.SkillExecutionMetrics{}, nil, false
	}
	metrics := repo.SkillExecutionMetrics{
		RequestCount:      request.Metrics.RequestCount,
		ErrorCount:        request.Metrics.ErrorCount,
		DistinctHosts:     request.Metrics.DistinctHosts,
		MaxBurstPer10s:    request.Metrics.MaxBurstPer10s,
		TopInterfacesJSON: string(encodedInterfaces),
		DetailTruncated:   request.Metrics.DetailTruncated,
		Aborted:           request.Metrics.Aborted,
		AbortReason:       request.Metrics.AbortReason,
		AbortInterface:    request.Metrics.AbortInterface,
		AbortCount:        request.Metrics.AbortCount,
	}
	events := make([]repo.SkillTraceEvent, 0, len(request.Events))
	for _, event := range request.Events {
		if !validSkillTraceEvent(event) {
			writeErr(w, r, errcode.InvalidSkillTrace)
			return repo.SkillExecutionMetrics{}, nil, false
		}
		events = append(events, repo.SkillTraceEvent{
			EventID: event.EventID, Seq: event.Seq, OccurredAt: event.OccurredAt,
			Kind: event.Kind, Status: event.Status, DurationMS: event.DurationMS,
			Summary: event.Summary, Detail: event.Detail,
		})
	}
	return metrics, events, true
}

func validSkillTraceEvent(event skillTraceEventRequest) bool {
	return (event.DurationMS == nil || *event.DurationMS >= 0) &&
		len(event.Detail) <= maxSkillTraceDetailBytes
}

func skillTraceTopInterfaces(interfaces []skillTraceInterface) ([]skillTraceInterface, bool) {
	result := make([]skillTraceInterface, 0, len(interfaces))
	for _, item := range interfaces {
		if item.Count < 0 {
			return nil, false
		}
		result = append(result, item)
	}
	return result, true
}

// handleGetSkillExecutionTrace returns one execution's timeline and summary.
func (s *Server) handleGetSkillExecutionTrace(w http.ResponseWriter, r *http.Request) {
	executionID := strings.TrimSpace(r.PathValue("executionId"))
	ctx, cancel := context.WithTimeout(r.Context(), skillTraceReadTimeout)
	defer cancel()
	if _, err := s.store.GetSkillExecutionRecordContext(ctx, executionID); err != nil {
		writeRepoError(w, r, err)
		return
	}
	events, err := s.store.ListSkillTraceEvents(ctx, executionID, repo.MaxSkillTraceEvents)
	if err != nil {
		writeErr(w, r, errcode.InternalListSkillExecutions)
		return
	}
	view := skillExecutionTraceView{Events: skillTraceEventViews(events)}
	metrics, err := s.store.GetSkillExecutionMetrics(ctx, executionID)
	if err == nil {
		metricsView := skillExecutionMetricsViewFromRepo(metrics)
		view.Metrics = &metricsView
	} else if !errors.Is(err, repo.ErrNotFound) {
		writeErr(w, r, errcode.InternalListSkillExecutions)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handleSkillExecutionStats returns Skill health grouped per
// (skillName, skillScope, humanUserId).
func (s *Server) handleSkillExecutionStats(w http.ResponseWriter, r *http.Request) {
	filter, ok := skillExecutionStatsFilter(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), skillStatsReadTimeout)
	defer cancel()
	requestLimit, err := s.store.GetSkillRequestLimit(ctx)
	if err != nil {
		writeErr(w, r, errcode.InternalReadResourceConfig)
		return
	}
	filter.FlagRequestThreshold = skillHealthFlagRequestThreshold(requestLimit)
	filter.FlagErrorRate = skillHealthFlagErrorRate
	stats, err := s.store.QuerySkillExecutionStats(ctx, filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListSkillExecutions)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": skillExecutionStatViews(stats)})
}

func skillExecutionStatsFilter(
	w http.ResponseWriter, r *http.Request,
) (repo.SkillExecutionStatsFilter, bool) {
	query := r.URL.Query()
	since, ok := skillHealthWindowSince(query.Get("window"))
	if !ok {
		writeErr(w, r, errcode.InvalidSkillExecutionFilter)
		return repo.SkillExecutionStatsFilter{}, false
	}
	limit, ok := skillHealthLimit(query.Get("limit"))
	if !ok {
		writeErr(w, r, errcode.InvalidSkillExecutionFilter)
		return repo.SkillExecutionStatsFilter{}, false
	}
	scope := strings.TrimSpace(query.Get("scope"))
	if !validOptionalSkillExecutionScope(scope) {
		writeErr(w, r, errcode.InvalidSkillExecutionFilter)
		return repo.SkillExecutionStatsFilter{}, false
	}
	return repo.SkillExecutionStatsFilter{
		Since: since, Limit: limit, Scope: scope,
		HumanUserID: strings.TrimSpace(query.Get("humanUserId")),
	}, true
}

func skillHealthWindowSince(raw string) (time.Time, bool) {
	var window time.Duration
	switch strings.TrimSpace(raw) {
	case "", skillHealthDefaultWindow:
		window = 7 * 24 * time.Hour
	case "24h":
		window = 24 * time.Hour
	case "30d":
		window = 30 * 24 * time.Hour
	default:
		return time.Time{}, false
	}
	return time.Now().UTC().Add(-window), true
}

func skillHealthLimit(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return skillHealthDefaultLimit, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || value > skillHealthMaxLimit {
		return 0, false
	}
	return value, true
}

func skillHealthFlagRequestThreshold(requestLimit int) int {
	if requestLimit <= 0 {
		return skillHealthFlagMaxRequests
	}
	threshold := int(float64(requestLimit) * skillHealthFlagLimitRatio)
	if threshold < 1 {
		threshold = 1
	}
	if threshold > skillHealthFlagMaxRequests {
		threshold = skillHealthFlagMaxRequests
	}
	return threshold
}

func skillTraceEventViews(events []repo.SkillTraceEvent) []skillTraceEventView {
	views := make([]skillTraceEventView, 0, len(events))
	for _, event := range events {
		views = append(views, skillTraceEventView{
			EventID: event.EventID, Seq: event.Seq, OccurredAt: event.OccurredAt,
			Kind: event.Kind, Status: event.Status, DurationMS: event.DurationMS,
			Summary: event.Summary, Detail: event.Detail,
		})
	}
	return views
}

func skillExecutionMetricsViewFromRepo(metrics repo.SkillExecutionMetrics) skillExecutionMetricsView {
	return skillExecutionMetricsView{
		RequestCount: metrics.RequestCount, ErrorCount: metrics.ErrorCount,
		DistinctHosts: metrics.DistinctHosts, MaxBurstPer10s: metrics.MaxBurstPer10s,
		TopInterfaces:   skillTraceTopInterfacesFromJSON(metrics.ExecutionID, metrics.TopInterfacesJSON),
		DetailTruncated: metrics.DetailTruncated, Aborted: metrics.Aborted,
		AbortReason: metrics.AbortReason, AbortInterface: metrics.AbortInterface,
		AbortCount: metrics.AbortCount, UpdatedAt: metrics.UpdatedAt,
	}
}

func skillTraceTopInterfacesFromJSON(source, raw string) []skillTraceInterface {
	interfaces := []skillTraceInterface{}
	if strings.TrimSpace(raw) == "" {
		return interfaces
	}
	if err := json.Unmarshal([]byte(raw), &interfaces); err != nil {
		log.Printf("skill_trace_top_interfaces_decode_failed source=%s error=%v", source, err)
		return []skillTraceInterface{}
	}
	return interfaces
}

func skillExecutionStatViews(stats []repo.SkillExecutionStat) []skillExecutionStatView {
	views := make([]skillExecutionStatView, 0, len(stats))
	for _, stat := range stats {
		errorRate := 0.0
		if stat.SumRequests > 0 {
			errorRate = float64(stat.SumErrors) / float64(stat.SumRequests)
		}
		views = append(views, skillExecutionStatView{
			SkillName: stat.SkillName, SkillScope: stat.SkillScope,
			HumanUserID: stat.HumanUserID, HumanUserName: stat.HumanUserName,
			Executions: stat.Executions, AbortedCount: stat.AbortedCount,
			FlaggedCount: stat.FlaggedCount, MaxRequests: stat.MaxRequests,
			ErrorRate:       errorRate,
			TopInterfaces:   skillTraceTopInterfacesFromJSON(stat.SkillName, stat.TopInterfacesJSON),
			LastExecutionAt: stat.LastExecutionAt,
		})
	}
	return views
}

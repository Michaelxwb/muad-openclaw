package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrInvalidSkillTrace rejects malformed trace payloads at the repo boundary.
var ErrInvalidSkillTrace = errors.New("repo: invalid Skill trace")

const skillTraceEventColumns = `event_id, execution_id, seq, occurred_at, kind,
	status, duration_ms, summary, COALESCE(detail, '')`

const skillExecutionMetricsColumns = `execution_id, request_count, error_count,
	distinct_hosts, max_burst_per_10s, top_interfaces_json, detail_truncated,
	aborted, COALESCE(abort_reason, ''), COALESCE(abort_interface, ''),
	abort_count, updated_at`

// InsertSkillTraceEvents inserts events for one execution idempotently by
// event_id. A retried batch stores only events that were not persisted yet and
// returns that count.
func (s *Store) InsertSkillTraceEvents(executionID string, events []SkillTraceEvent) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin Skill trace insert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stored := 0
	for _, event := range events {
		prepared, err := prepareSkillTraceEvent(executionID, event)
		if err != nil {
			return 0, err
		}
		result, err := tx.Exec(`INSERT INTO skill_trace_events (
			event_id, execution_id, seq, occurred_at, kind, status,
			duration_ms, summary, detail
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(event_id) DO NOTHING`,
			prepared.EventID, prepared.ExecutionID, prepared.Seq,
			formatTime(prepared.OccurredAt), prepared.Kind, prepared.Status,
			nullableInt(prepared.DurationMS), prepared.Summary,
			nullIfEmpty(prepared.Detail))
		if err != nil {
			return 0, fmt.Errorf("insert Skill trace event: %w", err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("count Skill trace insert: %w", err)
		}
		stored += int(affected)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit Skill trace insert: %w", err)
	}
	return stored, nil
}

func prepareSkillTraceEvent(executionID string, event SkillTraceEvent) (SkillTraceEvent, error) {
	event.ExecutionID = strings.TrimSpace(executionID)
	event.EventID = strings.TrimSpace(event.EventID)
	event.Kind = strings.TrimSpace(event.Kind)
	event.Status = strings.TrimSpace(event.Status)
	if event.ExecutionID == "" || event.EventID == "" || event.Seq <= 0 ||
		!validSkillTraceKind(event.Kind) || !validSkillTraceStatus(event.Status) {
		return SkillTraceEvent{}, ErrInvalidSkillTrace
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	return event, nil
}

func validSkillTraceKind(kind string) bool {
	switch kind {
	case SkillTraceKindExec, SkillTraceKindHTTP, SkillTraceKindOutput, SkillTraceKindAbort:
		return true
	default:
		return false
	}
}

func validSkillTraceStatus(status string) bool {
	return status == SkillTraceStatusOK || status == SkillTraceStatusError
}

// ListSkillTraceEvents returns one execution's timeline in seq order, capped at
// MaxSkillTraceEvents.
func (s *Store) ListSkillTraceEvents(executionID string, limit int) ([]SkillTraceEvent, error) {
	if limit <= 0 || limit > MaxSkillTraceEvents {
		limit = MaxSkillTraceEvents
	}
	rows, err := s.db.Query(`SELECT `+skillTraceEventColumns+`
		FROM skill_trace_events WHERE execution_id = ? ORDER BY seq ASC LIMIT ?`,
		strings.TrimSpace(executionID), limit)
	if err != nil {
		return nil, fmt.Errorf("list Skill trace events: %w", err)
	}
	defer rows.Close()
	events := []SkillTraceEvent{}
	for rows.Next() {
		var event SkillTraceEvent
		var occurredAt string
		var durationMS sql.NullInt64
		if err := rows.Scan(&event.EventID, &event.ExecutionID, &event.Seq, &occurredAt,
			&event.Kind, &event.Status, &durationMS, &event.Summary, &event.Detail); err != nil {
			return nil, fmt.Errorf("scan Skill trace event: %w", err)
		}
		event.OccurredAt, err = parseRequiredTime(occurredAt, "skill_trace_events.occurred_at")
		if err != nil {
			return nil, err
		}
		if durationMS.Valid {
			value := int(durationMS.Int64)
			event.DurationMS = &value
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// UpsertSkillExecutionMetrics stores one execution summary. Non-abort counters
// follow the latest payload; the aborted flag and its detail are monotonic so a
// later non-aborted snapshot cannot erase an observed abort.
func (s *Store) UpsertSkillExecutionMetrics(metrics SkillExecutionMetrics) error {
	prepared, err := prepareSkillExecutionMetrics(metrics)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO skill_execution_metrics (
		execution_id, request_count, error_count, distinct_hosts, max_burst_per_10s,
		top_interfaces_json, detail_truncated, aborted, abort_reason,
		abort_interface, abort_count, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	 ON CONFLICT(execution_id) DO UPDATE SET
	   request_count=excluded.request_count,
	   error_count=excluded.error_count,
	   distinct_hosts=excluded.distinct_hosts,
	   max_burst_per_10s=excluded.max_burst_per_10s,
	   top_interfaces_json=excluded.top_interfaces_json,
	   detail_truncated=excluded.detail_truncated,
	   aborted=max(skill_execution_metrics.aborted, excluded.aborted),
	   abort_reason=CASE
	     WHEN excluded.aborted = 1 THEN excluded.abort_reason
	     WHEN skill_execution_metrics.aborted = 1 THEN skill_execution_metrics.abort_reason
	     ELSE NULL END,
	   abort_interface=CASE
	     WHEN excluded.aborted = 1 THEN excluded.abort_interface
	     WHEN skill_execution_metrics.aborted = 1 THEN skill_execution_metrics.abort_interface
	     ELSE NULL END,
	   abort_count=CASE
	     WHEN excluded.aborted = 1 THEN excluded.abort_count
	     WHEN skill_execution_metrics.aborted = 1 THEN skill_execution_metrics.abort_count
	     ELSE NULL END,
	   updated_at=excluded.updated_at`,
		prepared.ExecutionID, prepared.RequestCount, prepared.ErrorCount,
		prepared.DistinctHosts, prepared.MaxBurstPer10s, prepared.TopInterfacesJSON,
		boolToInt(prepared.DetailTruncated), boolToInt(prepared.Aborted),
		nullIfEmpty(prepared.AbortReason), nullIfEmpty(prepared.AbortInterface),
		nullableInt(prepared.AbortCount), formatTime(prepared.UpdatedAt))
	if err != nil {
		return fmt.Errorf("upsert Skill execution metrics: %w", err)
	}
	return nil
}

func prepareSkillExecutionMetrics(metrics SkillExecutionMetrics) (SkillExecutionMetrics, error) {
	metrics.ExecutionID = strings.TrimSpace(metrics.ExecutionID)
	metrics.TopInterfacesJSON = strings.TrimSpace(metrics.TopInterfacesJSON)
	if metrics.TopInterfacesJSON == "" {
		metrics.TopInterfacesJSON = "[]"
	}
	if metrics.ExecutionID == "" || metrics.RequestCount < 0 || metrics.ErrorCount < 0 ||
		metrics.DistinctHosts < 0 || metrics.MaxBurstPer10s < 0 ||
		(metrics.AbortCount != nil && *metrics.AbortCount < 0) ||
		!json.Valid([]byte(metrics.TopInterfacesJSON)) {
		return SkillExecutionMetrics{}, ErrInvalidSkillTrace
	}
	if metrics.UpdatedAt.IsZero() {
		metrics.UpdatedAt = time.Now().UTC()
	}
	return metrics, nil
}

// GetSkillExecutionMetrics returns one execution's summary or ErrNotFound.
func (s *Store) GetSkillExecutionMetrics(executionID string) (SkillExecutionMetrics, error) {
	row := s.db.QueryRow(`SELECT `+skillExecutionMetricsColumns+`
		FROM skill_execution_metrics WHERE execution_id = ?`, strings.TrimSpace(executionID))
	var metrics SkillExecutionMetrics
	var detailTruncated, aborted int
	var abortCount sql.NullInt64
	var updatedAt string
	err := row.Scan(&metrics.ExecutionID, &metrics.RequestCount, &metrics.ErrorCount,
		&metrics.DistinctHosts, &metrics.MaxBurstPer10s, &metrics.TopInterfacesJSON,
		&detailTruncated, &aborted, &metrics.AbortReason, &metrics.AbortInterface,
		&abortCount, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SkillExecutionMetrics{}, ErrNotFound
	}
	if err != nil {
		return SkillExecutionMetrics{}, fmt.Errorf("scan Skill execution metrics: %w", err)
	}
	metrics.DetailTruncated = detailTruncated == 1
	metrics.Aborted = aborted == 1
	if abortCount.Valid {
		value := int(abortCount.Int64)
		metrics.AbortCount = &value
	}
	metrics.UpdatedAt, err = parseRequiredTime(updatedAt, "skill_execution_metrics.updated_at")
	if err != nil {
		return SkillExecutionMetrics{}, err
	}
	return metrics, nil
}

// QuerySkillExecutionStats groups executions by (skill_name, skill_scope,
// human_user_id) so same-named private Skills of different users stay separate.
func (s *Store) QuerySkillExecutionStats(filter SkillExecutionStatsFilter) ([]SkillExecutionStat, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	where := ` WHERE r.started_at >= ?`
	args := []any{formatTime(filter.Since)}
	if filter.Scope != "" {
		where += ` AND r.skill_scope = ?`
		args = append(args, filter.Scope)
	}
	if filter.HumanUserID != "" {
		where += ` AND r.human_user_id = ?`
		args = append(args, filter.HumanUserID)
	}
	args = append(args, limit)
	rows, err := s.db.Query(`SELECT r.skill_name, r.skill_scope, r.human_user_id,
		COALESCE(MAX(u.display_name), ''),
		COUNT(r.execution_id) AS executions,
		COALESCE(SUM(CASE WHEN m.aborted = 1 THEN 1 ELSE 0 END), 0) AS aborted_count,
		COALESCE(SUM(COALESCE(m.error_count, 0)), 0) AS sum_errors,
		COALESCE(MAX(m.request_count), 0) AS max_requests,
		MAX(r.started_at) AS last_execution_at
		FROM skill_execution_records r
		LEFT JOIN skill_execution_metrics m ON m.execution_id = r.execution_id
		LEFT JOIN human_users u ON u.human_user_id = r.human_user_id`+where+`
		GROUP BY r.skill_name, r.skill_scope, r.human_user_id
		ORDER BY executions DESC, r.skill_name ASC, r.human_user_id ASC
		LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("query Skill execution stats: %w", err)
	}
	defer rows.Close()
	stats := []SkillExecutionStat{}
	for rows.Next() {
		var stat SkillExecutionStat
		var lastExecutionAt string
		if err := rows.Scan(&stat.SkillName, &stat.SkillScope, &stat.HumanUserID,
			&stat.HumanUserName, &stat.Executions, &stat.AbortedCount,
			&stat.SumErrors, &stat.MaxRequests, &lastExecutionAt); err != nil {
			return nil, fmt.Errorf("scan Skill execution stat: %w", err)
		}
		stat.LastExecutionAt, err = parseRequiredTime(lastExecutionAt, "skill_execution_records.started_at")
		if err != nil {
			return nil, err
		}
		stats = append(stats, stat)
	}
	return stats, rows.Err()
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

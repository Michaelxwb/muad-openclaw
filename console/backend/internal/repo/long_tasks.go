package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const longTaskColumns = `task_id, pod_id, human_user_id, pool_key, agent_id, peer_id,
	skill_name, skill_root, pool_queued, pool_running, pool_limit, status, submitted_at, started_at, ended_at,
	terminal_reason, error_code, updated_at, last_seen_at`

const (
	longTaskMissingSnapshotReason = "runtime queue no longer reports task"
	longTaskMissingSnapshotCode   = "long_task_missing_snapshot"
)

func (s *Store) migrateLongTaskTasks() error {
	if _, err := s.db.Exec(longTaskSchemaDDL); err != nil {
		return fmt.Errorf("create long task schema: %w", err)
	}
	for _, column := range []string{"pool_queued", "pool_running", "pool_limit"} {
		if err := s.addLongTaskNonNegativeColumn(column); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) addLongTaskNonNegativeColumn(column string) error {
	exists, err := columnExists(s.db, "long_task_tasks", column)
	if err != nil {
		return fmt.Errorf("inspect long_task_tasks %s column: %w", column, err)
	}
	if exists {
		return nil
	}
	_, err = s.db.Exec(`ALTER TABLE long_task_tasks ADD COLUMN ` + column + ` INTEGER NOT NULL DEFAULT 0
		CHECK (` + column + ` >= 0)`)
	if err != nil {
		return fmt.Errorf("add long_task_tasks %s column: %w", column, err)
	}
	return nil
}

const longTaskSchemaDDL = `CREATE TABLE IF NOT EXISTS long_task_tasks (
	task_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL,
	human_user_id TEXT NOT NULL DEFAULT '',
	pool_key TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	peer_id TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_root TEXT NOT NULL DEFAULT '',
	pool_queued INTEGER NOT NULL DEFAULT 0 CHECK (pool_queued >= 0),
	pool_running INTEGER NOT NULL DEFAULT 0 CHECK (pool_running >= 0),
	pool_limit INTEGER NOT NULL DEFAULT 0 CHECK (pool_limit >= 0),
	status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
	submitted_at TEXT NOT NULL,
	started_at TEXT NOT NULL DEFAULT '',
	ended_at TEXT NOT NULL DEFAULT '',
	terminal_reason TEXT NOT NULL DEFAULT '',
	error_code TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_long_task_pod_updated ON long_task_tasks(pod_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_long_task_user_status ON long_task_tasks(human_user_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_long_task_pool_status ON long_task_tasks(pool_key, status, submitted_at);`

// UpsertLongTaskTasks mirrors the latest runtime queue snapshot. Status moves
// monotonically: queued -> running -> succeeded/failed, and terminal rows never
// regress to non-terminal states.
func (s *Store) UpsertLongTaskTasks(tasks []LongTaskTask) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin upsert Long Tasks: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := upsertLongTaskTasksTx(tx, tasks); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit upsert Long Tasks: %w", err)
	}
	return nil
}

// ReconcileLongTaskTasks mirrors one successful runtime snapshot for a Pod.
// Existing non-terminal rows omitted from the snapshot are marked failed so
// the Console view cannot retain stale queued/running tasks forever.
func (s *Store) ReconcileLongTaskTasks(podID string, tasks []LongTaskTask) error {
	podID = strings.TrimSpace(podID)
	if podID == "" {
		return ErrInvalidSkill
	}
	normalized := make([]LongTaskTask, 0, len(tasks))
	for _, task := range tasks {
		task.PodID = strings.TrimSpace(task.PodID)
		if task.PodID == "" {
			task.PodID = podID
		}
		if task.PodID != podID {
			return ErrInvalidSkill
		}
		normalized = append(normalized, task)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin reconcile Long Tasks: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := upsertLongTaskTasksTx(tx, normalized); err != nil {
		return err
	}
	if err := failMissingLongTasksTx(tx, podID, normalized); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit reconcile Long Tasks: %w", err)
	}
	return nil
}

func upsertLongTaskTasksTx(tx *sql.Tx, tasks []LongTaskTask) error {
	for _, task := range tasks {
		if err := upsertLongTaskTaskTx(tx, task); err != nil {
			return err
		}
	}
	return nil
}

func upsertLongTaskTaskTx(tx *sql.Tx, task LongTaskTask) error {
	prepared, err := prepareLongTaskTask(task)
	if err != nil {
		return err
	}
	existing, err := getLongTaskTaskTx(tx, prepared.TaskID)
	if err == nil && !longTaskStatusCanAdvance(existing.Status, prepared.Status) {
		return nil
	}
	if err == nil {
		return updateLongTaskTaskTx(tx, prepared)
	}
	if !errors.Is(err, ErrNotFound) {
		return err
	}
	return insertLongTaskTaskTx(tx, prepared)
}

func failMissingLongTasksTx(tx *sql.Tx, podID string, tasks []LongTaskTask) error {
	now := time.Now().UTC()
	seen := make([]string, 0, len(tasks))
	for _, task := range tasks {
		if task.TaskID != "" {
			seen = append(seen, task.TaskID)
		}
	}
	args := []any{
		LongTaskFailed, formatTime(now), longTaskMissingSnapshotReason,
		longTaskMissingSnapshotCode, formatTime(now), formatTime(now), podID,
		LongTaskQueued, LongTaskRunning,
	}
	query := `UPDATE long_task_tasks SET status = ?, ended_at = ?,
		pool_queued = 0, pool_running = 0,
		terminal_reason = ?, error_code = ?, updated_at = ?, last_seen_at = ?
		WHERE pod_id = ? AND status IN (?, ?)`
	if len(seen) > 0 {
		query += ` AND task_id NOT IN (` + placeholders(len(seen)) + `)`
		for _, taskID := range seen {
			args = append(args, taskID)
		}
	}
	if _, err := tx.Exec(query, args...); err != nil {
		return fmt.Errorf("reconcile missing Long Tasks: %w", err)
	}
	return nil
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	var builder strings.Builder
	for i := 0; i < count; i++ {
		if i > 0 {
			builder.WriteString(", ")
		}
		builder.WriteByte('?')
	}
	return builder.String()
}

func prepareLongTaskTask(task LongTaskTask) (LongTaskTask, error) {
	now := time.Now().UTC()
	task.TaskID = strings.TrimSpace(task.TaskID)
	task.PodID = strings.TrimSpace(task.PodID)
	task.HumanUserID = strings.TrimSpace(task.HumanUserID)
	task.PoolKey = strings.TrimSpace(task.PoolKey)
	task.AgentID = strings.TrimSpace(task.AgentID)
	task.PeerID = strings.TrimSpace(task.PeerID)
	task.SkillName = strings.TrimSpace(task.SkillName)
	task.SkillRoot = strings.TrimSpace(task.SkillRoot)
	task.Status = strings.TrimSpace(task.Status)
	if task.SubmittedAt.IsZero() {
		task.SubmittedAt = now
	}
	if task.UpdatedAt.IsZero() {
		task.UpdatedAt = now
	}
	if task.LastSeenAt.IsZero() {
		task.LastSeenAt = now
	}
	if !validLongTaskTask(task) {
		return LongTaskTask{}, ErrInvalidSkill
	}
	return task, nil
}

func validLongTaskTask(task LongTaskTask) bool {
	return task.TaskID != "" && task.PodID != "" && task.PoolKey != "" &&
		task.PoolQueued >= 0 && task.PoolRunning >= 0 && task.PoolLimit >= 0 &&
		validRuntimeID(task.AgentID) && task.PeerID != "" && validSkillName(task.SkillName) &&
		validLongTaskStatus(task.Status) &&
		!task.SubmittedAt.IsZero() && !task.UpdatedAt.IsZero() && !task.LastSeenAt.IsZero()
}

func validLongTaskStatus(status string) bool {
	switch status {
	case LongTaskQueued, LongTaskRunning, LongTaskSucceeded, LongTaskFailed:
		return true
	default:
		return false
	}
}

func longTaskStatusCanAdvance(current, next string) bool {
	if current == next {
		return true
	}
	if longTaskTerminal(current) {
		return false
	}
	if current == LongTaskRunning && next == LongTaskQueued {
		return false
	}
	return validLongTaskStatus(next)
}

func longTaskTerminal(status string) bool {
	return status == LongTaskSucceeded || status == LongTaskFailed
}

func insertLongTaskTaskTx(tx *sql.Tx, task LongTaskTask) error {
	_, err := tx.Exec(`INSERT INTO long_task_tasks (
		task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name,
		skill_root, pool_queued, pool_running, pool_limit, status, submitted_at, started_at, ended_at, terminal_reason,
		error_code, updated_at, last_seen_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.TaskID, task.PodID, task.HumanUserID, task.PoolKey, task.AgentID,
		task.PeerID, task.SkillName, task.SkillRoot, task.PoolQueued, task.PoolRunning,
		task.PoolLimit, task.Status,
		formatTime(task.SubmittedAt), formatOptionalTime(task.StartedAt), formatOptionalTime(task.EndedAt),
		task.TerminalReason, task.ErrorCode, formatTime(task.UpdatedAt), formatTime(task.LastSeenAt))
	if err != nil {
		return fmt.Errorf("insert Long Task: %w", err)
	}
	return nil
}

func updateLongTaskTaskTx(tx *sql.Tx, task LongTaskTask) error {
	res, err := tx.Exec(`UPDATE long_task_tasks SET human_user_id = ?, pool_key = ?,
		agent_id = ?, peer_id = ?, skill_name = ?, skill_root = ?, status = ?,
		pool_queued = ?, pool_running = ?, pool_limit = ?, started_at = ?,
		ended_at = ?, terminal_reason = ?, error_code = ?,
		updated_at = ?, last_seen_at = ? WHERE task_id = ?`,
		task.HumanUserID, task.PoolKey, task.AgentID, task.PeerID, task.SkillName,
		task.SkillRoot, task.Status, task.PoolQueued, task.PoolRunning, task.PoolLimit,
		formatOptionalTime(task.StartedAt), formatOptionalTime(task.EndedAt), task.TerminalReason, task.ErrorCode,
		formatTime(task.UpdatedAt), formatTime(task.LastSeenAt), task.TaskID)
	return affectedOrNotFound(res, err, "update Long Task")
}

func getLongTaskTaskTx(tx *sql.Tx, taskID string) (LongTaskTask, error) {
	row := tx.QueryRow(`SELECT `+longTaskColumns+` FROM long_task_tasks WHERE task_id = ?`, taskID)
	return scanLongTaskTask(row)
}

// ListLongTaskTasks returns the persisted operational queue mirror.
func (s *Store) ListLongTaskTasks(filter LongTaskListFilter) ([]LongTaskTask, int, error) {
	where, args := longTaskWhere(filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM long_task_tasks`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count Long Tasks: %w", err)
	}
	query := `SELECT ` + longTaskColumns + ` FROM long_task_tasks` + where +
		` ORDER BY submitted_at DESC, task_id DESC`
	listArgs := append([]any(nil), args...)
	if filter.Limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, filter.Limit, filter.Offset)
	}
	rows, err := s.db.Query(query, listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list Long Tasks: %w", err)
	}
	defer rows.Close()
	tasks, err := collectLongTaskTasks(rows)
	return tasks, total, err
}

// ListLongTaskPools returns pool summaries for the same filter, independent of
// task pagination.
func (s *Store) ListLongTaskPools(filter LongTaskListFilter) ([]LongTaskPool, error) {
	where, args := longTaskWhere(filter)
	query := `SELECT pod_id, MAX(human_user_id), pool_key, agent_id, peer_id,
		MAX(pool_queued), MAX(pool_running), MAX(pool_limit),
		MAX(updated_at), MAX(last_seen_at)
		FROM long_task_tasks` + where +
		` GROUP BY pod_id, pool_key, agent_id, peer_id
		ORDER BY MAX(updated_at) DESC, pool_key ASC`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list Long Task pools: %w", err)
	}
	defer rows.Close()
	return collectLongTaskPools(rows)
}

func longTaskWhere(filter LongTaskListFilter) (string, []any) {
	clauses := make([]string, 0, 7)
	args := make([]any, 0, 9)
	for _, item := range []struct{ clause, value string }{
		{"pod_id = ?", filter.PodID}, {"human_user_id = ?", filter.HumanUserID},
		{"agent_id = ?", filter.AgentID}, {"skill_name = ?", filter.SkillName},
		{"pool_key = ?", filter.PoolKey}, {"status = ?", filter.Status},
	} {
		if strings.TrimSpace(item.value) != "" {
			clauses = append(clauses, item.clause)
			args = append(args, strings.TrimSpace(item.value))
		}
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		clauses = append(clauses, "(task_id LIKE ? OR skill_name LIKE ? OR agent_id LIKE ?)")
		pattern := "%" + query + "%"
		args = append(args, pattern, pattern, pattern)
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func collectLongTaskPools(rows *sql.Rows) ([]LongTaskPool, error) {
	pools := []LongTaskPool{}
	for rows.Next() {
		pool, err := scanLongTaskPool(rows)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}
	return pools, rows.Err()
}

func scanLongTaskPool(sc scanner) (LongTaskPool, error) {
	var pool LongTaskPool
	var updatedAt, lastSeenAt string
	err := sc.Scan(&pool.PodID, &pool.HumanUserID, &pool.PoolKey, &pool.AgentID,
		&pool.PeerID, &pool.PoolQueued, &pool.PoolRunning, &pool.PoolLimit,
		&updatedAt, &lastSeenAt)
	if err != nil {
		return LongTaskPool{}, fmt.Errorf("scan Long Task pool: %w", err)
	}
	if pool.UpdatedAt, err = parseRequiredTime(updatedAt, "long_task_tasks.updated_at"); err != nil {
		return LongTaskPool{}, err
	}
	pool.LastSeenAt, err = parseRequiredTime(lastSeenAt, "long_task_tasks.last_seen_at")
	return pool, err
}

func collectLongTaskTasks(rows *sql.Rows) ([]LongTaskTask, error) {
	tasks := []LongTaskTask{}
	for rows.Next() {
		task, err := scanLongTaskTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func scanLongTaskTask(sc scanner) (LongTaskTask, error) {
	var task LongTaskTask
	var submittedAt, startedAt, endedAt, updatedAt, lastSeenAt string
	err := sc.Scan(&task.TaskID, &task.PodID, &task.HumanUserID, &task.PoolKey,
		&task.AgentID, &task.PeerID, &task.SkillName, &task.SkillRoot, &task.PoolQueued,
		&task.PoolRunning, &task.PoolLimit, &task.Status, &submittedAt, &startedAt, &endedAt,
		&task.TerminalReason, &task.ErrorCode, &updatedAt, &lastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return LongTaskTask{}, ErrNotFound
	}
	if err != nil {
		return LongTaskTask{}, fmt.Errorf("scan Long Task: %w", err)
	}
	return parseLongTaskTimes(task, submittedAt, startedAt, endedAt, updatedAt, lastSeenAt)
}

func parseLongTaskTimes(
	task LongTaskTask, submittedAt, startedAt, endedAt, updatedAt, lastSeenAt string,
) (LongTaskTask, error) {
	var err error
	if task.SubmittedAt, err = parseRequiredTime(submittedAt, "long_task_tasks.submitted_at"); err != nil {
		return LongTaskTask{}, err
	}
	if task.StartedAt, err = parseOptionalTime(startedAt, "long_task_tasks.started_at"); err != nil {
		return LongTaskTask{}, err
	}
	if task.EndedAt, err = parseOptionalTime(endedAt, "long_task_tasks.ended_at"); err != nil {
		return LongTaskTask{}, err
	}
	if task.UpdatedAt, err = parseRequiredTime(updatedAt, "long_task_tasks.updated_at"); err != nil {
		return LongTaskTask{}, err
	}
	task.LastSeenAt, err = parseRequiredTime(lastSeenAt, "long_task_tasks.last_seen_at")
	return task, err
}

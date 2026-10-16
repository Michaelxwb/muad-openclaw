package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const longTaskColumns = `task_id, pod_id, human_user_id, pool_key, agent_id, peer_id,
	skill_name, skill_root, pool_queued, pool_running, pool_limit, status, state_revision,
	cancel_requested_at, cancel_requested_by, cancelled_at, submitted_at, started_at, ended_at,
	terminal_reason, error_code, updated_at, last_seen_at`

func (s *Store) migrateLongTaskTasks() error {
	if _, err := s.db.Exec(longTaskSchemaDDL); err != nil {
		return fmt.Errorf("create long task schema: %w", err)
	}
	// 旧库先补齐 pool 计数列，再做取消状态重建：重建语句按显式列复制，缺列会
	// 使整个事务回滚并保留原表。
	for _, column := range []string{"pool_queued", "pool_running", "pool_limit"} {
		if err := s.addLongTaskNonNegativeColumn(column); err != nil {
			return err
		}
	}
	return s.migrateLongTaskStatusConstraint()
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
	if errors.Is(err, ErrNotFound) {
		return insertLongTaskTaskTx(tx, prepared)
	}
	if err != nil {
		return err
	}
	return mergeLongTaskTaskTx(tx, existing, prepared)
}

// mergeLongTaskTaskTx converges the mirror with revision-gated, forward-only
// semantics: terminal rows (cancelled/succeeded/failed) are never rewritten,
// stale或旧格式（低 revision，含 0）快照不能把较新记录拉回，只有合法前进
// （含同 revision 的旧 Worker 流程）才整体更新；被跳过的快照只推进
// last_seen_at 记录观察，不再伪造 status_regressed 的 failed 终态。
func mergeLongTaskTaskTx(tx *sql.Tx, existing, incoming LongTaskTask) error {
	if longTaskTerminal(existing.Status) {
		return observeLongTaskTaskTx(tx, existing.TaskID, incoming)
	}
	if incoming.StateRevision < existing.StateRevision {
		return observeLongTaskTaskTx(tx, existing.TaskID, incoming)
	}
	if longTaskStatusCanAdvance(existing.Status, incoming.Status) {
		return updateLongTaskTaskTx(tx, incoming)
	}
	return observeLongTaskTaskTx(tx, existing.TaskID, incoming)
}

func observeLongTaskTaskTx(tx *sql.Tx, taskID string, incoming LongTaskTask) error {
	res, err := tx.Exec(`UPDATE long_task_tasks SET last_seen_at = ? WHERE task_id = ?`,
		formatTime(incoming.LastSeenAt), taskID)
	return affectedOrNotFound(res, err, "observe Long Task")
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
	task.CancelRequestedBy = strings.TrimSpace(task.CancelRequestedBy)
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
		task.StateRevision >= 0 &&
		validRuntimeID(task.AgentID) && task.PeerID != "" && validSkillName(task.SkillName) &&
		validLongTaskStatus(task.Status) &&
		!task.SubmittedAt.IsZero() && !task.UpdatedAt.IsZero() && !task.LastSeenAt.IsZero()
}

func validLongTaskStatus(status string) bool {
	switch status {
	case LongTaskQueued, LongTaskRunning, LongTaskCancelling, LongTaskCancelled,
		LongTaskSucceeded, LongTaskFailed:
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
	// cancelling 是单向门：只有确认停止进入 cancelled 才是合法前进，迟到的
	// running/queued 快照不得把取消中的任务拉回去。
	if current == LongTaskCancelling {
		return next == LongTaskCancelled
	}
	return validLongTaskStatus(next)
}

func longTaskTerminal(status string) bool {
	return status == LongTaskSucceeded || status == LongTaskFailed || status == LongTaskCancelled
}

func insertLongTaskTaskTx(tx *sql.Tx, task LongTaskTask) error {
	_, err := tx.Exec(`INSERT INTO long_task_tasks (
		task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name,
		skill_root, pool_queued, pool_running, pool_limit, status, state_revision,
		cancel_requested_at, cancel_requested_by, cancelled_at, submitted_at, started_at, ended_at,
		terminal_reason, error_code, updated_at, last_seen_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.TaskID, task.PodID, task.HumanUserID, task.PoolKey, task.AgentID,
		task.PeerID, task.SkillName, task.SkillRoot, task.PoolQueued, task.PoolRunning,
		task.PoolLimit, task.Status, task.StateRevision,
		formatOptionalTime(task.CancelRequestedAt), task.CancelRequestedBy, formatOptionalTime(task.CancelledAt),
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
		state_revision = ?, cancel_requested_at = ?, cancel_requested_by = ?, cancelled_at = ?,
		pool_queued = ?, pool_running = ?, pool_limit = ?, started_at = ?,
		ended_at = ?, terminal_reason = ?, error_code = ?,
		updated_at = ?, last_seen_at = ? WHERE task_id = ?`,
		task.HumanUserID, task.PoolKey, task.AgentID, task.PeerID, task.SkillName,
		task.SkillRoot, task.Status, task.StateRevision, formatOptionalTime(task.CancelRequestedAt),
		task.CancelRequestedBy, formatOptionalTime(task.CancelledAt), task.PoolQueued, task.PoolRunning, task.PoolLimit,
		formatOptionalTime(task.StartedAt), formatOptionalTime(task.EndedAt), task.TerminalReason, task.ErrorCode,
		formatTime(task.UpdatedAt), formatTime(task.LastSeenAt), task.TaskID)
	return affectedOrNotFound(res, err, "update Long Task")
}

func getLongTaskTaskTx(tx *sql.Tx, taskID string) (LongTaskTask, error) {
	row := tx.QueryRow(`SELECT `+longTaskColumns+` FROM long_task_tasks WHERE task_id = ?`, taskID)
	return scanLongTaskTask(row)
}

// GetLongTaskTask returns one persisted task by ID (trusted read for cancellation
// ownership resolution). Missing rows surface as ErrNotFound.
func (s *Store) GetLongTaskTask(taskID string) (LongTaskTask, error) {
	row := s.db.QueryRow(`SELECT `+longTaskColumns+` FROM long_task_tasks WHERE task_id = ?`, strings.TrimSpace(taskID))
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
	var submittedAt, startedAt, endedAt, cancelRequestedAt, cancelledAt, updatedAt, lastSeenAt string
	err := sc.Scan(&task.TaskID, &task.PodID, &task.HumanUserID, &task.PoolKey,
		&task.AgentID, &task.PeerID, &task.SkillName, &task.SkillRoot, &task.PoolQueued,
		&task.PoolRunning, &task.PoolLimit, &task.Status, &task.StateRevision,
		&cancelRequestedAt, &task.CancelRequestedBy, &cancelledAt,
		&submittedAt, &startedAt, &endedAt,
		&task.TerminalReason, &task.ErrorCode, &updatedAt, &lastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return LongTaskTask{}, ErrNotFound
	}
	if err != nil {
		return LongTaskTask{}, fmt.Errorf("scan Long Task: %w", err)
	}
	parsed, err := parseLongTaskTimes(task, submittedAt, startedAt, endedAt, updatedAt, lastSeenAt)
	if err != nil {
		return LongTaskTask{}, err
	}
	if parsed.CancelRequestedAt, err = parseOptionalTime(cancelRequestedAt, "long_task_tasks.cancel_requested_at"); err != nil {
		return LongTaskTask{}, err
	}
	parsed.CancelledAt, err = parseOptionalTime(cancelledAt, "long_task_tasks.cancelled_at")
	return parsed, err
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

package repo

import (
	"database/sql"
	"errors"
	"fmt"
)

// Current long_task_tasks definition. cancelling/cancelled are runtime
// cancellation states (not business failures), and the cancel metadata columns
// keep the operator-visible mirror aligned with the Worker state machine.
const longTaskTableDDL = `CREATE TABLE IF NOT EXISTS long_task_tasks (
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
	status TEXT NOT NULL CHECK (status IN ('queued','running','cancelling','cancelled','succeeded','failed')),
	state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
	cancel_requested_at TEXT NOT NULL DEFAULT '',
	cancel_requested_by TEXT NOT NULL DEFAULT '',
	cancelled_at TEXT NOT NULL DEFAULT '',
	submitted_at TEXT NOT NULL,
	started_at TEXT NOT NULL DEFAULT '',
	ended_at TEXT NOT NULL DEFAULT '',
	terminal_reason TEXT NOT NULL DEFAULT '',
	error_code TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);`

const longTaskIndexesDDL = `
CREATE INDEX IF NOT EXISTS idx_long_task_pod_updated ON long_task_tasks(pod_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_long_task_user_status ON long_task_tasks(human_user_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_long_task_pool_status ON long_task_tasks(pool_key, status, submitted_at);`

const longTaskSchemaDDL = longTaskTableDDL + "\n" + longTaskIndexesDDL

// migrateLongTaskStatusConstraint rebuilds long_task_tasks when an upgraded
// database still carries the old four-state CHECK (SQLite cannot ALTER a CHECK).
// The rebuild runs in a single transaction with explicit column copies and a
// row-count check: any failure (e.g. a legacy status the new CHECK rejects)
// rolls back and leaves the original table, rows and indexes untouched.
// Re-running on an already migrated database is a no-op.
func (s *Store) migrateLongTaskStatusConstraint() error {
	allows, err := longTaskAllowsCancellation(s.db)
	if err != nil {
		return err
	}
	if allows {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin long task status migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM long_task_tasks`).Scan(&before); err != nil {
		return fmt.Errorf("count long_task_tasks before migration: %w", err)
	}
	if _, err := tx.Exec(longTaskRebuildStatements); err != nil {
		return fmt.Errorf("migrate long task status constraint: %w", err)
	}
	var after int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM long_task_tasks`).Scan(&after); err != nil {
		return fmt.Errorf("count long_task_tasks after migration: %w", err)
	}
	if after != before {
		return fmt.Errorf("long task status migration row count mismatch: %d -> %d", before, after)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit long task status migration: %w", err)
	}
	return nil
}

const longTaskRebuildStatements = `
ALTER TABLE long_task_tasks RENAME TO long_task_tasks_legacy;
` + longTaskTableDDL + `
INSERT INTO long_task_tasks (
	task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name,
	skill_root, pool_queued, pool_running, pool_limit, status, submitted_at,
	started_at, ended_at, terminal_reason, error_code, updated_at, last_seen_at
) SELECT task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name,
	skill_root, pool_queued, pool_running, pool_limit, status, submitted_at,
	started_at, ended_at, terminal_reason, error_code, updated_at, last_seen_at
	FROM long_task_tasks_legacy;
DROP TABLE long_task_tasks_legacy;
` + longTaskIndexesDDL

func longTaskAllowsCancellation(db *sql.DB) (bool, error) {
	var one int
	err := db.QueryRow(`SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'long_task_tasks' AND sql LIKE "%'cancelling'%"`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect long_task_tasks schema: %w", err)
	}
	return true, nil
}

package repo

import "fmt"

// skillTraceSchemaDDL creates the execution trace tables. Every statement is
// idempotent so an upgrade can be re-run on an existing database.
const skillTraceSchemaDDL = `
CREATE TABLE IF NOT EXISTS skill_trace_events (
	event_id TEXT PRIMARY KEY,
	execution_id TEXT NOT NULL
		REFERENCES skill_execution_records(execution_id) ON DELETE CASCADE,
	seq INTEGER NOT NULL CHECK (seq > 0),
	occurred_at TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('exec','http','output','abort')),
	status TEXT NOT NULL CHECK (status IN ('ok','error')),
	duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
	summary TEXT NOT NULL DEFAULT '',
	detail TEXT,
	UNIQUE (execution_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_skill_trace_execution ON skill_trace_events(execution_id, seq);
CREATE INDEX IF NOT EXISTS idx_skill_trace_occurred ON skill_trace_events(occurred_at);

CREATE TABLE IF NOT EXISTS skill_execution_metrics (
	execution_id TEXT PRIMARY KEY
		REFERENCES skill_execution_records(execution_id) ON DELETE CASCADE,
	request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
	error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
	distinct_hosts INTEGER NOT NULL DEFAULT 0 CHECK (distinct_hosts >= 0),
	max_burst_per_10s INTEGER NOT NULL DEFAULT 0 CHECK (max_burst_per_10s >= 0),
	top_interfaces_json TEXT NOT NULL DEFAULT '[]',
	detail_truncated INTEGER NOT NULL DEFAULT 0 CHECK (detail_truncated IN (0,1)),
	aborted INTEGER NOT NULL DEFAULT 0 CHECK (aborted IN (0,1)),
	abort_reason TEXT,
	abort_interface TEXT,
	abort_count INTEGER CHECK (abort_count IS NULL OR abort_count >= 0),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_channels (
	channel_id TEXT PRIMARY KEY,
	type TEXT NOT NULL CHECK (type IN ('wecom')),
	name TEXT NOT NULL,
	config_enc TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`

// migrateSkillTraceSchema creates skill_trace_events, skill_execution_metrics,
// and notify_channels. It must run after migrateSkillExecutionRecords because
// the first two tables reference skill_execution_records.
func (s *Store) migrateSkillTraceSchema() error {
	if _, err := s.db.Exec(skillTraceSchemaDDL); err != nil {
		return fmt.Errorf("create Skill trace schema: %w", err)
	}
	return nil
}

// migrateResourceGlobalSkillRequestLimit adds the per-request cap column to the
// singleton resource_global row. Existing deployments keep their data and pick
// up the 1000 default; re-running is a no-op.
func (s *Store) migrateResourceGlobalSkillRequestLimit() error {
	exists, err := columnExists(s.db, "resource_global", "skill_request_limit")
	if err != nil {
		return fmt.Errorf("inspect resource_global skill_request_limit column: %w", err)
	}
	if exists {
		return nil
	}
	if _, err := s.db.Exec(`ALTER TABLE resource_global
		ADD COLUMN skill_request_limit INTEGER NOT NULL DEFAULT 1000
		CHECK (skill_request_limit >= 0)`); err != nil {
		return fmt.Errorf("add resource_global skill_request_limit column: %w", err)
	}
	return nil
}

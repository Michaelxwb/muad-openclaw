package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const skillExecutionTableDDL = `CREATE TABLE IF NOT EXISTS skill_execution_records (
	execution_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
	human_user_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_scope TEXT NOT NULL CHECK (skill_scope IN ('system','public','private')),
	skill_version TEXT NOT NULL DEFAULT '',
	entry_type TEXT NOT NULL DEFAULT '',
	activation_mode TEXT NOT NULL DEFAULT 'tool'
		CHECK (activation_mode IN ('tool','path-detected','runner')),
	event_seq INTEGER NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
	status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','rejected')),
	started_at TEXT NOT NULL,
	ended_at TEXT NOT NULL DEFAULT '',
	duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
	progress_json TEXT NOT NULL DEFAULT '[]',
	last_tool_name TEXT NOT NULL DEFAULT '',
	terminal_reason TEXT NOT NULL DEFAULT '',
	error_code TEXT NOT NULL DEFAULT '',
	error_message TEXT NOT NULL DEFAULT '',
	input_summary TEXT NOT NULL DEFAULT '',
	output_summary TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	FOREIGN KEY (human_user_id, pod_id)
		REFERENCES human_users(human_user_id, pod_id) ON DELETE CASCADE
);`

const skillExecutionIndexesDDL = `
CREATE INDEX IF NOT EXISTS idx_skill_executions_human_user_started
	ON skill_execution_records(human_user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_executions_pod_started
	ON skill_execution_records(pod_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_executions_skill_started
	ON skill_execution_records(skill_name, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_executions_status_started
	ON skill_execution_records(status, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_executions_started
	ON skill_execution_records(started_at DESC);`

const legacySkillExecutionCopySQL = `INSERT INTO skill_execution_records (
	execution_id, pod_id, human_user_id, agent_id, skill_name, skill_scope,
	skill_version, entry_type, activation_mode, event_seq, status, started_at,
	ended_at, duration_ms, progress_json, last_tool_name, terminal_reason,
	error_code, error_message, input_summary, output_summary, created_at
) SELECT execution_id, pod_id, human_user_id, agent_id, skill_name, skill_scope,
	skill_version, '', 'tool', 0, status, started_at, ended_at, duration_ms,
	progress_json, '', '', error_code, error_message, input_summary,
	output_summary, created_at FROM skill_execution_records_legacy`

const currentSkillExecutionCopySQL = `INSERT INTO skill_execution_records (
	execution_id, pod_id, human_user_id, agent_id, skill_name, skill_scope,
	skill_version, entry_type, activation_mode, event_seq, status, started_at,
	ended_at, duration_ms, progress_json, last_tool_name, terminal_reason,
	error_code, error_message, input_summary, output_summary, created_at
) SELECT execution_id, pod_id, human_user_id, agent_id, skill_name, skill_scope,
	skill_version, entry_type, activation_mode, event_seq, status, started_at,
	ended_at, duration_ms, progress_json, last_tool_name, terminal_reason,
	error_code, error_message, input_summary, output_summary, created_at
	FROM skill_execution_records_legacy`

var skillExecutionAuditColumns = []string{
	"entry_type", "activation_mode", "event_seq", "last_tool_name", "terminal_reason",
}

func (s *Store) migrateSkillExecutionRecords() error {
	definition, exists, err := skillExecutionTableDefinition(s.db)
	if err != nil {
		return fmt.Errorf("inspect Skill execution schema: %w", err)
	}
	if !exists {
		return execSkillExecutionSchema(s.db)
	}
	columns, err := skillExecutionColumnsSet(s.db)
	if err != nil {
		return fmt.Errorf("inspect Skill execution columns: %w", err)
	}
	hasAuditColumns := countSkillExecutionAuditColumns(columns)
	if hasAuditColumns == len(skillExecutionAuditColumns) && strings.Contains(definition, "'rejected'") {
		return execSkillExecutionIndexes(s.db)
	}
	if hasAuditColumns != 0 && hasAuditColumns != len(skillExecutionAuditColumns) {
		return fmt.Errorf("migrate Skill execution schema: inconsistent audit columns")
	}
	copySQL := legacySkillExecutionCopySQL
	if hasAuditColumns == len(skillExecutionAuditColumns) {
		copySQL = currentSkillExecutionCopySQL
	}
	return s.rebuildSkillExecutionRecords(copySQL)
}

func (s *Store) rebuildSkillExecutionRecords(copySQL string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin Skill execution migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		`ALTER TABLE skill_execution_records RENAME TO skill_execution_records_legacy`,
		skillExecutionTableDDL, copySQL,
		`DROP TABLE skill_execution_records_legacy`, skillExecutionIndexesDDL,
	} {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migrate Skill execution schema: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Skill execution migration: %w", err)
	}
	return nil
}

func skillExecutionTableDefinition(db *sql.DB) (string, bool, error) {
	var definition string
	err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
		"skill_execution_records").Scan(&definition)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return definition, true, nil
}

func skillExecutionColumnsSet(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`PRAGMA table_info(skill_execution_records)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

func countSkillExecutionAuditColumns(columns map[string]bool) int {
	count := 0
	for _, column := range skillExecutionAuditColumns {
		if columns[column] {
			count++
		}
	}
	return count
}

func execSkillExecutionSchema(db *sql.DB) error {
	if _, err := db.Exec(skillExecutionTableDDL + skillExecutionIndexesDDL); err != nil {
		return fmt.Errorf("create Skill execution schema: %w", err)
	}
	return nil
}

func execSkillExecutionIndexes(db *sql.DB) error {
	if _, err := db.Exec(skillExecutionIndexesDDL); err != nil {
		return fmt.Errorf("create Skill execution indexes: %w", err)
	}
	return nil
}

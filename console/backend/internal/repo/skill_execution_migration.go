package repo

import (
	"database/sql"
	"errors"
	"fmt"
)

const skillExecutionTableDDL = `CREATE TABLE IF NOT EXISTS skill_execution_records (
	execution_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
	human_user_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_scope TEXT NOT NULL CHECK (skill_scope IN ('system','public','private')),
	started_at TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_skill_executions_started
	ON skill_execution_records(started_at DESC);`

var skillExecutionRequiredColumns = map[string]bool{
	"execution_id": true, "pod_id": true, "human_user_id": true, "agent_id": true,
	"skill_name": true, "skill_scope": true, "started_at": true, "created_at": true,
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
	if !skillExecutionColumnSetMatches(columns) {
		return fmt.Errorf("skill_execution_records schema is not the minimal audit schema; run docs/skill-execution-rebuild.sql before starting this version")
	}
	if !skillExecutionDefinitionMatches(definition) {
		return fmt.Errorf("skill_execution_records schema constraints do not match the minimal audit schema; run docs/skill-execution-rebuild.sql before starting this version")
	}
	return execSkillExecutionIndexes(s.db)
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

func skillExecutionColumnSetMatches(columns map[string]bool) bool {
	if len(columns) != len(skillExecutionRequiredColumns) {
		return false
	}
	for column := range skillExecutionRequiredColumns {
		if !columns[column] {
			return false
		}
	}
	return true
}

func skillExecutionDefinitionMatches(definition string) bool {
	return definition != ""
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

package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AgentGuidance holds admin-configurable agent workspace guidance text that is
// shipped to the runtime DTO and written into AGENTS.md / BOOTSTRAP.md. Empty
// fields fall back to the runtime renderer's built-in defaults.
type AgentGuidance struct {
	UserSkill    string
	Memory       string
	Main         string
	GlobalPrompt string
	UpdatedAt    time.Time
}

// GetAgentGuidance returns the singleton guidance record; a missing row yields
// an empty record (renderer defaults apply).
func (s *Store) GetAgentGuidance() (AgentGuidance, error) {
	row := s.db.QueryRow(`SELECT user_skill, memory, main, global_prompt, updated_at
		FROM agent_guidance WHERE id = 1`)
	return scanAgentGuidance(row)
}

// SetAgentGuidance upserts the singleton guidance record.
func (s *Store) SetAgentGuidance(guidance AgentGuidance) error {
	res, err := s.db.Exec(`INSERT INTO agent_guidance (id, user_skill, memory, main, global_prompt, updated_at)
		VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET user_skill = excluded.user_skill,
			memory = excluded.memory, main = excluded.main,
			global_prompt = excluded.global_prompt, updated_at = excluded.updated_at`,
		guidance.UserSkill, guidance.Memory, guidance.Main, guidance.GlobalPrompt,
		formatTime(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("set Agent guidance: %w", err)
	}
	if _, err := res.RowsAffected(); err != nil {
		return fmt.Errorf("set Agent guidance rows affected: %w", err)
	}
	return nil
}

// SaveAgentGuidanceAndMarkPods atomically persists the guidance and marks every
// Pod pending in one transaction, so a failure rolls back the guidance write.
func (s *Store) SaveAgentGuidanceAndMarkPods(guidance AgentGuidance) ([]string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin save Agent guidance: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO agent_guidance (id, user_skill, memory, main, global_prompt, updated_at)
		VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET user_skill = excluded.user_skill,
			memory = excluded.memory, main = excluded.main,
			global_prompt = excluded.global_prompt, updated_at = excluded.updated_at`,
		guidance.UserSkill, guidance.Memory, guidance.Main, guidance.GlobalPrompt,
		formatTime(time.Now().UTC())); err != nil {
		return nil, fmt.Errorf("save Agent guidance: %w", err)
	}
	podIDs, err := markAllPodsConfigPendingTx(tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit save Agent guidance: %w", err)
	}
	return podIDs, nil
}

func scanAgentGuidance(sc scanner) (AgentGuidance, error) {
	var guidance AgentGuidance
	var updatedAt string
	err := sc.Scan(&guidance.UserSkill, &guidance.Memory, &guidance.Main, &guidance.GlobalPrompt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentGuidance{}, nil
	}
	if err != nil {
		return AgentGuidance{}, fmt.Errorf("scan Agent guidance: %w", err)
	}
	guidance.UpdatedAt, err = parseRequiredTime(updatedAt, "agent_guidance.updated_at")
	if err != nil {
		return AgentGuidance{}, err
	}
	return guidance, nil
}

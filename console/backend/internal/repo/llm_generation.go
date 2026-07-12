package repo

import (
	"fmt"
	"time"
)

func (s *Store) SetLLMGlobalAndMarkPods(global LLMGlobal) ([]string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin set global LLM: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.Exec(`INSERT INTO llm_global
		(id, provider, base_url, api_key_enc, model, updated_at) VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, base_url=excluded.base_url,
		api_key_enc=excluded.api_key_enc, model=excluded.model, updated_at=excluded.updated_at`,
		global.Provider, global.BaseURL, global.APIKeyEnc, global.Model, formatTime(time.Now().UTC()))
	if err != nil {
		return nil, fmt.Errorf("set global LLM: %w", err)
	}
	podIDs, err := markAllPodsConfigPendingTx(tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit global LLM and Pod generations: %w", err)
	}
	return podIDs, nil
}

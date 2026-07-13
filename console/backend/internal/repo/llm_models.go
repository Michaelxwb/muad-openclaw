package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type LLMModelConfigCreate struct {
	DisplayName       string
	Provider          string
	BaseURL           string
	APIKeyEnc         string
	APIKeyFingerprint string
	Model             string
}

type LLMModelConfigListFilter struct {
	AvailableOnly bool
}

func (s *Store) CreateLLMModelConfigs(input []LLMModelConfigCreate) ([]LLMModelConfig, error) {
	if len(input) == 0 {
		return nil, ErrInvalidLLMModel
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin create LLM models: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	models := make([]LLMModelConfig, 0, len(input))
	for _, item := range input {
		model, err := prepareLLMModelConfig(item)
		if err != nil {
			return nil, err
		}
		if err := insertLLMModelConfig(tx, model); err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create LLM models: %w", err)
	}
	return models, nil
}

func (s *Store) ListLLMModelConfigs(filter LLMModelConfigListFilter) ([]LLMModelConfig, error) {
	query := `SELECT m.model_config_id, m.display_name, m.provider, m.base_url,
		m.api_key_enc, m.api_key_fingerprint, m.model,
		COALESCE(u.human_user_id, ''), COALESCE(u.display_name, ''),
		m.created_at, m.updated_at
		FROM llm_model_configs m
		LEFT JOIN human_users u ON u.model_config_id = m.model_config_id`
	if filter.AvailableOnly {
		query += ` WHERE u.human_user_id IS NULL`
	}
	query += ` ORDER BY m.created_at, m.display_name`
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("list LLM models: %w", err)
	}
	defer rows.Close()
	return collectLLMModelConfigs(rows)
}

func (s *Store) GetLLMModelConfig(modelConfigID string) (LLMModelConfig, error) {
	row := s.db.QueryRow(`SELECT m.model_config_id, m.display_name, m.provider, m.base_url,
		m.api_key_enc, m.api_key_fingerprint, m.model,
		COALESCE(u.human_user_id, ''), COALESCE(u.display_name, ''),
		m.created_at, m.updated_at
		FROM llm_model_configs m
		LEFT JOIN human_users u ON u.model_config_id = m.model_config_id
		WHERE m.model_config_id = ?`, strings.TrimSpace(modelConfigID))
	return scanLLMModelConfig(row)
}

func prepareLLMModelConfig(input LLMModelConfigCreate) (LLMModelConfig, error) {
	if strings.TrimSpace(input.DisplayName) == "" || strings.TrimSpace(input.Provider) == "" ||
		strings.TrimSpace(input.BaseURL) == "" || strings.TrimSpace(input.APIKeyEnc) == "" ||
		strings.TrimSpace(input.APIKeyFingerprint) == "" || strings.TrimSpace(input.Model) == "" {
		return LLMModelConfig{}, ErrInvalidLLMModel
	}
	id, err := generateUUIDv4()
	if err != nil {
		return LLMModelConfig{}, fmt.Errorf("generate LLM model ID: %w", err)
	}
	now := time.Now().UTC()
	return LLMModelConfig{
		ModelConfigID: id, DisplayName: strings.TrimSpace(input.DisplayName),
		Provider: strings.TrimSpace(input.Provider), BaseURL: strings.TrimSpace(input.BaseURL),
		APIKeyEnc: input.APIKeyEnc, APIKeyFingerprint: input.APIKeyFingerprint,
		Model: strings.TrimSpace(input.Model), CreatedAt: now, UpdatedAt: now,
	}, nil
}

func insertLLMModelConfig(tx *sql.Tx, model LLMModelConfig) error {
	_, err := tx.Exec(`INSERT INTO llm_model_configs (
		model_config_id, display_name, provider, base_url, api_key_enc,
		api_key_fingerprint, model, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, model.ModelConfigID, model.DisplayName,
		model.Provider, model.BaseURL, model.APIKeyEnc, model.APIKeyFingerprint,
		model.Model, formatTime(model.CreatedAt), formatTime(model.UpdatedAt))
	if err != nil {
		return fmt.Errorf("insert LLM model: %w", err)
	}
	return nil
}

func ensureLLMModelAvailable(tx *sql.Tx, modelConfigID string) error {
	modelConfigID = strings.TrimSpace(modelConfigID)
	if modelConfigID == "" {
		return ErrInvalidLLMModel
	}
	var exists int
	err := tx.QueryRow(`SELECT 1 FROM llm_model_configs WHERE model_config_id = ?`, modelConfigID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("inspect LLM model: %w", err)
	}
	var bound string
	err = tx.QueryRow(`SELECT human_user_id FROM human_users WHERE model_config_id = ?`, modelConfigID).Scan(&bound)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect LLM model binding: %w", err)
	}
	return ErrLLMModelAlreadyBound
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func collectLLMModelConfigs(rows *sql.Rows) ([]LLMModelConfig, error) {
	var models []LLMModelConfig
	for rows.Next() {
		model, err := scanLLMModelConfig(rows)
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, rows.Err()
}

func scanLLMModelConfig(sc scanner) (LLMModelConfig, error) {
	var model LLMModelConfig
	var createdAt, updatedAt string
	err := sc.Scan(&model.ModelConfigID, &model.DisplayName, &model.Provider, &model.BaseURL,
		&model.APIKeyEnc, &model.APIKeyFingerprint, &model.Model, &model.BoundHumanUserID,
		&model.BoundHumanUserName, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return LLMModelConfig{}, ErrNotFound
	}
	if err != nil {
		return LLMModelConfig{}, fmt.Errorf("scan LLM model: %w", err)
	}
	model.CreatedAt, err = parseRequiredTime(createdAt, "llm_model_configs.created_at")
	if err != nil {
		return LLMModelConfig{}, err
	}
	model.UpdatedAt, err = parseRequiredTime(updatedAt, "llm_model_configs.updated_at")
	if err != nil {
		return LLMModelConfig{}, err
	}
	return model, nil
}

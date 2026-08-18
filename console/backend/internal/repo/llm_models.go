package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type LLMModelConfigCreate struct {
	DisplayName   string
	Provider      string
	BaseURL       string
	APIKey        string
	Model         string
	SupportsTools bool
	Thinking      string
}

// LLMModelConfigUpdate 是模型配置的局部更新载荷。仅允许修改运行时可热加载
// 的字段（apiKey / supportsTools / thinking）；provider/baseUrl/model 是模型
// 身份字段，创建后不可变（改了等于换模型，会破坏绑定用户的运行时引用）。
type LLMModelConfigUpdate struct {
	APIKey        string
	SupportsTools *bool
	Thinking      string
}

type LLMModelConfigListFilter struct {
	AvailableOnly bool
}

const llmModelColumns = `m.model_config_id, m.display_name, m.provider, m.base_url,
	m.api_key, m.model, m.last_test_at, m.last_test_ok, m.last_test_error, m.supports_tools,
	m.thinking,
	COALESCE(u.human_user_id, ''), COALESCE(u.display_name, ''),
	m.created_at, m.updated_at`

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
	query := `SELECT ` + llmModelColumns + `
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
	row := s.db.QueryRow(`SELECT `+llmModelColumns+`
		FROM llm_model_configs m
		LEFT JOIN human_users u ON u.model_config_id = m.model_config_id
		WHERE m.model_config_id = ?`, strings.TrimSpace(modelConfigID))
	return scanLLMModelConfig(row)
}

// DeleteLLMModelConfig removes one model configuration. Models bound to an
// existing Human User are refused so running agent assignments stay intact.
func (s *Store) DeleteLLMModelConfig(modelConfigID string) error {
	modelConfigID = strings.TrimSpace(modelConfigID)
	if modelConfigID == "" {
		return ErrInvalidLLMModel
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete LLM model: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := ensureLLMModelAvailable(tx, modelConfigID); err != nil {
		return err
	}
	result, err := tx.Exec(`DELETE FROM llm_model_configs WHERE model_config_id = ?`, modelConfigID)
	if err != nil {
		return fmt.Errorf("delete LLM model: %w", err)
	}
	if err := affectedOrNotFound(result, err, "delete LLM model"); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateLLMModelTestResult persists the latest connectivity-test outcome,
// overwriting any previous result for the model.
func (s *Store) UpdateLLMModelTestResult(modelConfigID string, ok bool, testError string) error {
	_, err := s.db.Exec(`UPDATE llm_model_configs SET last_test_at = ?,
		last_test_ok = ?, last_test_error = ?, updated_at = ? WHERE model_config_id = ?`,
		formatTime(time.Now().UTC()), boolToInt(ok), strings.TrimSpace(testError),
		formatTime(time.Now().UTC()), strings.TrimSpace(modelConfigID))
	if err != nil {
		return fmt.Errorf("update LLM model test result: %w", err)
	}
	return nil
}

func prepareLLMModelConfig(input LLMModelConfigCreate) (LLMModelConfig, error) {
	if strings.TrimSpace(input.DisplayName) == "" || strings.TrimSpace(input.Provider) == "" ||
		strings.TrimSpace(input.BaseURL) == "" || strings.TrimSpace(input.APIKey) == "" ||
		strings.TrimSpace(input.Model) == "" {
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
		APIKey: strings.TrimSpace(input.APIKey),
		Model:  strings.TrimSpace(input.Model), SupportsTools: input.SupportsTools,
		Thinking: normalizeThinking(input.Thinking),
		CreatedAt: now, UpdatedAt: now,
	}, nil
}

func insertLLMModelConfig(tx *sql.Tx, model LLMModelConfig) error {
	_, err := tx.Exec(`INSERT INTO llm_model_configs (
		model_config_id, display_name, provider, base_url, api_key, model, supports_tools, thinking,
		created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, model.ModelConfigID, model.DisplayName,
		model.Provider, model.BaseURL, model.APIKey, model.Model, boolToInt(model.SupportsTools),
		model.Thinking,
		formatTime(model.CreatedAt), formatTime(model.UpdatedAt))
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

// validThinkingLevels 是模型思考档位的合法集合，与 openclaw 的
// agents.list[].thinkingDefault 规范枚举对齐（off/minimal/low/medium/high/xhigh/max）。
var validThinkingLevels = map[string]bool{
	"off": true, "minimal": true, "low": true, "medium": true,
	"high": true, "xhigh": true, "max": true,
}

// defaultThinkingLevel 是缺省档位：off = 关闭思考（贴合脚本型 skill 场景，
// 也避免推理模型 thinking 阶段长时间无 token 触发内网空闲断连）。
const defaultThinkingLevel = "off"

// DefaultThinkingLevel 返回缺省思考档位。
func DefaultThinkingLevel() string {
	return defaultThinkingLevel
}

// normalizeThinking 归一化 thinking 档位；空值回落为 off，非法值返回原样
// （由调用方校验是否合法并报错，避免在 repo 层静默吞掉非法输入）。
func normalizeThinking(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return defaultThinkingLevel
	}
	return trimmed
}

// IsValidThinkingLevel 报告 thinking 档位是否合法。
func IsValidThinkingLevel(value string) bool {
	return validThinkingLevels[normalizeThinking(value)]
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
	var createdAt, updatedAt, lastTestAt string
	var lastTestOK, supportsTools int
	err := sc.Scan(&model.ModelConfigID, &model.DisplayName, &model.Provider, &model.BaseURL,
		&model.APIKey, &model.Model, &lastTestAt, &lastTestOK, &model.LastTestError,
		&supportsTools, &model.Thinking, &model.BoundHumanUserID, &model.BoundHumanUserName,
		&createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return LLMModelConfig{}, ErrNotFound
	}
	if err != nil {
		return LLMModelConfig{}, fmt.Errorf("scan LLM model: %w", err)
	}
	model.LastTestAt, err = parseOptionalTime(lastTestAt, "llm_model_configs.last_test_at")
	if err != nil {
		return LLMModelConfig{}, err
	}
	model.LastTestOK = lastTestOK != 0
	model.SupportsTools = supportsTools != 0
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

// UpdateLLMModelConfig 局部更新一个模型配置（apiKey / supportsTools / thinking）。
// 已绑定用户的模型也可编辑：这三个字段都是运行时热加载字段，改动即时生效、
// 不破坏绑定关系（与「已绑定不可删」不同，删除才是破坏性的）。
func (s *Store) UpdateLLMModelConfig(modelConfigID string, update LLMModelConfigUpdate) (LLMModelConfig, error) {
	modelConfigID = strings.TrimSpace(modelConfigID)
	if modelConfigID == "" {
		return LLMModelConfig{}, ErrInvalidLLMModel
	}
	sets := []string{"updated_at = ?"}
	args := []any{formatTime(time.Now().UTC())}
	if update.APIKey != "" {
		sets = append(sets, "api_key = ?")
		args = append(args, strings.TrimSpace(update.APIKey))
	}
	if update.SupportsTools != nil {
		sets = append(sets, "supports_tools = ?")
		args = append(args, boolToInt(*update.SupportsTools))
	}
	if thinking := strings.TrimSpace(update.Thinking); thinking != "" {
		sets = append(sets, "thinking = ?")
		args = append(args, normalizeThinking(thinking))
	}
	args = append(args, modelConfigID)
	result, err := s.db.Exec(
		`UPDATE llm_model_configs SET `+strings.Join(sets, ", ")+` WHERE model_config_id = ?`,
		args...,
	)
	if err != nil {
		return LLMModelConfig{}, fmt.Errorf("update LLM model: %w", err)
	}
	if err := affectedOrNotFound(result, err, "update LLM model"); err != nil {
		return LLMModelConfig{}, err
	}
	return s.GetLLMModelConfig(modelConfigID)
}

// MarkPodsPendingForModel bumps the desired config generation of every Pod
// whose Human Users are bound to the given model config, marking them pending
// so the runtime coordinator re-renders and re-applies the model's changed
// fields (apiKey / supportsTools / thinking). Returns the affected Pod IDs for
// enqueueing. Unbound models match no rows and are a no-op.
func (s *Store) MarkPodsPendingForModel(modelConfigID string) ([]string, error) {
	modelConfigID = strings.TrimSpace(modelConfigID)
	if modelConfigID == "" {
		return nil, ErrInvalidLLMModel
	}
	rows, err := s.db.Query(
		`UPDATE pods SET config_generation = config_generation + 1,
			last_apply_status = 'pending', last_apply_error = '', updated_at = ?
		 WHERE pod_id IN (
			SELECT DISTINCT pod_id FROM human_users
			WHERE model_config_id = ? AND pod_id != '' AND status != 'deleting'
		 )
		 RETURNING pod_id`,
		formatTime(time.Now().UTC()), modelConfigID,
	)
	if err != nil {
		return nil, fmt.Errorf("mark Pods pending for LLM model: %w", err)
	}
	defer rows.Close()
	return collectPendingPodIDs(rows)
}

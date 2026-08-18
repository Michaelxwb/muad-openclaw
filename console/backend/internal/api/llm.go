package api

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type llmModelInput struct {
	DisplayName   string `json:"displayName"`
	Provider      string `json:"provider"`
	BaseURL       string `json:"baseUrl"`
	APIKey        string `json:"apiKey"`
	Model         string `json:"model"`
	SupportsTools *bool  `json:"supportsTools"` // 缺省 = 支持工具调用（默认开启）
	Thinking      string `json:"thinking"`      // 思考档位，缺省 = off
}

type llmModelBatchRequest struct {
	Models []llmModelInput `json:"models"`
}

type llmModelBatchTestRequest struct {
	ModelConfigIDs []string        `json:"modelConfigIds"`
	Models         []llmModelInput `json:"models"`
}

type llmModelTestResult struct {
	ModelConfigID string `json:"modelConfigId,omitempty"`
	DisplayName   string `json:"displayName"`
	OK            bool   `json:"ok"`
	Error         string `json:"error,omitempty"`
}

func (s *Server) handleListLLMModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.ListLLMModelConfigs(repo.LLMModelConfigListFilter{
		AvailableOnly: r.URL.Query().Get("available") == "true",
	})
	if err != nil {
		writeErr(w, r, errcode.InternalListLLMModels)
		return
	}
	views := make([]map[string]any, 0, len(models))
	for _, model := range models {
		views = append(views, llmModelView(model))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handleCreateLLMModels(w http.ResponseWriter, r *http.Request) {
	var request llmModelBatchRequest
	if err := decodeJSONBody(w, r, &request); err != nil || len(request.Models) == 0 || len(request.Models) > 100 {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	createItems := make([]repo.LLMModelConfigCreate, 0, len(request.Models))
	for _, input := range request.Models {
		create, err := s.prepareLLMModelCreate(input)
		if err != nil {
			writeErr(w, r, errcode.InvalidLLMModel)
			return
		}
		createItems = append(createItems, create)
	}
	models, err := s.store.CreateLLMModelConfigs(createItems)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	views := make([]map[string]any, 0, len(models))
	for _, model := range models {
		views = append(views, llmModelView(model))
	}
	writeJSON(w, http.StatusCreated, map[string]any{"items": views, "total": len(views)})
}

func (s *Server) handleBatchTestLLMModels(w http.ResponseWriter, r *http.Request) {
	var request llmModelBatchTestRequest
	if err := decodeJSONBody(w, r, &request); err != nil || len(request.ModelConfigIDs)+len(request.Models) == 0 {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	targets, err := s.llmModelTestTargets(request)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	results := runLLMModelTests(r, targets)
	for _, result := range results {
		if result.ModelConfigID == "" {
			continue
		}
		if err := s.store.UpdateLLMModelTestResult(result.ModelConfigID, result.OK, result.Error); err != nil {
			log.Printf("llm_model_test_result_failed model=%s error=%v", result.ModelConfigID, err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func (s *Server) handleDeleteLLMModel(w http.ResponseWriter, r *http.Request) {
	modelConfigID := strings.TrimSpace(r.PathValue("modelConfigId"))
	if err := s.store.DeleteLLMModelConfig(modelConfigID); err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "modelConfigId": modelConfigID})
}

type llmModelUpdateRequest struct {
	APIKey        string `json:"apiKey"`
	SupportsTools *bool  `json:"supportsTools"`
	Thinking      string `json:"thinking"`
}

func (s *Server) handleUpdateLLMModel(w http.ResponseWriter, r *http.Request) {
	modelConfigID := strings.TrimSpace(r.PathValue("modelConfigId"))
	if modelConfigID == "" {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	var request llmModelUpdateRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	thinking := strings.TrimSpace(request.Thinking)
	if thinking != "" && !repo.IsValidThinkingLevel(thinking) {
		writeErr(w, r, errcode.InvalidLLMModel)
		return
	}
	update := repo.LLMModelConfigUpdate{
		APIKey:        strings.TrimSpace(request.APIKey),
		SupportsTools: request.SupportsTools,
		Thinking:      thinking,
	}
	model, err := s.store.UpdateLLMModelConfig(modelConfigID, update)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	// 模型配置变更热加载：enqueue 所有绑定该模型的 Pod 的 runtime reconcile，
	// 让 openclaw 的 hot-reload 把新 apiKey/supportsTools/thinking 下发到位。
	s.enqueueModelReconcile(modelConfigID)
	writeJSON(w, http.StatusOK, llmModelView(model))
}

// enqueueModelReconcile 递增引用该模型的 Pod 的 config generation 并入队
// reconcile，让 runtime 重新渲染并下发变更字段（apiKey/supportsTools/thinking）。
// 失败仅记日志：更新已落库，reconcile 会经周期性协调或下一次 apply 收敛。
func (s *Server) enqueueModelReconcile(modelConfigID string) {
	podIDs, err := s.store.MarkPodsPendingForModel(modelConfigID)
	if err != nil {
		log.Printf("llm_model_reconcile_mark_failed model=%s error=%v", modelConfigID, err)
		return
	}
	for _, podID := range podIDs {
		s.enqueueReconcile(podID)
	}
}

type llmModelTestTarget struct {
	ModelConfigID string
	DisplayName   string
	BaseURL       string
	APIKey        string
}

func (s *Server) prepareLLMModelCreate(input llmModelInput) (repo.LLMModelConfigCreate, error) {
	model := llmModelDefinition{
		Provider: input.Provider, BaseURL: input.BaseURL, APIKey: input.APIKey, Model: input.Model,
	}
	if err := validateLLMModelDefinition(model); err != nil {
		return repo.LLMModelConfigCreate{}, err
	}
	displayName := input.DisplayName
	if displayName == "" {
		displayName = input.Provider + "/" + input.Model
	}
	// 支持函数调用默认开启；仅当显式传 supportsTools:false 才关闭。
	supportsTools := true
	if input.SupportsTools != nil {
		supportsTools = *input.SupportsTools
	}
	thinking := strings.TrimSpace(input.Thinking)
	if thinking != "" && !repo.IsValidThinkingLevel(thinking) {
		return repo.LLMModelConfigCreate{}, errors.New("thinking must be one of off/minimal/low/medium/high/xhigh/max")
	}
	return repo.LLMModelConfigCreate{
		DisplayName: displayName, Provider: model.Provider, BaseURL: model.BaseURL,
		APIKey: model.APIKey, Model: model.Model, SupportsTools: supportsTools,
		Thinking: thinking,
	}, nil
}

func (s *Server) llmModelTestTargets(request llmModelBatchTestRequest) ([]llmModelTestTarget, error) {
	targets := make([]llmModelTestTarget, 0, len(request.ModelConfigIDs)+len(request.Models))
	for _, id := range request.ModelConfigIDs {
		model, err := s.store.GetLLMModelConfig(id)
		if err != nil {
			return nil, err
		}
		targets = append(targets, llmModelTestTarget{
			ModelConfigID: model.ModelConfigID, DisplayName: model.DisplayName,
			BaseURL: model.BaseURL, APIKey: model.APIKey,
		})
	}
	for _, input := range request.Models {
		model := llmModelDefinition{
			Provider: input.Provider, BaseURL: input.BaseURL, APIKey: input.APIKey, Model: input.Model,
		}
		if err := validateLLMModelDefinition(model); err != nil {
			return nil, repo.ErrInvalidLLMModel
		}
		targets = append(targets, llmModelTestTarget{
			DisplayName: input.DisplayName, BaseURL: model.BaseURL, APIKey: model.APIKey,
		})
	}
	return targets, nil
}

func runLLMModelTests(r *http.Request, targets []llmModelTestTarget) []llmModelTestResult {
	results := make([]llmModelTestResult, len(targets))
	workers := 4
	if len(targets) < workers {
		workers = len(targets)
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				target := targets[index]
				result := llmModelTestResult{
					ModelConfigID: target.ModelConfigID, DisplayName: target.DisplayName, OK: true,
				}
				if err := llm.Probe(r.Context(), target.BaseURL, target.APIKey); err != nil {
					result.OK = false
					result.Error = err.Error()
				}
				results[index] = result
			}
		}()
	}
	for index := range targets {
		jobs <- index
	}
	close(jobs)
	wg.Wait()
	return results
}

func llmModelThinkingView(thinking string) string {
	if trimmed := strings.TrimSpace(thinking); trimmed != "" {
		return trimmed
	}
	return repo.DefaultThinkingLevel()
}

func llmModelView(model repo.LLMModelConfig) map[string]any {
	lastTestAt := ""
	if !model.LastTestAt.IsZero() {
		lastTestAt = model.LastTestAt.Format(time.RFC3339Nano)
	}
	return map[string]any{
		"modelConfigId": model.ModelConfigID, "displayName": model.DisplayName,
		"provider": model.Provider, "baseUrl": model.BaseURL, "model": model.Model,
		"apiKey":             model.APIKey,
		"supportsTools":      model.SupportsTools,
		"thinking":           llmModelThinkingView(model.Thinking),
		"lastTestAt":         lastTestAt,
		"lastTestOK":         model.LastTestOK,
		"lastTestError":      model.LastTestError,
		"boundHumanUserId":   model.BoundHumanUserID,
		"boundHumanUserName": model.BoundHumanUserName,
		"createdAt":          model.CreatedAt,
		"updatedAt":          model.UpdatedAt,
	}
}

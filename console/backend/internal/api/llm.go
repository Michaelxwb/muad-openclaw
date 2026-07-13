package api

import (
	"net/http"
	"sync"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type llmModelInput struct {
	DisplayName string `json:"displayName"`
	Provider    string `json:"provider"`
	BaseURL     string `json:"baseUrl"`
	APIKey      string `json:"apiKey"`
	Model       string `json:"model"`
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
		writeErr(w, http.StatusInternalServerError, codeInternal, "list LLM models")
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
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	createItems := make([]repo.LLMModelConfigCreate, 0, len(request.Models))
	for _, input := range request.Models {
		create, err := s.prepareLLMModelCreate(input)
		if err != nil {
			writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid LLM model")
			return
		}
		createItems = append(createItems, create)
	}
	models, err := s.store.CreateLLMModelConfigs(createItems)
	if err != nil {
		writeRepoError(w, err)
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
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	targets, err := s.llmModelTestTargets(request)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": runLLMModelTests(r, targets)})
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
	encrypted, err := s.cipher.Encrypt(model.APIKey)
	if err != nil {
		return repo.LLMModelConfigCreate{}, err
	}
	displayName := input.DisplayName
	if displayName == "" {
		displayName = input.Provider + "/" + input.Model
	}
	return repo.LLMModelConfigCreate{
		DisplayName: displayName, Provider: model.Provider, BaseURL: model.BaseURL,
		APIKeyEnc: encrypted, APIKeyFingerprint: secretcrypto.Fingerprint(model.APIKey),
		Model: model.Model,
	}, nil
}

func (s *Server) llmModelTestTargets(request llmModelBatchTestRequest) ([]llmModelTestTarget, error) {
	targets := make([]llmModelTestTarget, 0, len(request.ModelConfigIDs)+len(request.Models))
	for _, id := range request.ModelConfigIDs {
		model, err := s.store.GetLLMModelConfig(id)
		if err != nil {
			return nil, err
		}
		key, err := s.cipher.Decrypt(model.APIKeyEnc)
		if err != nil {
			return nil, err
		}
		targets = append(targets, llmModelTestTarget{
			ModelConfigID: model.ModelConfigID, DisplayName: model.DisplayName,
			BaseURL: model.BaseURL, APIKey: key,
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

func llmModelView(model repo.LLMModelConfig) map[string]any {
	return map[string]any{
		"modelConfigId": model.ModelConfigID, "displayName": model.DisplayName,
		"provider": model.Provider, "baseUrl": model.BaseURL, "model": model.Model,
		"keyConfigured":    model.APIKeyEnc != "",
		"keyFingerprint":   secretcrypto.DisplayFingerprint(model.APIKeyFingerprint),
		"boundHumanUserId": model.BoundHumanUserID, "createdAt": model.CreatedAt,
		"boundHumanUserName": model.BoundHumanUserName,
		"updatedAt":          model.UpdatedAt,
	}
}

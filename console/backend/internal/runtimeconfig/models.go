package runtimeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type modelConfig struct {
	Provider       string `json:"provider"`
	BaseURL        string `json:"baseUrl"`
	APIKey         string `json:"apiKey"`
	Model          string `json:"model"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
}

func (builder *Builder) buildModels(
	data sourceData, users []repo.HumanUser,
) ([]driver.RuntimeProvider, map[string]string, error) {
	providers := make([]driver.RuntimeProvider, 0, len(users)+1)
	models := make(map[string]string, len(users)+1)
	modelPool := modelConfigsByID(data.models)
	for _, user := range users {
		if user.ModelConfigID == "" {
			return nil, nil, wrapInvalid("resolve assigned model", repo.ErrInvalidLLMModel)
		}
		model, err := builder.modelFromConfig(modelPool[user.ModelConfigID])
		if err != nil {
			return nil, nil, err
		}
		provider, ref, err := runtimeProvider("user", user.AgentID, model)
		if err != nil {
			return nil, nil, err
		}
		providers = append(providers, provider)
		models[user.AgentID] = ref
	}
	slices.SortFunc(providers, func(left, right driver.RuntimeProvider) int {
		return strings.Compare(left.ID, right.ID)
	})
	return providers, models, nil
}

func modelConfigsByID(input []repo.LLMModelConfig) map[string]repo.LLMModelConfig {
	output := make(map[string]repo.LLMModelConfig, len(input))
	for _, model := range input {
		output[model.ModelConfigID] = model
	}
	return output
}

func (builder *Builder) modelFromConfig(stored repo.LLMModelConfig) (modelConfig, error) {
	if stored.ModelConfigID == "" {
		return modelConfig{}, wrapInvalid("resolve assigned model", repo.ErrNotFound)
	}
	key, err := builder.cipher.Decrypt(stored.APIKeyEnc)
	if err != nil {
		return modelConfig{}, wrapInvalid("decrypt assigned model", err)
	}
	return modelConfig{
		Provider: stored.Provider, BaseURL: stored.BaseURL, APIKey: key, Model: stored.Model,
		KeyFingerprint: stored.APIKeyFingerprint,
	}, nil
}

func runtimeProvider(scope, owner string, model modelConfig) (driver.RuntimeProvider, string, error) {
	if strings.TrimSpace(model.Provider) == "" || strings.TrimSpace(model.Model) == "" || strings.TrimSpace(model.BaseURL) == "" {
		return driver.RuntimeProvider{}, "", wrapInvalid("resolve model", errors.New("provider, baseUrl and model are required"))
	}
	id := stableProviderID(scope + "-" + owner + "-" + model.Provider)
	provider := driver.RuntimeProvider{
		ID: id, Provider: model.Provider, BaseURL: model.BaseURL,
		APIKey: model.APIKey, Model: model.Model,
	}
	return provider, id + "/" + model.Model, nil
}

func stableProviderID(value string) string {
	var output strings.Builder
	lastDash := false
	for _, char := range strings.ToLower(value) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			output.WriteRune(char)
			lastDash = false
		} else if output.Len() > 0 && !lastDash {
			output.WriteByte('-')
			lastDash = true
		}
	}
	normalized := strings.Trim(output.String(), "-")
	if len(normalized) <= 63 {
		return normalized
	}
	sum := sha256.Sum256([]byte(normalized))
	return strings.TrimRight(normalized[:54], "-") + "-" + hex.EncodeToString(sum[:4])
}

package runtimeconfig

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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
	base, err := builder.globalModel(data.globalLLM)
	if err != nil {
		return nil, nil, err
	}
	podOverride, err := builder.decryptModel(data.pod.LLMOverrideEnc)
	if err != nil {
		return nil, nil, err
	}
	base = mergeModel(base, podOverride)
	providers := make([]driver.RuntimeProvider, 0, len(users)+1)
	models := make(map[string]string, len(users)+1)
	if !base.empty() {
		provider, ref, err := runtimeProvider("pod", "default", base)
		if err != nil {
			return nil, nil, err
		}
		providers = append(providers, provider)
		models["main"] = ref
	}
	for _, user := range users {
		if user.ModelOverrideEnc == "" {
			models[user.AgentID] = models["main"]
			continue
		}
		override, err := builder.decryptModel(user.ModelOverrideEnc)
		if err != nil {
			return nil, nil, err
		}
		effective := mergeModel(base, override)
		provider, ref, err := runtimeProvider("user", user.AgentID, effective)
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

func (builder *Builder) globalModel(stored repo.LLMGlobal) (modelConfig, error) {
	model := modelConfig{Provider: stored.Provider, BaseURL: stored.BaseURL, Model: stored.Model}
	if stored.APIKeyEnc == "" {
		return model, nil
	}
	key, err := builder.cipher.Decrypt(stored.APIKeyEnc)
	if err != nil {
		return modelConfig{}, wrapInvalid("decrypt global model", err)
	}
	model.APIKey = key
	return model, nil
}

func (builder *Builder) decryptModel(encrypted string) (modelConfig, error) {
	if encrypted == "" {
		return modelConfig{}, nil
	}
	plain, err := builder.cipher.Decrypt(encrypted)
	if err != nil {
		return modelConfig{}, wrapInvalid("decrypt model override", err)
	}
	decoder := json.NewDecoder(bytes.NewBufferString(plain))
	decoder.DisallowUnknownFields()
	var model modelConfig
	if err := decoder.Decode(&model); err != nil {
		return modelConfig{}, wrapInvalid("decode model override", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return modelConfig{}, wrapInvalid("decode model override", errors.New("trailing JSON value"))
	}
	return model, nil
}

func mergeModel(base, override modelConfig) modelConfig {
	merged := base
	applyModelField(&merged.Provider, override.Provider)
	applyModelField(&merged.BaseURL, override.BaseURL)
	applyModelField(&merged.APIKey, override.APIKey)
	applyModelField(&merged.Model, override.Model)
	applyModelField(&merged.KeyFingerprint, override.KeyFingerprint)
	return merged
}

func applyModelField(target *string, value string) {
	if value = strings.TrimSpace(value); value != "" {
		*target = value
	}
}

func (model modelConfig) empty() bool {
	return model.Provider == "" && model.BaseURL == "" && model.APIKey == "" && model.Model == ""
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

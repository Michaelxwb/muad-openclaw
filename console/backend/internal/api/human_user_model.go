package api

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var modelProviderPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

type llmModelDefinition struct {
	Provider       string `json:"provider"`
	BaseURL        string `json:"baseUrl"`
	APIKey         string `json:"apiKey"`
	Model          string `json:"model"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
}

func validateLLMModelDefinition(model llmModelDefinition) error {
	if !modelProviderPattern.MatchString(model.Provider) || strings.TrimSpace(model.Model) == "" ||
		len(model.Model) > 256 || len(model.APIKey) > 4096 {
		return errors.New("invalid model fields")
	}
	parsed, err := url.Parse(model.BaseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("invalid model base URL")
	}
	return nil
}

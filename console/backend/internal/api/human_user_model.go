package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

var modelProviderPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

type modelOverride struct {
	Provider       string `json:"provider"`
	BaseURL        string `json:"baseUrl"`
	APIKey         string `json:"apiKey"`
	Model          string `json:"model"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
}

type modelOverrideRequest struct {
	Clear    bool    `json:"clear"`
	Provider *string `json:"provider"`
	BaseURL  *string `json:"baseUrl"`
	APIKey   *string `json:"apiKey"`
	Model    *string `json:"model"`
}

func (s *Server) handleSetHumanUserModel(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request modelOverrideRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	current, err := s.decodeModelOverride(user.ModelOverrideEnc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode model override")
		return
	}
	next, encrypted, err := s.prepareModelOverride(current, request)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid model override")
		return
	}
	if next != current {
		if err := s.store.UpdateHumanUserModelOverride(user.HumanUserID, encrypted); err != nil {
			writeRepoError(w, err)
			return
		}
		s.enqueueReconcile(user.PodID)
		s.auditHumanUser(r, auditlog.ActionHumanUserUpdate, user, "model")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"humanUserId": user.HumanUserID, "modelOverride": modelToView(next),
	})
}

func (s *Server) prepareModelOverride(
	current modelOverride, request modelOverrideRequest,
) (modelOverride, string, error) {
	next, err := applyModelOverrideRequest(current, request)
	if err != nil || next == (modelOverride{}) {
		return next, "", err
	}
	raw, err := marshalCanonical(next)
	if err != nil {
		return modelOverride{}, "", err
	}
	encrypted, err := s.cipher.Encrypt(string(raw))
	return next, encrypted, err
}

func applyModelOverrideRequest(
	current modelOverride, request modelOverrideRequest,
) (modelOverride, error) {
	if request.Clear {
		if request.Provider != nil || request.BaseURL != nil || request.APIKey != nil || request.Model != nil {
			return modelOverride{}, errors.New("clear cannot be combined with fields")
		}
		return modelOverride{}, nil
	}
	if request.Provider == nil && request.BaseURL == nil && request.APIKey == nil && request.Model == nil {
		return modelOverride{}, errors.New("model update is empty")
	}
	next := current
	applyOptionalString(&next.Provider, request.Provider)
	applyOptionalString(&next.BaseURL, request.BaseURL)
	applyOptionalString(&next.Model, request.Model)
	if request.APIKey != nil {
		next.APIKey = strings.TrimSpace(*request.APIKey)
		if next.APIKey == "" {
			return modelOverride{}, errors.New("API key cannot be empty")
		}
		next.KeyFingerprint = secretcrypto.Fingerprint(next.APIKey)
	}
	if err := validateModelOverride(next); err != nil {
		return modelOverride{}, err
	}
	return next, nil
}

func (s *Server) decodeModelOverride(encrypted string) (modelOverride, error) {
	if encrypted == "" {
		return modelOverride{}, nil
	}
	plain, err := s.cipher.Decrypt(encrypted)
	if err != nil {
		return modelOverride{}, err
	}
	var model modelOverride
	if err := decodeDocument([]byte(plain), &model); err != nil {
		return modelOverride{}, err
	}
	if model.APIKey != "" && model.KeyFingerprint == "" {
		model.KeyFingerprint = secretcrypto.Fingerprint(model.APIKey)
	}
	return model, validateModelOverride(model)
}

func validateModelOverride(model modelOverride) error {
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

func applyOptionalString(target *string, value *string) {
	if value != nil {
		*target = strings.TrimSpace(*value)
	}
}

func marshalCanonical(value any) ([]byte, error) {
	return json.Marshal(value)
}

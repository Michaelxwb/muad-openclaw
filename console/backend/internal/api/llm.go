package api

import (
	"errors"
	"net/http"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// llmRequest remains for legacy, unrouted container helpers until cleanup.
type llmRequest struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
}

func (s *Server) handleGetLLM(w http.ResponseWriter, _ *http.Request) {
	model, configured, err := s.readGlobalModel()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "read LLM configuration")
		return
	}
	if !configured {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false, "apiKeyConfigured": false})
		return
	}
	writeJSON(w, http.StatusOK, globalModelView(model))
}

func (s *Server) handleSetLLM(w http.ResponseWriter, r *http.Request) {
	current, _, err := s.readGlobalModel()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "read LLM configuration")
		return
	}
	var request modelOverrideRequest
	if err := decodeJSONBody(w, r, &request); err != nil || request.Clear {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	next, err := applyModelOverrideRequest(current, request)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid LLM configuration")
		return
	}
	if next == current {
		writeJSON(w, http.StatusOK, globalModelView(next))
		return
	}
	if err := llm.Probe(r.Context(), next.BaseURL, next.APIKey); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "LLM connectivity test failed")
		return
	}
	encryptedKey, err := s.encryptOptionalKey(next.APIKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "encrypt LLM key")
		return
	}
	podIDs, err := s.store.SetLLMGlobalAndMarkPods(repo.LLMGlobal{
		Provider: next.Provider, BaseURL: next.BaseURL, APIKeyEnc: encryptedKey, Model: next.Model,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "save LLM configuration")
		return
	}
	s.enqueuePodIDs(podIDs)
	writeJSON(w, http.StatusOK, globalModelView(next))
}

func (s *Server) handleTestLLM(w http.ResponseWriter, r *http.Request) {
	var request llmRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	model := modelOverride{
		Provider: request.Provider, BaseURL: request.BaseURL, APIKey: request.APIKey, Model: request.Model,
	}
	if err := validateModelOverride(model); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid LLM configuration")
		return
	}
	if err := llm.Probe(r.Context(), model.BaseURL, model.APIKey); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "LLM connectivity test failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGetPodLLM(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	model, err := s.decodeModelOverride(pod.LLMOverrideEnc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode Pod model override")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": pod.PodID, "configured": pod.LLMOverrideEnc != "", "modelOverride": modelToView(model),
	})
}

func (s *Server) handleSetPodLLM(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request modelOverrideRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	current, err := s.decodeModelOverride(pod.LLMOverrideEnc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode Pod model override")
		return
	}
	next, encrypted, err := s.prepareModelOverride(current, request)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Pod model override")
		return
	}
	if next != current {
		update := podUpdateFrom(pod)
		update.LLMOverrideEnc = encrypted
		if err := s.store.UpdatePod(pod.PodID, update); err != nil {
			writeRepoError(w, err)
			return
		}
		s.enqueueReconcile(pod.PodID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": pod.PodID, "configured": encrypted != "", "modelOverride": modelToView(next),
	})
}

func (s *Server) readGlobalModel() (modelOverride, bool, error) {
	global, err := s.store.GetLLMGlobal()
	if errors.Is(err, repo.ErrNotFound) {
		return modelOverride{}, false, nil
	}
	if err != nil {
		return modelOverride{}, false, err
	}
	key := ""
	if global.APIKeyEnc != "" {
		key, err = s.cipher.Decrypt(global.APIKeyEnc)
		if err != nil {
			return modelOverride{}, false, err
		}
	}
	model := modelOverride{
		Provider: global.Provider, BaseURL: global.BaseURL, APIKey: key, Model: global.Model,
	}
	if key != "" {
		model.KeyFingerprint = secretcrypto.Fingerprint(key)
	}
	return model, true, validateModelOverride(model)
}

func globalModelView(model modelOverride) map[string]any {
	return map[string]any{
		"configured": true, "provider": model.Provider, "baseUrl": model.BaseURL,
		"model": model.Model, "apiKeyConfigured": model.APIKey != "",
		"keyFingerprint": secretcrypto.DisplayFingerprint(model.KeyFingerprint),
	}
}

func (s *Server) encryptOptionalKey(key string) (string, error) {
	if key == "" {
		return "", nil
	}
	return s.cipher.Encrypt(key)
}

package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type llmRequest struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
}

// handleGetLLM returns the global LLM config with the key never exposed (API-05).
func (s *Server) handleGetLLM(w http.ResponseWriter, r *http.Request) {
	g, err := s.store.GetLLMGlobal()
	if errors.Is(err, repo.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "read llm config")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"provider":   g.Provider,
		"baseUrl":    g.BaseURL,
		"model":      g.Model,
	})
}

// handleSetLLM re-tests connectivity then persists the global LLM (API-06/E-02).
func (s *Server) handleSetLLM(w http.ResponseWriter, r *http.Request) {
	var req llmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if err := llm.Probe(r.Context(), req.BaseURL, req.APIKey); err != nil {
		writeErr(w, http.StatusBadRequest, 40002, "connectivity test failed: "+err.Error())
		return
	}
	enc, err := s.cipher.Encrypt(req.APIKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "encrypt key")
		return
	}
	if err := s.store.SetLLMGlobal(repo.LLMGlobal{
		Provider: req.Provider, BaseURL: req.BaseURL, APIKeyEnc: enc, Model: req.Model,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "save llm config")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true})
}

// handleTestLLM probes connectivity without persisting (API-07).
func (s *Server) handleTestLLM(w http.ResponseWriter, r *http.Request) {
	var req llmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if err := llm.Probe(r.Context(), req.BaseURL, req.APIKey); err != nil {
		writeErr(w, http.StatusBadRequest, 40002, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSetUserLLM stores an encrypted per-user LLM override (API-08).
func (s *Server) handleSetUserLLM(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if _, err := s.store.GetUser(userID); errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "read user")
		return
	}
	var req llmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	// 覆盖必须先通过连通性测试：测的是实际生效配置（global ⊕ override）。
	eff, err := s.effectiveLLM(&req)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "resolve effective llm")
		return
	}
	if err := llm.Probe(r.Context(), eff.BaseURL, eff.APIKey); err != nil {
		writeErr(w, http.StatusBadRequest, 40002, "connectivity test failed: "+err.Error())
		return
	}
	enc, err := s.encodeOverride(req)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "encode override")
		return
	}
	if err := s.store.UpdateUserLLMOverride(userID, enc); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "save override")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

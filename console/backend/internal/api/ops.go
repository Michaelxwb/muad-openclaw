package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/llm"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// handleAction runs a lifecycle action on a container (API-09, FEAT-09).
func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	action := r.PathValue("action")
	if _, err := s.store.GetUser(userID); errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	}

	var (
		err      error
		newState string
	)
	switch action {
	case "start":
		err, newState = s.drv.Start(r.Context(), userID), "running"
	case "stop":
		err, newState = s.drv.Stop(r.Context(), userID), "stopped"
	case "restart":
		err, newState = s.drv.Restart(r.Context(), userID), "running"
	case "reap":
		err, newState = s.drv.Reap(r.Context(), userID), "archived"
	case "revive":
		err, newState = s.drv.Revive(r.Context(), userID), "running"
	default:
		writeErr(w, http.StatusBadRequest, 40001, "unknown action: "+action)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, action+" failed: "+err.Error())
		return
	}
	_ = s.store.UpdateUserState(userID, newState)
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "state": newState})
}

// handleSkillsReload fans out a reload to selected running containers (API-10,
// FEAT-10). Without an openclaw reload primitive, the reliable trigger is a
// rolling restart — the explicit fallback when filesystem watch is unreliable
// (RISK-07). Restarts are sequential to avoid taking the whole fleet down at once.
func (s *Server) handleSkillsReload(w http.ResponseWriter, r *http.Request) {
	var req applyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}
	if len(req.UserIDs) == 0 {
		writeErr(w, http.StatusBadRequest, 40001, "userIds must not be empty")
		return
	}
	infos, err := s.drv.List(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "list containers")
		return
	}
	selected := map[string]bool{}
	for _, id := range req.UserIDs {
		selected[id] = true
	}
	results := map[string]string{}
	for _, info := range infos {
		if !selected[info.UserID] {
			continue
		}
		if info.State != "running" {
			results[info.UserID] = "skipped: not running"
			continue
		}
		if err := s.drv.Restart(r.Context(), info.UserID); err != nil {
			results[info.UserID] = "failed: " + err.Error()
		} else {
			results[info.UserID] = "reloaded"
		}
	}
	for _, id := range req.UserIDs {
		if _, ok := results[id]; !ok {
			results[id] = "not found"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

type applyRequest struct {
	UserIDs []string `json:"userIds"`
}

// handleApplyLLM re-applies the current global LLM to selected existing
// containers via rolling recreate (API-11, FEAT-11, RULE-03).
func (s *Server) handleApplyLLM(w http.ResponseWriter, r *http.Request) {
	var req applyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, 40001, "invalid request body")
		return
	}

	results := map[string]string{}
	users := make([]repo.User, 0, len(req.UserIDs))
	for _, id := range req.UserIDs {
		u, err := s.store.GetUser(id)
		if errors.Is(err, repo.ErrNotFound) {
			results[id] = "not found"
			continue
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, 50001, "read user "+id)
			return
		}
		users = append(users, u)
	}

	// Connectivity gate (test before apply): probe each user's *effective* config
	// (global ⊕ override), not just the global. All must pass before any recreate.
	// Dedup by endpoint+key so the common case (everyone on global) probes once.
	gate := map[string]error{}
	for _, u := range users {
		eff, err := s.effectiveLLMForUser(u)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, 50001, "resolve effective llm for "+u.UserID)
			return
		}
		key := eff.BaseURL + "\x00" + eff.APIKey
		if _, done := gate[key]; !done {
			gate[key] = llm.Probe(r.Context(), eff.BaseURL, eff.APIKey)
		}
		if gate[key] != nil {
			writeErr(w, http.StatusBadRequest, 40002,
				"connectivity test failed for "+u.UserID+": "+gate[key].Error())
			return
		}
	}

	for _, u := range users {
		if err := s.recreateUser(r.Context(), u, u.ImageTag); err != nil {
			results[u.UserID] = "failed: " + err.Error()
		} else {
			results[u.UserID] = "applied"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

type upgradeRequest struct {
	ImageTag string `json:"imageTag"`
}

// handleUpgrade recreates a container on a new image tag, preserving its state
// volume (API-13, FEAT-14).
func (s *Server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	var req upgradeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ImageTag == "" {
		writeErr(w, http.StatusBadRequest, 40001, "imageTag is required")
		return
	}
	u, err := s.store.GetUser(userID)
	if errors.Is(err, repo.ErrNotFound) {
		writeErr(w, http.StatusNotFound, 40401, "user not found")
		return
	}
	if err := s.recreateUser(r.Context(), u, req.ImageTag); err != nil {
		writeErr(w, http.StatusInternalServerError, 50001, "upgrade failed: "+err.Error())
		return
	}
	_ = s.store.UpdateUserImageTag(userID, req.ImageTag)
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "imageTag": req.ImageTag})
}

// --- recreate helpers (shared by apply-LLM and upgrade) ---

// recreateUser removes (keeping state) and re-creates a container from its
// stored record, picking up the current global LLM and the given image tag.
func (s *Server) recreateUser(ctx context.Context, u repo.User, imageTag string) error {
	spec, err := s.specFromUser(u, imageTag)
	if err != nil {
		return err
	}
	if err := s.drv.Remove(ctx, u.UserID, true); err != nil {
		return err
	}
	return s.drv.Create(ctx, spec, randomToken())
}

// specFromUser rebuilds a driver spec from a stored user record (decrypting
// override, merging with the current global LLM).
func (s *Server) specFromUser(u repo.User, imageTag string) (driver.UserSpec, error) {
	eff, err := s.effectiveLLMForUser(u)
	if err != nil {
		return driver.UserSpec{}, err
	}
	mem, cpu, restart, err := s.resolveResources(u)
	if err != nil {
		return driver.UserSpec{}, err
	}
	return driver.UserSpec{
		UserID:         u.UserID,
		Channels:       parseChannelList(u.Channels),
		ChannelConfigs: s.parseChannelConfigs(u.ChannelConfigs),
		ImageTag:       imageTag,
		LLM:            eff,
		MemLimit:       mem,
		CPULimit:       cpu,
		RestartPolicy:  restart,
	}, nil
}

// effectiveLLMForUser resolves a stored user's effective LLM config
// (global ⊕ decrypted per-user override).

// parseChannelList returns the channel list from stored JSON.
func parseChannelList(channelsJSON string) []string {
	var chs []string
	if channelsJSON != "" {
		json.Unmarshal([]byte(channelsJSON), &chs)
	}
	if chs == nil {
		chs = []string{}
	}
	return chs
}

// parseChannelConfigs returns decoded channel configs from stored JSON,
// with secrets decrypted so they can be injected as plain text into the container.
func (s *Server) parseChannelConfigs(configsJSON string) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if configsJSON != "" {
		json.Unmarshal([]byte(configsJSON), &out)
	}
	// Decrypt secrets for runtime injection (container expects plain text).
	for ch, cfg := range out {
		if ch == driver.ChannelWeCom {
			var w struct {
				BotID  string `json:"botId"`
				Secret string `json:"secret"`
			}
			if err := json.Unmarshal(cfg, &w); err == nil && w.Secret != "" {
				plain, err := s.cipher.Decrypt(w.Secret)
				if err == nil {
					w.Secret = plain
					b, _ := json.Marshal(w)
					out[ch] = json.RawMessage(b)
				}
			}
		}
	}
	return out
}

func (s *Server) effectiveLLMForUser(u repo.User) (driver.LlmConfig, error) {
	var override *llmRequest
	if u.LLMOverride != "" {
		o, err := s.decodeOverride(u.LLMOverride)
		if err != nil {
			return driver.LlmConfig{}, err
		}
		override = &o
	}
	return s.effectiveLLM(override)
}

func (s *Server) decodeOverride(enc string) (llmRequest, error) {
	raw, err := s.cipher.Decrypt(enc)
	if err != nil {
		return llmRequest{}, err
	}
	var o llmRequest
	if err := json.Unmarshal([]byte(raw), &o); err != nil {
		return llmRequest{}, err
	}
	return o, nil
}

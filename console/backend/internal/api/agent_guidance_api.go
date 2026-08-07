package api

import (
	"net/http"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type agentGuidanceView struct {
	UserSkill string    `json:"userSkill"`
	Memory    string    `json:"memory"`
	Main      string    `json:"main"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type agentGuidanceInput struct {
	UserSkill string `json:"userSkill"`
	Memory    string `json:"memory"`
	Main      string `json:"main"`
}

// handleGetAgentGuidance returns the admin-configured agent workspace guidance;
// empty fields mean the runtime renderer uses its built-in defaults.
func (s *Server) handleGetAgentGuidance(w http.ResponseWriter, r *http.Request) {
	guidance, err := s.store.GetAgentGuidance()
	if err != nil {
		writeErr(w, r, errcode.InternalReadAgentGuidance)
		return
	}
	writeJSON(w, http.StatusOK, agentGuidanceView{
		UserSkill: guidance.UserSkill, Memory: guidance.Memory, Main: guidance.Main,
		UpdatedAt: guidance.UpdatedAt,
	})
}

// handleSetAgentGuidance persists the guidance and re-applies every Pod so the
// runtime renderer rewrites AGENTS.md / BOOTSTRAP.md without an image rebuild.
func (s *Server) handleSetAgentGuidance(w http.ResponseWriter, r *http.Request) {
	var input agentGuidanceInput
	if err := decodeJSONBody(w, r, &input); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	if err := s.store.SetAgentGuidance(repo.AgentGuidance{
		UserSkill: input.UserSkill, Memory: input.Memory, Main: input.Main,
	}); err != nil {
		writeRepoError(w, r, err)
		return
	}
	podIDs, err := s.store.MarkAllPodsConfigPending()
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	for _, podID := range podIDs {
		s.enqueueReconcile(podID)
	}
	guidance, err := s.store.GetAgentGuidance()
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, agentGuidanceView{
		UserSkill: guidance.UserSkill, Memory: guidance.Memory, Main: guidance.Main,
		UpdatedAt: guidance.UpdatedAt,
	})
}

package api

import (
	"net/http"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
)

type attachHumanUsersRequest struct {
	HumanUserIDs    []string `json:"humanUserIds"`
	ConfirmNoMemory bool     `json:"confirmNoMemory"`
}

// handleAttachHumanUsers binds previously unbound Human Users to a Pod. Only
// unbound users (their previous Pod was deleted) may be attached; attaching
// users whose last Pod differs requires confirmNoMemory because the target
// Pod's PVC has no memory or usage records for them.
func (s *Server) handleAttachHumanUsers(w http.ResponseWriter, r *http.Request) {
	podID := r.PathValue("podId")
	if _, err := s.store.GetPod(podID); err != nil {
		writeRepoError(w, err)
		return
	}
	var request attachHumanUsersRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	if len(request.HumanUserIDs) == 0 {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "humanUserIds is required")
		return
	}
	for _, humanUserID := range request.HumanUserIDs {
		user, err := s.store.GetHumanUser(humanUserID)
		if err != nil {
			writeRepoError(w, err)
			return
		}
		if user.PodID != "" {
			writeErr(w, http.StatusConflict, codePodStateConflict, "only unbound Human Users can be attached")
			return
		}
		if user.LastPodID != "" && user.LastPodID != podID && !request.ConfirmNoMemory {
			writeErr(w, http.StatusBadRequest, codeInvalidField,
				"attaching to a different Pod requires confirmNoMemory")
			return
		}
	}
	attached, err := s.store.AttachUsers(request.HumanUserIDs, podID,
		s.cfg.RuntimeDefaults.BrowserCDPPortStart, s.cfg.RuntimeDefaults.BrowserCDPPortEnd)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(podID)
	for _, user := range attached {
		s.auditHumanUser(r, auditlog.ActionHumanUserUpdate, user, "attached")
	}
	writeJSON(w, http.StatusOK, map[string]any{"podId": podID, "attached": len(attached)})
}

// restorePodUsers attaches the unbound users whose last Pod matches podID. A
// recreated Pod with the same id restores them automatically so agent_id and
// memory (on the retained state PVC) link back before the first apply.
func (s *Server) restorePodUsers(podID string) error {
	users, err := s.store.ListRestorableHumanUsers(podID)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return nil
	}
	humanUserIDs := make([]string, len(users))
	for i, user := range users {
		humanUserIDs[i] = user.HumanUserID
	}
	_, err = s.store.AttachUsers(humanUserIDs, podID,
		s.cfg.RuntimeDefaults.BrowserCDPPortStart, s.cfg.RuntimeDefaults.BrowserCDPPortEnd)
	if err != nil {
		return err
	}
	return nil
}

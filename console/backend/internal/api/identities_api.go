package api

import (
	"log"
	"net/http"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type patchIdentityRequest struct {
	Status string `json:"status"`
}

func (s *Server) handleCreateIdentity(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	pod, err := s.store.GetPod(user.PodID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request identityInput
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	identity, err := normalizeIdentityInput(pod, request)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	identity.HumanUserID, identity.PodID = user.HumanUserID, user.PodID
	created, err := s.store.CreateIdentity(identity)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(user.PodID)
	s.auditIdentity(r, auditlog.ActionIdentityCreate, created, "active")
	writeJSON(w, http.StatusCreated, identityToView(created))
}

func (s *Server) handlePatchIdentity(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.identityForPath(w, r)
	if !ok {
		return
	}
	var request patchIdentityRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	request.Status = strings.TrimSpace(request.Status)
	if request.Status != repo.IdentityStatusActive && request.Status != repo.IdentityStatusDisabled {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Identity status")
		return
	}
	if request.Status != identity.Status {
		if err := s.store.UpdateIdentityStatus(identity.IdentityID, request.Status); err != nil {
			writeRepoError(w, err)
			return
		}
		s.enqueueReconcile(identity.PodID)
		s.auditIdentity(r, auditlog.ActionIdentityUpdate, identity, request.Status)
	}
	updated, err := s.store.GetIdentity(identity.IdentityID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identityToView(updated))
}

func (s *Server) handleDeleteIdentity(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.identityForPath(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteIdentity(identity.IdentityID); err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(identity.PodID)
	s.auditIdentity(r, auditlog.ActionIdentityDelete, identity, "deleted")
	writeJSON(w, http.StatusOK, map[string]any{
		"humanUserId": identity.HumanUserID, "identityId": identity.IdentityID, "deleted": true,
	})
}

func (s *Server) identityForPath(w http.ResponseWriter, r *http.Request) (repo.UserIdentity, bool) {
	identity, err := s.store.GetIdentity(r.PathValue("identityId"))
	if err != nil {
		writeRepoError(w, err)
		return repo.UserIdentity{}, false
	}
	if identity.HumanUserID != r.PathValue("humanUserId") {
		writeErr(w, http.StatusNotFound, codeNotFound, "resource not found")
		return repo.UserIdentity{}, false
	}
	return identity, true
}

func (s *Server) auditIdentity(
	r *http.Request, action auditlog.Action, identity repo.UserIdentity, status string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: identity.IdentityID,
		Metadata: auditlog.Metadata{
			PodID: identity.PodID, HumanUserID: identity.HumanUserID,
			IdentityID: identity.IdentityID, Status: status,
		},
	})
	if err != nil {
		log.Printf("identity_audit_failed id=%s action=%s error=%v", identity.IdentityID, action, err)
	}
}

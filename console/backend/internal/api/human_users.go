package api

import (
	"errors"
	"log"
	"net/http"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type patchHumanUserRequest struct {
	DisplayName *string `json:"displayName"`
	Status      *string `json:"status"`
	Notes       *string `json:"notes"`
}

func (s *Server) handleCreateHumanUser(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request createHumanUserRequest
	if err := decodeJSONBody(w, r, &request); err != nil || !validHumanUserCreateRequest(request) {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid Human User request")
		return
	}
	agentID, err := resolveAgentID(request.AgentID, request.DisplayName)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "generate agent ID")
		return
	}
	user := repo.HumanUser{
		PodID: pod.PodID, DisplayName: strings.TrimSpace(request.DisplayName),
		AgentID: agentID, BrowserProfile: agentID, Notes: request.Notes,
	}
	result, err := s.bootstrapHumanUser(pod, user, request)
	if err != nil {
		s.writeHumanUserCreateError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditHumanUser(r, auditlog.ActionHumanUserCreate, result.HumanUser, "created")
	s.writeHumanUserBootstrap(w, result)
}

func validHumanUserCreateRequest(request createHumanUserRequest) bool {
	displayName := strings.TrimSpace(request.DisplayName)
	return displayName != "" && len(displayName) <= 128 && len(request.Notes) <= 4000 &&
		(request.Identity == nil) != (request.Activation == nil)
}

func (s *Server) bootstrapHumanUser(
	pod repo.Pod, user repo.HumanUser, request createHumanUserRequest,
) (repo.HumanUserBootstrapResult, error) {
	start, end := s.cfg.RuntimeDefaults.BrowserCDPPortStart, s.cfg.RuntimeDefaults.BrowserCDPPortEnd
	if request.Identity != nil {
		identity, err := normalizeIdentityInput(pod, *request.Identity)
		if err != nil {
			return repo.HumanUserBootstrapResult{}, err
		}
		return s.store.CreateHumanUserWithIdentity(user, identity, start, end)
	}
	if s.bindingCodec == nil {
		return repo.HumanUserBootstrapResult{}, errors.New("binding codec unavailable")
	}
	binding, err := normalizeActivationInput(pod, *request.Activation)
	if err != nil {
		return repo.HumanUserBootstrapResult{}, err
	}
	return s.store.CreateHumanUserWithBindingCode(s.bindingCodec, user, binding, start, end)
}

func (s *Server) writeHumanUserCreateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repo.ErrPodCapacity), errors.Is(err, repo.ErrHumanUserExists),
		errors.Is(err, repo.ErrIdentityExists):
		writeRepoError(w, err)
	case errors.Is(err, repo.ErrInvalidHumanUser), errors.Is(err, repo.ErrInvalidBindingCode):
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Human User configuration")
	default:
		writeErr(w, http.StatusInternalServerError, codeInternal, "create Human User")
	}
}

func (s *Server) writeHumanUserBootstrap(w http.ResponseWriter, result repo.HumanUserBootstrapResult) {
	view, err := s.makeHumanUserView(result.HumanUser, boolToInt(result.Identity != nil))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "render Human User")
		return
	}
	data := map[string]any{"humanUser": view}
	if result.Identity != nil {
		data["identity"] = identityToView(*result.Identity)
	}
	if result.BindingCode != nil {
		data["activation"] = map[string]any{
			"bindingCodeId": result.BindingCode.BindingCodeID, "code": result.PlainCode,
			"expiresAt": result.BindingCode.ExpiresAt,
		}
	}
	writeJSON(w, http.StatusCreated, data)
}

func (s *Server) handleListHumanUsers(w http.ResponseWriter, r *http.Request) {
	podID := r.PathValue("podId")
	if _, err := s.store.GetPod(podID); err != nil {
		writeRepoError(w, err)
		return
	}
	page, pageSize := parsePodPagination(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validHumanUserStatus(status) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Human User status")
		return
	}
	users, total, err := s.store.ListHumanUsersByPod(podID, repo.HumanUserListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize, Status: status,
		Query: strings.TrimSpace(r.URL.Query().Get("q")),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Human Users")
		return
	}
	identities, err := s.store.ListIdentitiesByPod(podID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Human User identities")
		return
	}
	views, err := s.makeHumanUserViews(users, identityCounts(identities))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "render Human Users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": views, "total": total, "page": page, "pageSize": pageSize,
	})
}

func (s *Server) handleGetHumanUser(w http.ResponseWriter, r *http.Request) {
	s.writeHumanUserDetail(w, r.PathValue("humanUserId"), http.StatusOK)
}

func (s *Server) writeHumanUserDetail(w http.ResponseWriter, humanUserID string, status int) {
	user, err := s.store.GetHumanUser(humanUserID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	identities, err := s.store.ListIdentitiesByHumanUser(humanUserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Human User identities")
		return
	}
	view, err := s.makeHumanUserView(user, len(identities))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "render Human User")
		return
	}
	identityViews := make([]identityView, 0, len(identities))
	for _, identity := range identities {
		identityViews = append(identityViews, identityToView(identity))
	}
	writeJSON(w, status, map[string]any{"humanUser": view, "identities": identityViews})
}

func (s *Server) handlePatchHumanUser(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request patchHumanUserRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	update, changed, stateChanged, err := s.humanUserPatch(user, request)
	if err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Human User update")
		return
	}
	if changed {
		if err := s.store.UpdateHumanUser(user.HumanUserID, update); err != nil {
			writeRepoError(w, err)
			return
		}
		if stateChanged {
			s.enqueueReconcile(user.PodID)
		}
		s.auditHumanUser(r, auditlog.ActionHumanUserUpdate, user, update.Status)
	}
	s.writeHumanUserDetail(w, user.HumanUserID, http.StatusOK)
}

func (s *Server) humanUserPatch(
	user repo.HumanUser, request patchHumanUserRequest,
) (repo.HumanUserUpdate, bool, bool, error) {
	update := repo.HumanUserUpdate{DisplayName: user.DisplayName, Status: user.Status, Notes: user.Notes}
	if request.DisplayName != nil {
		update.DisplayName = strings.TrimSpace(*request.DisplayName)
	}
	if request.Status != nil {
		update.Status = strings.TrimSpace(*request.Status)
	}
	if request.Notes != nil {
		update.Notes = *request.Notes
	}
	if update.DisplayName == "" || len(update.DisplayName) > 128 || len(update.Notes) > 4000 ||
		!validHumanUserStatus(update.Status) || update.Status == repo.HumanUserStatusDeleting {
		return repo.HumanUserUpdate{}, false, false, errors.New("invalid mutable fields")
	}
	if err := s.validateHumanUserStatus(user, update.Status); err != nil {
		return repo.HumanUserUpdate{}, false, false, err
	}
	changed := update.DisplayName != user.DisplayName || update.Status != user.Status || update.Notes != user.Notes
	return update, changed, update.Status != user.Status, nil
}

func (s *Server) validateHumanUserStatus(user repo.HumanUser, next string) error {
	if user.Status == repo.HumanUserStatusDeleting {
		return errors.New("deleting Human User is immutable")
	}
	identities, err := s.store.ListIdentitiesByHumanUser(user.HumanUserID)
	if err != nil {
		return err
	}
	active := 0
	for _, identity := range identities {
		if identity.Status == repo.IdentityStatusActive {
			active++
		}
	}
	if (next == repo.HumanUserStatusActive && active == 0) ||
		(next == repo.HumanUserStatusPending && active > 0) {
		return errors.New("Human User status conflicts with identities")
	}
	return nil
}

func (s *Server) handleDeleteHumanUser(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if s.reconcile == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime reconciler unavailable")
		return
	}
	if user.Status != repo.HumanUserStatusDeleting {
		if err := s.store.MarkHumanUserDeleting(user.HumanUserID); err != nil {
			writeRepoError(w, err)
			return
		}
		s.auditHumanUser(r, auditlog.ActionHumanUserDelete, user, "deleting")
	}
	s.enqueueReconcile(user.PodID)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"humanUserId": user.HumanUserID, "podId": user.PodID, "status": repo.HumanUserStatusDeleting,
	})
}

func validHumanUserStatus(status string) bool {
	switch status {
	case repo.HumanUserStatusPending, repo.HumanUserStatusActive, repo.HumanUserStatusDisabled:
		return true
	default:
		return false
	}
}

func identityCounts(identities []repo.UserIdentity) map[string]int {
	counts := make(map[string]int)
	for _, identity := range identities {
		counts[identity.HumanUserID]++
	}
	return counts
}

func (s *Server) makeHumanUserViews(
	users []repo.HumanUser, counts map[string]int,
) ([]humanUserView, error) {
	views := make([]humanUserView, 0, len(users))
	for _, user := range users {
		view, err := s.makeHumanUserView(user, counts[user.HumanUserID])
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *Server) makeHumanUserView(user repo.HumanUser, identityCount int) (humanUserView, error) {
	model, err := s.decodeModelOverride(user.ModelOverrideEnc)
	if err != nil {
		return humanUserView{}, err
	}
	return humanUserView{
		HumanUserID: user.HumanUserID, PodID: user.PodID, DisplayName: user.DisplayName,
		AgentID: user.AgentID, BrowserProfile: user.BrowserProfile,
		BrowserCDPPort: user.BrowserCDPPort, Status: user.Status, Notes: user.Notes,
		IdentityCount: identityCount, ModelOverride: modelToView(model),
		CreatedAt: user.CreatedAt, UpdatedAt: user.UpdatedAt,
	}, nil
}

func (s *Server) auditHumanUser(
	r *http.Request, action auditlog.Action, user repo.HumanUser, status string,
) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: user.HumanUserID,
		Metadata: auditlog.Metadata{
			PodID: user.PodID, HumanUserID: user.HumanUserID, AgentID: user.AgentID, Status: status,
		},
	})
	if err != nil {
		log.Printf("human_user_audit_failed id=%s action=%s error=%v", user.HumanUserID, action, err)
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

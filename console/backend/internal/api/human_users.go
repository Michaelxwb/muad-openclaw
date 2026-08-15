package api

import (
	"errors"
	"log"
	"net/http"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type patchHumanUserRequest struct {
	DisplayName   *string `json:"displayName"`
	Status        *string `json:"status"`
	Notes         *string `json:"notes"`
	ModelConfigID *string `json:"modelConfigId"`
}

func (s *Server) handleCreateHumanUser(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request createHumanUserRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidHumanUserRequest)
		return
	}
	if err := validateHumanUserCreateRequest(request); err != nil {
		writeInputValidationError(w, r, errcode.InvalidHumanUserRequest, err)
		return
	}
	agentID, err := resolveAgentID(request.AgentID, request.DisplayName)
	if err != nil {
		writeErr(w, r, errcode.InternalGenerateAgentID)
		return
	}
	user := repo.HumanUser{
		PodID: pod.PodID, DisplayName: strings.TrimSpace(request.DisplayName),
		AgentID: agentID, BrowserProfile: agentID, ModelConfigID: strings.TrimSpace(request.ModelConfigID),
		Notes: request.Notes,
	}
	result, err := s.bootstrapHumanUser(pod, user, request)
	if err != nil {
		s.writeHumanUserCreateError(w, r, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditHumanUser(r, auditlog.ActionHumanUserCreate, result.HumanUser, "created")
	s.writeHumanUserBootstrap(w, r, result)
}

func validateHumanUserCreateRequest(request createHumanUserRequest) error {
	displayName := strings.TrimSpace(request.DisplayName)
	if displayName == "" || len(displayName) > 128 {
		return newInputValidationError(
			errcode.InvalidHumanUserRequest,
			"displayName 不能为空，且不能超过 128 个字符",
			"displayName is required and must be at most 128 characters",
		)
	}
	if len(request.Notes) > 4000 {
		return newInputValidationError(
			errcode.InvalidHumanUserRequest,
			"notes 不能超过 4000 个字符",
			"notes must be at most 4000 characters",
		)
	}
	if strings.TrimSpace(request.ModelConfigID) == "" {
		return newInputValidationError(
			errcode.InvalidHumanUserRequest,
			"modelConfigId 必须选择一个未绑定的模型配置",
			"modelConfigId must reference an available unbound model configuration",
		)
	}
	if (request.Identity == nil) == (request.Activation == nil) {
		return newInputValidationError(
			errcode.InvalidHumanUserRequest,
			"identity 和 activation 必须且只能填写其中一个",
			"exactly one of identity or activation must be provided",
		)
	}
	return nil
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

func (s *Server) writeHumanUserCreateError(w http.ResponseWriter, r *http.Request, err error) {
	var validationErr *inputValidationError
	if errors.As(err, &validationErr) {
		writeInputValidationError(w, r, errcode.InvalidHumanUserConfig, err)
		return
	}
	if writeHumanUserModelConfigError(w, r, errcode.InvalidHumanUserConfig, err) {
		return
	}
	switch {
	case errors.Is(err, repo.ErrNotFound):
		writeRepoError(w, r, err)
	case errors.Is(err, repo.ErrPodCapacity), errors.Is(err, repo.ErrHumanUserExists),
		errors.Is(err, repo.ErrIdentityExists), errors.Is(err, repo.ErrLLMModelAlreadyBound):
		writeRepoError(w, r, err)
	case errors.Is(err, repo.ErrInvalidHumanUser), errors.Is(err, repo.ErrInvalidBindingCode),
		errors.Is(err, repo.ErrInvalidLLMModel):
		writeErr(w, r, errcode.InvalidHumanUserConfig)
	default:
		writeErr(w, r, errcode.InternalCreateHumanUser)
	}
}

func (s *Server) writeHumanUserBootstrap(w http.ResponseWriter, r *http.Request, result repo.HumanUserBootstrapResult) {
	view, err := s.makeHumanUserView(result.HumanUser, boolToInt(result.Identity != nil))
	if err != nil {
		writeErr(w, r, errcode.InternalRenderHumanUser)
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
		writeRepoError(w, r, err)
		return
	}
	filter, page, pageSize, ok := humanUserListFilterFromRequest(w, r)
	if !ok {
		return
	}
	users, total, err := s.store.ListHumanUsersByPod(podID, filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListHumanUsers)
		return
	}
	counts, err := s.store.CountIdentitiesByHumanUser(podID)
	if err != nil {
		writeErr(w, r, errcode.InternalCountHumanUserIdentities)
		return
	}
	s.writeHumanUserPage(w, r, users, counts, total, page, pageSize)
}

func (s *Server) handleListAllHumanUsers(w http.ResponseWriter, r *http.Request) {
	filter, page, pageSize, ok := humanUserListFilterFromRequest(w, r)
	if !ok {
		return
	}
	users, total, err := s.store.ListHumanUsers(filter)
	if err != nil {
		writeErr(w, r, errcode.InternalListHumanUsers)
		return
	}
	counts, err := s.store.CountIdentitiesByHumanUser("")
	if err != nil {
		writeErr(w, r, errcode.InternalCountHumanUserIdentities)
		return
	}
	s.writeHumanUserPage(w, r, users, counts, total, page, pageSize)
}

func humanUserListFilterFromRequest(
	w http.ResponseWriter, r *http.Request,
) (repo.HumanUserListFilter, int, int, bool) {
	page, pageSize := parsePodPagination(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validHumanUserStatus(status) {
		writeErr(w, r, errcode.InvalidHumanUserStatus)
		return repo.HumanUserListFilter{}, 0, 0, false
	}
	return repo.HumanUserListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize, Status: status,
		Query:   strings.TrimSpace(r.URL.Query().Get("q")),
		Unbound: r.URL.Query().Get("unbound") == "true",
	}, page, pageSize, true
}

func (s *Server) writeHumanUserPage(
	w http.ResponseWriter, r *http.Request, users []repo.HumanUser, counts map[string]int, total, page, pageSize int,
) {
	views, err := s.makeHumanUserViews(users, counts)
	if err != nil {
		writeErr(w, r, errcode.InternalRenderHumanUsers)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": views, "total": total, "page": page, "pageSize": pageSize,
	})
}

func (s *Server) handleGetHumanUser(w http.ResponseWriter, r *http.Request) {
	s.writeHumanUserDetail(w, r, r.PathValue("humanUserId"), http.StatusOK)
}

func (s *Server) writeHumanUserDetail(w http.ResponseWriter, r *http.Request, humanUserID string, status int) {
	user, err := s.store.GetHumanUser(humanUserID)
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	identities, err := s.store.ListIdentitiesByHumanUser(humanUserID)
	if err != nil {
		writeErr(w, r, errcode.InternalListHumanUserIdentities)
		return
	}
	view, err := s.makeHumanUserView(user, len(identities))
	if err != nil {
		writeErr(w, r, errcode.InternalRenderHumanUser)
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
		writeRepoError(w, r, err)
		return
	}
	var request patchHumanUserRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, r, errcode.InvalidRequestBody)
		return
	}
	update, changed, stateChanged, err := s.humanUserPatch(user, request)
	if err != nil {
		var validationErr *inputValidationError
		if errors.As(err, &validationErr) {
			writeInputValidationError(w, r, errcode.InvalidHumanUserUpdate, err)
		} else {
			writeRepoError(w, r, err)
		}
		return
	}
	if changed {
		if err := s.store.UpdateHumanUser(user.HumanUserID, update); err != nil {
			if writeHumanUserModelConfigError(w, r, errcode.InvalidLLMModel, err) {
				return
			}
			writeRepoError(w, r, err)
			return
		}
		if stateChanged && user.PodID != "" {
			s.enqueueReconcile(user.PodID)
		}
		s.auditHumanUser(r, auditlog.ActionHumanUserUpdate, user, update.Status)
	}
	s.writeHumanUserDetail(w, r, user.HumanUserID, http.StatusOK)
}

func writeHumanUserModelConfigError(
	w http.ResponseWriter, r *http.Request, invalidCode int, err error,
) bool {
	if errors.Is(err, repo.ErrInvalidLLMModel) || errors.Is(err, repo.ErrNotFound) {
		writeErrDetail(w, r, invalidCode,
			"modelConfigId 不存在或不可用，请选择列表中的模型配置")
		return true
	}
	if errors.Is(err, repo.ErrLLMModelAlreadyBound) {
		writeErrDetail(w, r, errcode.ConflictLLMModelBound,
			"modelConfigId 已被其他用户绑定，请选择未绑定的模型配置")
		return true
	}
	return false
}

func (s *Server) humanUserPatch(
	user repo.HumanUser, request patchHumanUserRequest,
) (repo.HumanUserUpdate, bool, bool, error) {
	update := repo.HumanUserUpdate{
		DisplayName: user.DisplayName, Status: user.Status, Notes: user.Notes,
		ModelConfigID: user.ModelConfigID,
	}
	if request.DisplayName != nil {
		update.DisplayName = strings.TrimSpace(*request.DisplayName)
	}
	if request.Status != nil {
		update.Status = strings.TrimSpace(*request.Status)
	}
	if request.Notes != nil {
		update.Notes = *request.Notes
	}
	if request.ModelConfigID != nil {
		update.ModelConfigID = strings.TrimSpace(*request.ModelConfigID)
	}
	if err := validateHumanUserPatchFields(update); err != nil {
		return repo.HumanUserUpdate{}, false, false, err
	}
	if err := s.validateHumanUserStatus(user, update.Status); err != nil {
		return repo.HumanUserUpdate{}, false, false, err
	}
	changed := update.DisplayName != user.DisplayName || update.Status != user.Status ||
		update.Notes != user.Notes || update.ModelConfigID != user.ModelConfigID
	stateChanged := update.Status != user.Status || update.ModelConfigID != user.ModelConfigID
	return update, changed, stateChanged, nil
}

func validateHumanUserPatchFields(update repo.HumanUserUpdate) error {
	if update.DisplayName == "" || len(update.DisplayName) > 128 {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"displayName 不能为空，且不能超过 128 个字符",
			"displayName is required and must be at most 128 characters",
		)
	}
	if len(update.Notes) > 4000 {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"notes 不能超过 4000 个字符",
			"notes must be at most 4000 characters",
		)
	}
	if strings.TrimSpace(update.ModelConfigID) == "" {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"modelConfigId 必须选择一个可用模型配置",
			"modelConfigId must reference an available model configuration",
		)
	}
	return validateHumanUserPatchStatus(update.Status)
}

func validateHumanUserPatchStatus(status string) error {
	if !validHumanUserStatus(status) {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"status 只能是 pending、active 或 disabled",
			"status must be pending, active, or disabled",
		)
	}
	if status == repo.HumanUserStatusDeleting {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"status 不能手动设置为 deleting，请使用删除操作",
			"status cannot be set to deleting manually; use the delete action",
		)
	}
	return nil
}

func (s *Server) validateHumanUserStatus(user repo.HumanUser, next string) error {
	if user.Status == repo.HumanUserStatusDeleting {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"当前用户正在删除，不能再编辑",
			"the user is being deleted and cannot be edited",
		)
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
	if next == repo.HumanUserStatusActive && active == 0 {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"status 不能改为 active：该用户还没有启用的 Identity",
			"status cannot become active because the user has no active Identity",
		)
	}
	if next == repo.HumanUserStatusPending && active > 0 {
		return newInputValidationError(
			errcode.InvalidHumanUserUpdate,
			"status 不能改为 pending：该用户已有启用的 Identity，请先停用或删除 Identity",
			"status cannot become pending because the user already has active identities",
		)
	}
	return nil
}

func (s *Server) handleDeleteHumanUser(w http.ResponseWriter, r *http.Request) {
	user, err := s.store.GetHumanUser(r.PathValue("humanUserId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	// An unbound user (its Pod was deleted) has no runtime to exec cleanup
	// into; delete the row and its user-owned assets synchronously.
	if user.PodID == "" {
		if err := s.store.DeleteUnboundHumanUser(user.HumanUserID); err != nil {
			writeRepoError(w, r, err)
			return
		}
		s.auditHumanUser(r, auditlog.ActionHumanUserDelete, user, "deleted_unbound")
		writeJSON(w, http.StatusOK, map[string]any{
			"humanUserId": user.HumanUserID, "podId": "", "deleted": true,
		})
		return
	}
	if s.reconcile == nil {
		writeErr(w, r, errcode.UnavailableRuntimeReconciler)
		return
	}
	if user.Status != repo.HumanUserStatusDeleting {
		if err := s.store.MarkHumanUserDeleting(user.HumanUserID); err != nil {
			writeRepoError(w, r, err)
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
	if user.ModelConfigID == "" {
		return humanUserView{}, repo.ErrInvalidLLMModel
	}
	config, err := s.store.GetLLMModelConfig(user.ModelConfigID)
	if err != nil {
		return humanUserView{}, err
	}
	return humanUserView{
		HumanUserID: user.HumanUserID, PodID: user.PodID, LastPodID: user.LastPodID,
		DisplayName: user.DisplayName, ModelConfigID: user.ModelConfigID, AgentID: user.AgentID,
		BrowserProfile: user.BrowserProfile, BrowserCDPPort: user.BrowserCDPPort,
		Status: user.Status, Notes: user.Notes, IdentityCount: identityCount,
		ModelConfig: modelConfigToView(config), CreatedAt: user.CreatedAt, UpdatedAt: user.UpdatedAt,
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

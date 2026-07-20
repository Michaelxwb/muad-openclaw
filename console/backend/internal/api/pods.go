package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	defaultPodPage     = 1
	defaultPodPageSize = 20
	maxPodPageSize     = 100
	maxUsersPerPod     = 10
)

var (
	errInvalidPodRequest = errors.New("invalid Pod request")
	errPodPatchMetadata  = errors.New("Pod patch metadata update failed")
	podIdentifierPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
)

type createPodRequest struct {
	PodID                 string                        `json:"podId"`
	DisplayName           string                        `json:"displayName"`
	ImageTag              string                        `json:"imageTag"`
	MaxUsers              int                           `json:"maxUsers"`
	Channels              []string                      `json:"channels"`
	ChannelConfigs        map[string]channelConfigInput `json:"channelConfigs"`
	MemLimit              string                        `json:"memLimit"`
	CPULimit              string                        `json:"cpuLimit"`
	RestartPolicy         string                        `json:"restartPolicy"`
	MaxSkillConcurrency   int                           `json:"maxSkillConcurrency"`
	MaxBrowserConcurrency int                           `json:"maxBrowserConcurrency"`
}

type patchPodRequest struct {
	DisplayName *string `json:"displayName"`
	ImageTag    *string `json:"imageTag"`
	MaxUsers    *int    `json:"maxUsers"`
}

func (s *Server) handleCreatePod(w http.ResponseWriter, r *http.Request) {
	var request createPodRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	pod, token, err := s.newPodRecord(request)
	if err != nil {
		if errors.Is(err, errInvalidPodRequest) {
			writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Pod configuration")
		} else {
			writeErr(w, http.StatusInternalServerError, codeInternal, "prepare Pod configuration")
		}
		return
	}
	if err := s.store.CreatePod(pod); err != nil {
		writeRepoError(w, err)
		return
	}
	if err := s.provisionPod(r, pod, token); err != nil {
		s.writeProvisionError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditPodMutation(r, auditlog.ActionPodCreate, pod.PodID, "running")
	s.writePodDetail(w, r, pod.PodID, http.StatusCreated)
}

func (s *Server) newPodRecord(request createPodRequest) (repo.Pod, serviceTokenMaterial, error) {
	request.PodID = strings.TrimSpace(request.PodID)
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.ImageTag = strings.TrimSpace(request.ImageTag)
	if request.DisplayName == "" {
		request.DisplayName = request.PodID
	}
	if request.ImageTag == "" {
		request.ImageTag = s.cfg.DefaultImage
	}
	if request.MaxUsers == 0 {
		request.MaxUsers = maxUsersPerPod
	}
	if !validPodRequest(request) {
		return repo.Pod{}, serviceTokenMaterial{}, errInvalidPodRequest
	}
	channels, configs, err := s.normalizeChannelSettings(
		podChannelsRequest{Channels: request.Channels, ChannelConfigs: request.ChannelConfigs}, nil,
	)
	if err != nil {
		return repo.Pod{}, serviceTokenMaterial{}, errors.Join(errInvalidPodRequest, err)
	}
	channelsJSON, configsEnc, err := s.encodeChannelSettings(channels, configs)
	if err != nil {
		return repo.Pod{}, serviceTokenMaterial{}, err
	}
	token, err := s.generateTokenMaterial()
	if err != nil {
		return repo.Pod{}, serviceTokenMaterial{}, err
	}
	return repo.Pod{
		PodID: request.PodID, DisplayName: request.DisplayName, ImageTag: request.ImageTag,
		State: repo.PodStateCreating, MaxUsers: request.MaxUsers,
		Channels: channelsJSON, ChannelConfigsEnc: configsEnc,
		MemLimit: request.MemLimit, CPULimit: request.CPULimit, RestartPolicy: request.RestartPolicy,
		MaxSkillConcurrency: request.MaxSkillConcurrency, MaxBrowserConcurrency: request.MaxBrowserConcurrency,
		ServiceTokenEnc: token.encrypted, ServiceTokenFingerprint: token.fingerprint,
		ServiceTokenRotatedAt: token.rotatedAt,
	}, token, nil
}

func validPodRequest(request createPodRequest) bool {
	if !podIdentifierPattern.MatchString(request.PodID) || request.MaxUsers < 1 || request.MaxUsers > maxUsersPerPod {
		return false
	}
	if request.DisplayName == "" || len(request.DisplayName) > 128 || request.ImageTag == "" || len(request.ImageTag) > 512 {
		return false
	}
	resources := resourceFieldsRequest{
		MemLimit: &request.MemLimit, CPULimit: &request.CPULimit, RestartPolicy: &request.RestartPolicy,
	}
	concurrency := podResourceRequest{
		MaxSkillConcurrency:   &request.MaxSkillConcurrency,
		MaxBrowserConcurrency: &request.MaxBrowserConcurrency,
	}
	return validateResourceRequest(resources) == nil && validateConcurrency(concurrency) == nil
}

func (s *Server) provisionPod(r *http.Request, pod repo.Pod, token serviceTokenMaterial) error {
	spec, err := s.buildDesiredPodSpec(pod)
	if err != nil {
		_ = s.store.UpdatePodState(pod.PodID, repo.PodStateError)
		return err
	}
	spec.ServiceToken = tokenSecret(token.plain)
	if err := s.drv.Create(r.Context(), spec); err != nil {
		if errors.Is(err, driver.ErrRetainedState) {
			_ = s.store.DeletePod(pod.PodID)
		} else {
			_ = s.store.UpdatePodState(pod.PodID, repo.PodStateError)
		}
		return err
	}
	if err := s.store.UpdatePodState(pod.PodID, repo.PodStateRunning); err != nil {
		removeErr := s.drv.Remove(r.Context(), pod.PodID, false)
		deleteErr := s.store.DeletePod(pod.PodID)
		return errors.Join(err, removeErr, deleteErr)
	}
	return nil
}

func (s *Server) writeProvisionError(w http.ResponseWriter, err error) {
	if errors.Is(err, driver.ErrRetainedState) {
		writeErr(w, http.StatusConflict, codeRetainedState, "retained Pod state requires explicit adoption")
		return
	}
	writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "create Pod runtime failed")
}

func (s *Server) handleListPods(w http.ResponseWriter, r *http.Request) {
	page, pageSize := parsePodPagination(r)
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state != "" && !validPodState(state) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Pod state")
		return
	}
	items, total, err := s.store.ListPods(repo.PodListFilter{
		Offset: (page - 1) * pageSize, Limit: pageSize, State: state,
		Query: strings.TrimSpace(r.URL.Query().Get("q")),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "list Pods")
		return
	}
	states, err := listDriverStates(r.Context(), s.drv)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "list Pod runtimes")
		return
	}
	views := make([]podView, 0, len(items))
	for _, item := range items {
		view, err := s.makePodView(item, states, false)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, codeInternal, "decode Pod configuration")
			return
		}
		views = append(views, view)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": views, "total": total, "page": page, "pageSize": pageSize,
	})
}

func (s *Server) handleGetPod(w http.ResponseWriter, r *http.Request) {
	s.writePodDetail(w, r, r.PathValue("podId"), http.StatusOK)
}

func (s *Server) writePodDetail(w http.ResponseWriter, r *http.Request, podID string, status int) {
	summary, err := s.store.GetPodSummary(podID)
	if err != nil {
		writeRepoError(w, err)
		return
	}
	states, err := listDriverStates(r.Context(), s.drv)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "inspect Pod runtime")
		return
	}
	view, err := s.makePodView(summary, states, true)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, codeInternal, "decode Pod configuration")
		return
	}
	writeJSON(w, status, view)
}

func (s *Server) handlePatchPod(w http.ResponseWriter, r *http.Request) {
	summary, err := s.store.GetPodSummary(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	pod := summary.Pod
	var request patchPodRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	update, changed, imageChanged := applyPodPatch(pod, request)
	if !changed {
		s.writePodDetail(w, r, pod.PodID, http.StatusOK)
		return
	}
	if update.MaxUsers < 1 || update.MaxUsers > maxUsersPerPod || update.DisplayName == "" || update.ImageTag == "" {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "invalid Pod configuration")
		return
	}
	if update.MaxUsers < summary.UserCount {
		writeRepoError(w, repo.ErrPodCapacity)
		return
	}
	// Image changes must recreate the workload (same as /upgrade), not only bump generation.
	if imageChanged {
		s.handlePatchPodImageChange(w, r, pod, update)
		return
	}
	if err := s.store.UpdatePod(pod.PodID, update); err != nil {
		writeRepoError(w, err)
		return
	}
	s.enqueueReconcile(pod.PodID)
	s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "updated")
	w.Header().Set("X-Muad-Requires-Pod-Restart", "false")
	s.writePodDetail(w, r, pod.PodID, http.StatusOK)
}

func (s *Server) handlePatchPodImageChange(
	w http.ResponseWriter, r *http.Request, pod repo.Pod, update repo.PodUpdate,
) {
	if !validImageTag(update.ImageTag) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "valid imageTag is required")
		return
	}
	err := s.updatePodImageViaPatch(r.Context(), pod, update)
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime coordinator unavailable")
		return
	}
	if errors.Is(err, errPodPatchMetadata) {
		s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_metadata_failed")
		writeRepoError(w, err)
		return
	}
	if err != nil {
		s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rolled_back")
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "Pod image change failed and was rolled back")
		return
	}
	s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade")
	w.Header().Set("X-Muad-Requires-Pod-Restart", "false")
	s.writePodDetail(w, r, pod.PodID, http.StatusOK)
}

func (s *Server) updatePodImageViaPatch(ctx context.Context, pod repo.Pod, update repo.PodUpdate) error {
	err := s.runPodExclusive(ctx, pod.PodID, func(runCtx context.Context) error {
		opCtx, cancel := podRuntimeOperationContext(runCtx)
		defer cancel()
		_, upgradeErr := s.performPodUpgrade(opCtx, pod, update.ImageTag)
		return upgradeErr
	})
	if err != nil {
		return err
	}
	if update.DisplayName == pod.DisplayName && update.MaxUsers == pod.MaxUsers {
		return nil
	}
	latest, err := s.store.GetPod(pod.PodID)
	if err != nil {
		return errors.Join(errPodPatchMetadata, err)
	}
	nonImage := podUpdateFrom(latest)
	nonImage.DisplayName = update.DisplayName
	nonImage.MaxUsers = update.MaxUsers
	if err := s.store.UpdatePod(pod.PodID, nonImage); err != nil {
		return errors.Join(errPodPatchMetadata, err)
	}
	s.enqueueReconcile(pod.PodID)
	return nil
}

func applyPodPatch(pod repo.Pod, request patchPodRequest) (repo.PodUpdate, bool, bool) {
	update := podUpdateFrom(pod)
	if request.DisplayName != nil {
		update.DisplayName = strings.TrimSpace(*request.DisplayName)
	}
	if request.ImageTag != nil {
		update.ImageTag = strings.TrimSpace(*request.ImageTag)
	}
	if request.MaxUsers != nil {
		update.MaxUsers = *request.MaxUsers
	}
	changed := update.DisplayName != pod.DisplayName || update.ImageTag != pod.ImageTag || update.MaxUsers != pod.MaxUsers
	return update, changed, update.ImageTag != pod.ImageTag
}

func podUpdateFrom(pod repo.Pod) repo.PodUpdate {
	return repo.PodUpdate{
		DisplayName: pod.DisplayName, ImageTag: pod.ImageTag, MaxUsers: pod.MaxUsers,
		Channels: pod.Channels, ChannelConfigsEnc: pod.ChannelConfigsEnc,
		MemLimit: pod.MemLimit, CPULimit: pod.CPULimit,
		RestartPolicy: pod.RestartPolicy, MaxSkillConcurrency: pod.MaxSkillConcurrency,
		MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
	}
}

func (s *Server) handleDeletePod(w http.ResponseWriter, r *http.Request) {
	deleteState, ok := explicitDeleteState(r.URL.Query().Get("deleteState"))
	if !ok {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "deleteState=true|false is required")
		return
	}
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	err = s.runPodExclusive(r.Context(), pod.PodID, func(ctx context.Context) error {
		opCtx, cancel := podRuntimeOperationContext(ctx)
		defer cancel()
		if err := s.store.UpdatePodState(pod.PodID, repo.PodStateDeleting); err != nil {
			return err
		}
		if err := s.drv.Remove(opCtx, pod.PodID, !deleteState); err != nil {
			_ = s.store.UpdatePodState(pod.PodID, pod.State)
			return fmt.Errorf("delete Pod runtime: %w", err)
		}
		return s.store.DeletePod(pod.PodID)
	})
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime coordinator unavailable")
		return
	}
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			writeRepoError(w, err)
			return
		}
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "delete Pod runtime failed")
		return
	}
	status := "state_retained"
	if deleteState {
		status = "state_deleted"
	}
	s.auditPodMutation(r, auditlog.ActionPodDelete, pod.PodID, status)
	writeJSON(w, http.StatusOK, map[string]any{"podId": pod.PodID, "deleted": true, "stateRetained": !deleteState})
}

func explicitDeleteState(value string) (bool, bool) {
	switch value {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func parsePodPagination(r *http.Request) (int, int) {
	page, pageSize := defaultPodPage, defaultPodPageSize
	if value, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && value > 0 {
		page = value
	}
	if value, err := strconv.Atoi(r.URL.Query().Get("pageSize")); err == nil && value > 0 {
		pageSize = min(value, maxPodPageSize)
	}
	return page, pageSize
}

func validPodState(state string) bool {
	switch state {
	case repo.PodStateCreating, repo.PodStateRunning, repo.PodStateStopped,
		repo.PodStateUnhealthy, repo.PodStateError, repo.PodStateDeleting:
		return true
	default:
		return false
	}
}

func (s *Server) auditPodMutation(r *http.Request, action auditlog.Action, podID, status string) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: action, Target: podID,
		Metadata: auditlog.Metadata{PodID: podID, Status: status},
	})
	if err != nil {
		log.Printf("pod_audit_failed pod=%s action=%s error=%v", podID, action, err)
	}
}

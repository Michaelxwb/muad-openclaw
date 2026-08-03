package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	maxSkillReloadPods           = 100
	skillReloadDriverListTimeout = 15 * time.Second
	skillReloadPublicSyncTimeout = 2 * time.Minute
	skillReloadPerPodSyncTimeout = 60 * time.Second
)

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	action := r.PathValue("action")
	if !validPodAction(action) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "unsupported Pod action")
		return
	}
	newState, valid := podActionTarget(action, pod.State)
	if !valid {
		writeErr(w, http.StatusConflict, codePodStateConflict, "Pod state does not allow this action")
		return
	}
	err = s.runPodExclusive(r.Context(), pod.PodID, func(ctx context.Context) error {
		return s.executePodAction(ctx, pod.PodID, action)
	})
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime coordinator unavailable")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "Pod action failed")
		return
	}
	if err := s.store.UpdatePodState(pod.PodID, newState); err != nil {
		writeRepoError(w, err)
		return
	}
	if action != "stop" {
		s.enqueueReconcile(pod.PodID)
	}
	s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, action)
	writeJSON(w, http.StatusOK, map[string]any{"podId": pod.PodID, "state": newState})
}

func validPodAction(action string) bool {
	return action == "start" || action == "stop" || action == "restart"
}

func podActionTarget(action, state string) (string, bool) {
	switch action {
	case "start":
		return repo.PodStateRunning, state == repo.PodStateStopped
	case "stop":
		return repo.PodStateStopped, state == repo.PodStateRunning || state == repo.PodStateUnhealthy
	case "restart":
		return repo.PodStateRunning, state == repo.PodStateRunning || state == repo.PodStateUnhealthy
	default:
		return "", false
	}
}

func (s *Server) executePodAction(ctx context.Context, podID, action string) error {
	switch action {
	case "start":
		return s.drv.Start(ctx, podID)
	case "stop":
		return s.drv.Stop(ctx, podID)
	case "restart":
		return s.drv.Restart(ctx, podID)
	default:
		return errors.New("unsupported Pod action")
	}
}

func (s *Server) handleApplyPodConfig(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy {
		writeErr(w, http.StatusConflict, codePodStateConflict, "Pod must be running to apply configuration")
		return
	}
	if s.reconcile == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime reconciler unavailable")
		return
	}
	s.enqueueReconcile(pod.PodID)

	// Refresh the runtime env Secret so BuildEnv changes (e.g. MUAD_AUTOMATION_URL)
	// take effect on the next Pod restart.
	if spec, specErr := s.buildDesiredPodSpec(pod); specErr == nil {
		if updateErr := s.drv.UpdateSpec(r.Context(), pod.PodID, spec); updateErr != nil {
			log.Printf("pod_config_update_spec_failed pod=%s error=%v", pod.PodID, updateErr)
		}
	}

	s.auditPodConfigQueued(r, pod)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"podId": pod.PodID, "status": "queued", "configGeneration": pod.ConfigGeneration,
		"appliedGeneration": pod.AppliedGeneration,
	})
}

func (s *Server) auditPodConfigQueued(r *http.Request, pod repo.Pod) {
	err := auditlog.Record(r.Context(), s.store, auditlog.Event{
		Actor: auditlog.AdminActor(actorFrom(r.Context())), Action: auditlog.ActionPodConfigApply,
		Target: pod.PodID, Metadata: auditlog.Metadata{
			PodID: pod.PodID, Status: "queued", Generation: pod.ConfigGeneration,
			AppliedGeneration: pod.AppliedGeneration,
		},
	})
	if err != nil {
		log.Printf("pod_config_queue_audit_failed pod=%s error=%v", pod.PodID, err)
	}
}

type applyRequest struct {
	PodIDs []string `json:"podIds"`
}

type skillReloadResponse struct {
	Results  map[string]string `json:"results"`
	Warnings []string          `json:"warnings,omitempty"`
}

func (s *Server) handleSkillsReload(w http.ResponseWriter, r *http.Request) {
	if s.reconcile == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime reconciler unavailable")
		return
	}
	var request applyRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	podIDs := request.PodIDs
	if len(podIDs) == 0 {
		var err error
		podIDs, err = s.allPodIDs()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, codeInternal, "list Pods failed")
			return
		}
	} else {
		var ok bool
		podIDs, ok = validPodIDs(request.PodIDs)
		if !ok {
			writeErr(w, http.StatusBadRequest, codeInvalidField, "podIds must contain valid unique Pod IDs")
			return
		}
	}
	results, warnings, err := s.enqueueSkillConfigApply(r.Context(), podIDs)
	if err != nil {
		log.Printf("skill_reload_enqueue_failed error=%s", auditlog.RedactDiagnostic(err.Error()))
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "reload Skills failed")
		return
	}
	writeJSON(w, http.StatusOK, skillReloadResponse{Results: results, Warnings: warnings})
}

func (s *Server) allPodIDs() ([]string, error) {
	pods, _, err := s.store.ListPods(repo.PodListFilter{})
	if err != nil {
		return nil, err
	}
	podIDs := make([]string, 0, len(pods))
	for _, pod := range pods {
		podIDs = append(podIDs, pod.PodID)
	}
	return podIDs, nil
}

func validPodIDs(input []string) ([]string, bool) {
	if len(input) == 0 || len(input) > maxSkillReloadPods {
		return nil, false
	}
	seen := make(map[string]struct{}, len(input))
	for _, podID := range input {
		if !podIdentifierPattern.MatchString(podID) {
			return nil, false
		}
		if _, duplicate := seen[podID]; duplicate {
			return nil, false
		}
		seen[podID] = struct{}{}
	}
	return append([]string(nil), input...), true
}

func (s *Server) enqueueSkillConfigApply(
	ctx context.Context, podIDs []string,
) (map[string]string, []string, error) {
	pods, _, err := s.store.ListPods(repo.PodListFilter{})
	if err != nil {
		return nil, nil, err
	}
	listCtx, cancel := context.WithTimeout(ctx, skillReloadDriverListTimeout)
	infos, err := s.drv.List(listCtx)
	cancel()
	if err != nil {
		return nil, nil, err
	}
	known, running := podSets(pods, infos)
	results, reload := classifyReloadTargets(podIDs, known, running)
	if s.skillSyncer == nil {
		return nil, nil, errors.New("Skill syncer unavailable")
	}
	var hasPublic bool
	var publicErr error
	var warnings []string
	if len(reload) > 0 {
		publicCtx, publicCancel := context.WithTimeout(ctx, skillReloadPublicSyncTimeout)
		publicResult, err := s.skillSyncer.SyncPublicForced(publicCtx)
		publicCancel()
		hasPublic, warnings, publicErr = publicResult.HasPublic, publicResult.Warnings, err
	}
	for _, podID := range reload {
		podCtx, podCancel := context.WithTimeout(ctx, skillReloadPerPodSyncTimeout)
		results[podID] = s.applyPodSkills(podCtx, podID, hasPublic, publicErr)
		podCancel()
	}
	return results, warnings, nil
}

func (s *Server) applyPodSkills(
	ctx context.Context, podID string, hasPublic bool, publicErr error,
) string {
	status := "failed_queue"
	err := s.runPodExclusive(ctx, podID, func(runCtx context.Context) error {
		status = s.syncPodSkillsForReload(runCtx, podID, hasPublic, publicErr)
		return nil
	})
	if err != nil {
		log.Printf("skill_reload_lock_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
		return "failed_queue"
	}
	return status
}

func (s *Server) syncPodSkillsForReload(
	ctx context.Context, podID string, hasPublic bool, publicErr error,
) string {
	if publicErr != nil {
		log.Printf("skill_public_sync_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(publicErr.Error()))
		return "failed_sync"
	}
	pod, err := s.store.GetPod(podID)
	if err != nil {
		log.Printf("skill_reload_get_pod_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
		return "failed_queue"
	}
	if err := s.skillSyncer.SyncPodAfterPublicSync(ctx, podID, hasPublic); err != nil {
		log.Printf("skill_sync_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
		return "failed_sync"
	}
	if !pod.SkillsPending {
		return "synced"
	}
	if err := s.store.ClearPodSkillsPending(podID, pod.ConfigGeneration); err != nil {
		log.Printf("skill_reload_clear_pending_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
		return "failed_queue"
	}
	s.enqueueReconcile(podID)
	return "queued"
}

func podSets(pods []repo.PodSummary, infos []driver.ContainerInfo) (map[string]bool, map[string]bool) {
	known, running := map[string]bool{}, map[string]bool{}
	for _, pod := range pods {
		known[pod.PodID] = true
	}
	for _, info := range infos {
		running[info.PodID] = info.State == repo.PodStateRunning
	}
	return known, running
}

func classifyReloadTargets(
	podIDs []string, known, running map[string]bool,
) (map[string]string, []string) {
	results := make(map[string]string, len(podIDs))
	reload := make([]string, 0, len(podIDs))
	for _, podID := range podIDs {
		switch {
		case !known[podID]:
			results[podID] = "not_found"
		case !running[podID]:
			results[podID] = "skipped_not_running"
		default:
			reload = append(reload, podID)
		}
	}
	return results, reload
}

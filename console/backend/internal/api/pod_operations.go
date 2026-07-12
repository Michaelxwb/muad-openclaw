package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	maxSkillReloadPods        = 100
	maxSkillReloadConcurrency = 4
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

func (s *Server) handleSkillsReload(w http.ResponseWriter, r *http.Request) {
	if s.operations == nil {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime coordinator unavailable")
		return
	}
	var request applyRequest
	if err := decodeJSONBody(w, r, &request); err != nil {
		writeErr(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
		return
	}
	podIDs, ok := validPodIDs(request.PodIDs)
	if !ok {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "podIds must contain valid unique Pod IDs")
		return
	}
	results, err := s.reloadSkills(r.Context(), podIDs)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "inspect Pod runtimes failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
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

func (s *Server) reloadSkills(ctx context.Context, podIDs []string) (map[string]string, error) {
	pods, _, err := s.store.ListPods(repo.PodListFilter{})
	if err != nil {
		return nil, err
	}
	infos, err := s.drv.List(ctx)
	if err != nil {
		return nil, err
	}
	known, running := podSets(pods, infos)
	results, reload := classifyReloadTargets(podIDs, known, running)
	s.restartForSkillReload(ctx, reload, results)
	return results, nil
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

func (s *Server) restartForSkillReload(ctx context.Context, podIDs []string, results map[string]string) {
	var wait sync.WaitGroup
	var lock sync.Mutex
	limit := make(chan struct{}, maxSkillReloadConcurrency)
	for _, podID := range podIDs {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			status := "reloaded"
			err := s.runPodExclusive(ctx, id, func(runCtx context.Context) error {
				return s.drv.Restart(runCtx, id)
			})
			if err != nil {
				status = "failed"
			}
			lock.Lock()
			results[id] = status
			lock.Unlock()
		}(podID)
	}
	wait.Wait()
}

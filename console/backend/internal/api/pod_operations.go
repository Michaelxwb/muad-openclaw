package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	maxSkillReloadPods = 100
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

type applyRequest struct {
	PodIDs []string `json:"podIds"`
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
	results, err := s.enqueueSkillConfigApply(r.Context(), podIDs)
	if err != nil {
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "inspect Pod runtimes failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
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

func (s *Server) enqueueSkillConfigApply(ctx context.Context, podIDs []string) (map[string]string, error) {
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
	syncDir, cleanup, err := s.activePublicSkillSyncDir()
	if err != nil {
		return nil, err
	}
	defer cleanup()
	for _, podID := range reload {
		if err := s.drv.SyncPublicSkills(ctx, podID, syncDir); err != nil {
			results[podID] = "failed_sync"
			continue
		}
		s.enqueueReconcile(podID)
		results[podID] = "queued"
	}
	return results, nil
}

func (s *Server) activePublicSkillSyncDir() (string, func(), error) {
	root, err := resolvePublicSkillRoot(s.cfg.SkillsDir)
	if err != nil {
		return "", func() {}, err
	}
	assets, managedNames, err := s.publicSkillAssetsForSync()
	if err != nil {
		return "", func() {}, err
	}
	tempRoot, err := os.MkdirTemp("", "muad-active-public-skills-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tempRoot) }
	for _, asset := range assets {
		source := activePublicSkillSource(root, asset)
		target := filepath.Join(tempRoot, asset.Name)
		if err := copySkillDirectory(source, target); err != nil {
			cleanup()
			return "", func() {}, err
		}
	}
	if err := writePublicSkillManagedIndex(tempRoot, managedNames); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return tempRoot, cleanup, nil
}

func (s *Server) publicSkillAssetsForSync() ([]repo.SkillAsset, []string, error) {
	var active []repo.SkillAsset
	managed := map[string]struct{}{}
	for _, status := range []string{repo.SkillStatusActive, repo.SkillStatusDisabled, repo.SkillStatusDeleted} {
		assets, _, err := s.store.ListSkillAssets(repo.SkillAssetListFilter{
			Scope: repo.SkillScopePublic, Status: status,
		})
		if err != nil {
			return nil, nil, err
		}
		for _, asset := range assets {
			managed[asset.Name] = struct{}{}
			if asset.Status == repo.SkillStatusActive {
				active = append(active, asset)
			}
		}
	}
	names := make([]string, 0, len(managed))
	for name := range managed {
		names = append(names, name)
	}
	sort.Strings(names)
	return active, names, nil
}

func writePublicSkillManagedIndex(root string, names []string) error {
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return os.WriteFile(filepath.Join(root, ".muad-public-index"), []byte(body), 0o600)
}

func activePublicSkillSource(root string, asset repo.SkillAsset) string {
	source := filepath.Clean(strings.TrimSpace(asset.SourcePath))
	if source != "" && filepath.IsAbs(source) && pathWithin(root, source) {
		return source
	}
	return filepath.Join(root, asset.Name)
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

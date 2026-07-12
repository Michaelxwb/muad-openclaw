package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	upgradeHealthTimeout = 2 * time.Minute
	upgradePollInterval  = 500 * time.Millisecond
)

type upgradeRequest struct {
	ImageTag string `json:"imageTag"`
}

func (s *Server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, err)
		return
	}
	var request upgradeRequest
	if err := decodeJSONBody(w, r, &request); err != nil || !validImageTag(request.ImageTag) {
		writeErr(w, http.StatusBadRequest, codeInvalidField, "valid imageTag is required")
		return
	}
	request.ImageTag = strings.TrimSpace(request.ImageTag)
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy {
		writeErr(w, http.StatusConflict, codePodStateConflict, "Pod must be running to upgrade")
		return
	}
	if request.ImageTag == pod.ImageTag {
		s.writePodDetail(w, r, pod.PodID, http.StatusOK)
		return
	}
	var upgraded repo.Pod
	err = s.runPodExclusive(r.Context(), pod.PodID, func(ctx context.Context) error {
		var upgradeErr error
		upgraded, upgradeErr = s.performPodUpgrade(ctx, pod, request.ImageTag)
		return upgradeErr
	})
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, http.StatusServiceUnavailable, codeDependencyUnavailable, "runtime coordinator unavailable")
		return
	}
	if err != nil {
		s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rolled_back")
		writeErr(w, http.StatusBadGateway, codeRuntimeFailure, "Pod upgrade failed and was rolled back")
		return
	}
	s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade")
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": upgraded.PodID, "imageTag": upgraded.ImageTag, "state": upgraded.State,
		"configGeneration": upgraded.ConfigGeneration, "appliedGeneration": upgraded.AppliedGeneration,
	})
}

func validImageTag(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 512 && !strings.ContainsAny(value, " \t\r\n")
}

func (s *Server) performPodUpgrade(ctx context.Context, current repo.Pod, imageTag string) (repo.Pod, error) {
	target, err := s.updatePodImage(current, imageTag)
	if err != nil {
		return repo.Pod{}, err
	}
	desired, err := s.buildDesiredPodRuntime(target)
	if err != nil {
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, false, err)
	}
	if err := s.store.StartPodConfigApply(target.PodID, target.ConfigGeneration); err != nil {
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, false, err)
	}
	runtimeChanged, err := s.replacePodRuntime(ctx, desired, false)
	if err == nil {
		err = s.completePodUpgrade(target, desired)
	}
	if err != nil {
		_ = s.store.FailPodConfigApply(target.PodID, target.ConfigGeneration, auditlog.RedactDiagnostic(err.Error()))
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, runtimeChanged, err)
	}
	return s.store.GetPod(target.PodID)
}

func (s *Server) updatePodImage(current repo.Pod, imageTag string) (repo.Pod, error) {
	update := podUpdateFrom(current)
	update.ImageTag = imageTag
	if err := s.store.UpdatePod(current.PodID, update); err != nil {
		return repo.Pod{}, err
	}
	return s.store.GetPod(current.PodID)
}

func (s *Server) replacePodRuntime(
	ctx context.Context, desired desiredPodRuntime, alreadyRemoved bool,
) (bool, error) {
	if !alreadyRemoved {
		if err := s.drv.Remove(ctx, desired.spec.PodID, true); err != nil {
			return false, err
		}
	}
	desired.spec.AdoptState = true
	if err := s.drv.Create(ctx, desired.spec); err != nil {
		return true, err
	}
	if err := waitForPodHealth(ctx, s.drv, desired.spec.PodID, desired.runtime.Config.Generation); err != nil {
		return true, err
	}
	return true, nil
}

func (s *Server) completePodUpgrade(target repo.Pod, desired desiredPodRuntime) error {
	if err := s.store.CompletePodConfigApply(
		target.PodID, target.ConfigGeneration, desired.runtime.Hash, time.Now().UTC(),
	); err != nil {
		return err
	}
	return s.store.UpdatePodState(target.PodID, repo.PodStateRunning)
}

func (s *Server) recoverPodUpgrade(
	ctx context.Context, original repo.Pod, runtimeChanged bool, cause error,
) error {
	restored, err := s.restorePodImage(original)
	if err == nil && runtimeChanged {
		err = s.restorePodRuntime(ctx, restored)
	} else if err == nil {
		s.enqueueReconcile(restored.PodID)
	}
	if err != nil {
		_ = s.store.UpdatePodState(original.PodID, repo.PodStateError)
		log.Printf("pod_upgrade_rollback_failed pod=%s error=%s", original.PodID, auditlog.RedactDiagnostic(err.Error()))
	}
	return errors.Join(cause, err)
}

func (s *Server) restorePodImage(original repo.Pod) (repo.Pod, error) {
	latest, err := s.store.GetPod(original.PodID)
	if err != nil {
		return repo.Pod{}, err
	}
	return s.updatePodImage(latest, original.ImageTag)
}

func (s *Server) restorePodRuntime(ctx context.Context, restored repo.Pod) error {
	desired, err := s.buildDesiredPodRuntime(restored)
	if err != nil {
		return err
	}
	if err := s.store.StartPodConfigApply(restored.PodID, restored.ConfigGeneration); err != nil {
		return err
	}
	if _, err := s.replacePodRuntime(ctx, desired, false); err != nil {
		return err
	}
	return s.completePodUpgrade(restored, desired)
}

func waitForPodHealth(ctx context.Context, runtime gateway.Execer, podID string, generation int64) error {
	probeCtx, cancel := context.WithTimeout(ctx, upgradeHealthTimeout)
	defer cancel()
	for {
		status := gateway.Probe(probeCtx, runtime, podID)
		if status.Healthy && status.RuntimeGuardHealthy && status.RuntimeGeneration == generation {
			return nil
		}
		timer := time.NewTimer(upgradePollInterval)
		select {
		case <-probeCtx.Done():
			timer.Stop()
			return fmt.Errorf("wait for Pod generation %d: %w", generation, probeCtx.Err())
		case <-timer.C:
		}
	}
}

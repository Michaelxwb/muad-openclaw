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
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	upgradeHealthTimeout = 2 * time.Minute
	podRuntimeOpTimeout  = upgradeHealthTimeout + 30*time.Second
	upgradePollInterval  = 500 * time.Millisecond
)

// errUpgradeRollbackFailed marks a failed upgrade whose rollback also failed.
// The API reports it as RuntimeUpgradeRollbackFailed (50215) instead of
// claiming a successful automatic rollback.
var errUpgradeRollbackFailed = errors.New("pod upgrade rollback failed")

type upgradeRequest struct {
	ImageTag string `json:"imageTag"`
}

func (s *Server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	pod, err := s.store.GetPod(r.PathValue("podId"))
	if err != nil {
		writeRepoError(w, r, err)
		return
	}
	var request upgradeRequest
	if err := decodeJSONBody(w, r, &request); err != nil || !validImageTag(request.ImageTag) {
		writeErr(w, r, errcode.InvalidImageTag)
		return
	}
	request.ImageTag = strings.TrimSpace(request.ImageTag)
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy {
		writeErr(w, r, errcode.ConflictPodRunningUpgrade)
		return
	}
	if request.ImageTag == pod.ImageTag {
		s.writePodDetail(w, r, pod.PodID, http.StatusOK)
		return
	}
	var upgraded repo.Pod
	err = s.runPodExclusive(r.Context(), pod.PodID, func(ctx context.Context) error {
		opCtx, cancel := podRuntimeOperationContext(ctx)
		defer cancel()
		var upgradeErr error
		upgraded, upgradeErr = s.performPodUpgrade(opCtx, pod, request.ImageTag)
		return upgradeErr
	})
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, r, errcode.UnavailableRuntimeCoordinator)
		return
	}
	if err != nil {
		if errors.Is(err, errUpgradeRollbackFailed) {
			s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rollback_failed")
			writeRuntimeFailure(w, r, err, errcode.RuntimeUpgradeRollbackFailed)
			return
		}
		s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rolled_back")
		writeRuntimeFailure(w, r, err, errcode.RuntimeUpgradeRolledBack)
		return
	}
	s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade")
	writeJSON(w, http.StatusOK, map[string]any{
		"podId": upgraded.PodID, "imageTag": upgraded.ImageTag, "state": upgraded.State,
		"configGeneration": upgraded.ConfigGeneration, "appliedGeneration": upgraded.AppliedGeneration,
	})
}

func podRuntimeOperationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), podRuntimeOpTimeout)
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
	if err := s.syncSkillsBeforeDirectApply(ctx, target); err != nil {
		_ = s.store.FailPodConfigApply(target.PodID, target.ConfigGeneration, auditlog.RedactDiagnostic(err.Error()))
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, false, err)
	}
	err = s.replacePodRuntime(ctx, desired)
	if err == nil {
		err = s.completePodUpgrade(target, desired)
	}
	if err != nil {
		_ = s.store.FailPodConfigApply(target.PodID, target.ConfigGeneration, auditlog.RedactDiagnostic(err.Error()))
		// 一旦进入 ReplaceRuntime 阶段，运行时就可能已切换；无论失败与否都按
		// runtimeChanged=true 处理，回滚会原地重建到旧镜像以收敛到确定状态。
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, true, err)
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

func (s *Server) replacePodRuntime(ctx context.Context, desired desiredPodRuntime) error {
	if err := s.drv.ReplaceRuntime(ctx, desired.spec); err != nil {
		return err
	}
	return waitForPodHealth(ctx, s.drv, desired.spec.PodID, desired.runtime.Config.Generation)
}

func (s *Server) completePodUpgrade(target repo.Pod, desired desiredPodRuntime) error {
	if err := s.store.CompletePodConfigApply(
		target.PodID, target.ConfigGeneration, desired.runtime.Hash, time.Now().UTC(),
	); err != nil {
		return err
	}
	if target.SkillsPending {
		if err := s.store.ClearPodSkillsPending(target.PodID, target.ConfigGeneration); err != nil {
			return err
		}
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
		// 回滚本身失败：结果不可信，标记 sentinel 让 handler 上报 50215，
		// 而不是谎报"已自动回滚"（50205）。
		return errors.Join(cause, err, errUpgradeRollbackFailed)
	}
	return cause
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
	if err := s.syncSkillsBeforeDirectApply(ctx, restored); err != nil {
		_ = s.store.FailPodConfigApply(restored.PodID, restored.ConfigGeneration, auditlog.RedactDiagnostic(err.Error()))
		return err
	}
	if err := s.replacePodRuntime(ctx, desired); err != nil {
		return err
	}
	return s.completePodUpgrade(restored, desired)
}

func (s *Server) syncSkillsBeforeDirectApply(ctx context.Context, pod repo.Pod) error {
	if !pod.SkillsPending {
		return nil
	}
	if s.skillSyncer == nil {
		return errors.New("Skill syncer unavailable")
	}
	return s.skillSyncer.SyncPod(ctx, pod.PodID)
}

func waitForPodHealth(ctx context.Context, runtime gateway.Execer, podID string, generation int64) error {
	probeCtx, cancel := context.WithTimeout(ctx, upgradeHealthTimeout)
	defer cancel()
	for {
		// 镜像拉取失败（ErrImagePull/ImagePullBackOff 等）是终态：等多久都不会 Ready，
		// 立即失败触发回滚，而不是轮询到 upgradeHealthTimeout。
		if checker, ok := runtime.(driver.WorkloadBlockedChecker); ok {
			if blocked, err := checker.WorkloadBlocked(probeCtx, podID); err == nil && blocked {
				return fmt.Errorf("Pod %s image pull failed (workload blocked)", podID)
			}
		}
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

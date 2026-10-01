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
	// error 态放行：改镜像是升级回滚失败 brick 后唯一的可靠恢复路径。
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy &&
		pod.State != repo.PodStateError {
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
	// The request can wait behind an apply or another lifecycle operation.
	// Read the record again after acquiring the Pod lock before copying fields.
	current, err := s.store.GetPod(current.PodID)
	if err != nil {
		return repo.Pod{}, err
	}
	if current.ImageTag == imageTag {
		return current, nil
	}
	startup, ok := s.drv.(driver.RuntimeStartupDriver)
	if !ok {
		return repo.Pod{}, errors.Join(errors.New("runtime startup recovery unavailable"), errUpgradeRollbackFailed)
	}
	snapshot, err := startup.SnapshotStartupConfig(ctx, current.PodID)
	if err != nil {
		return repo.Pod{}, errors.Join(err, errUpgradeRollbackFailed)
	}
	target, err := s.updatePodImage(current, imageTag)
	if err != nil {
		return repo.Pod{}, err
	}
	return s.applyPodImageUpgrade(ctx, current, target, snapshot)
}

func (s *Server) applyPodImageUpgrade(ctx context.Context, current, target repo.Pod, snapshot driver.RuntimeStartupSnapshot) (repo.Pod, error) {
	desired, err := s.buildDesiredPodRuntime(target)
	if err != nil {
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, snapshot, err)
	}
	if err := s.store.StartPodConfigApply(target.PodID, target.ConfigGeneration); err != nil {
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, snapshot, err)
	}
	if err := s.syncSkillsBeforeDirectApply(ctx, target); err != nil {
		err = s.failPodUpgradeApply(target, err)
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, snapshot, err)
	}
	err = s.replacePodRuntime(ctx, desired)
	if err == nil {
		err = s.completePodUpgrade(target, desired)
	}
	if err != nil {
		err = s.failPodUpgradeApply(target, err)
		// A failed replacement may already have changed the workload; restore
		// its original image and input mode with a new recovery generation.
		return repo.Pod{}, s.recoverPodUpgrade(ctx, current, snapshot, err)
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
	if err := waitForPodHealth(ctx, s.drv, desired.spec.PodID, desired.runtime.Config.Generation); err != nil {
		return err
	}
	startup, ok := s.drv.(driver.RuntimeStartupDriver)
	if !ok {
		return errors.New("runtime startup recovery unavailable")
	}
	return startup.SyncStartupConfig(ctx, desired.spec)
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
	ctx context.Context, original repo.Pod, snapshot driver.RuntimeStartupSnapshot, cause error,
) error {
	recoveryCtx, cancel := podRuntimeOperationContext(ctx)
	defer cancel()
	restored, err := s.restorePodImage(original)
	if err == nil {
		err = s.restorePodRuntime(recoveryCtx, restored, snapshot)
	}
	if err != nil {
		// 回滚也失败：必须落终态（last_apply_status=failed），否则 restorePodRuntime
		// 里的 StartPodConfigApply 会把状态留在 applying，UI 永远显示"应用中"且无操作
		// 出口。restorePodImage 已把 config_generation 前移，FailPodConfigApply 带
		// `config_generation = ?` guard，必须用当前最新 generation 才会命中而不是空操作。
		latest, latestErr := s.store.GetPod(original.PodID)
		if latestErr != nil {
			log.Printf("pod_upgrade_rollback_failed_get_pod pod=%s error=%s",
				original.PodID, auditlog.RedactDiagnostic(latestErr.Error()))
			latest = restored
		}
		err = s.failPodUpgradeApply(latest, err)
		err = errors.Join(err, s.store.UpdatePodState(original.PodID, repo.PodStateError))
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

func (s *Server) restorePodRuntime(ctx context.Context, restored repo.Pod, snapshot driver.RuntimeStartupSnapshot) error {
	desired, err := s.buildDesiredPodRuntime(restored)
	if err != nil {
		return err
	}
	if err := s.store.StartPodConfigApply(restored.PodID, restored.ConfigGeneration); err != nil {
		return err
	}
	if err := s.syncSkillsBeforeDirectApply(ctx, restored); err != nil {
		return s.failPodUpgradeApply(restored, err)
	}
	startup, ok := s.drv.(driver.RuntimeStartupDriver)
	if !ok {
		return errors.New("runtime startup recovery unavailable")
	}
	if err := startup.RestoreRuntime(ctx, desired.spec, snapshot); err != nil {
		return err
	}
	if err := waitForPodHealth(ctx, s.drv, restored.PodID, restored.ConfigGeneration); err != nil {
		return err
	}
	return s.completePodUpgrade(restored, desired)
}

func (s *Server) failPodUpgradeApply(pod repo.Pod, cause error) error {
	return errors.Join(cause, s.store.FailPodConfigApply(pod.PodID, pod.ConfigGeneration,
		auditlog.RedactDiagnostic(cause.Error())))
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

// waitForPodHealth 有界等待 Pod 到达健康态并校验 runtime generation 已收敛到目标配置。
func waitForPodHealth(ctx context.Context, runtime gateway.Execer, podID string, generation int64) error {
	return probeUntilReady(ctx, runtime, podID, generation)
}

// waitForPodHealthy 有界等待 Pod 到达健康态，不校验 runtime generation——配置收敛由
// 协调器异步完成。用于 error 态恢复动作：只有真正健康才允许置 Running，避免对崩溃
// 循环的 Pod 谎报运行态（健康等待超时 → 保持 error）。
func waitForPodHealthy(ctx context.Context, runtime gateway.Execer, podID string) error {
	return probeUntilReady(ctx, runtime, podID, 0)
}

// probeUntilReady 有界轮询探活，直到 Pod 健康（可选地校验 runtime generation）。
// generation == 0 表示跳过 generation 校验，仅等待健康。
func probeUntilReady(ctx context.Context, runtime gateway.Execer, podID string, generation int64) error {
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
		if status.Healthy && status.RuntimeGuardHealthy &&
			(generation == 0 || status.RuntimeGeneration == generation) {
			return nil
		}
		timer := time.NewTimer(upgradePollInterval)
		select {
		case <-probeCtx.Done():
			timer.Stop()
			if generation > 0 {
				return fmt.Errorf("wait for Pod generation %d: %w", generation, probeCtx.Err())
			}
			return fmt.Errorf("wait for Pod health: %w", probeCtx.Err())
		case <-timer.C:
		}
	}
}

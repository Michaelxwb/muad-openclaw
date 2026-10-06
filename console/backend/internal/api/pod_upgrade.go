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
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeupgrade"
)

const (
	// One-way upgrade windows. The first 9.8 switch includes image pull,
	// Doctor state migration and gateway startup, so the legacy 2m health /
	// 2m30s operation bounds are too tight (design §3.4 API-01). The target
	// image must be pre-warmed on the node.
	upgradeHealthTimeout = 5 * time.Minute
	podRuntimeOpTimeout  = 15 * time.Minute
	upgradePollInterval  = 500 * time.Millisecond
)

var (
	// errUpgradeRollbackFailed marks a failed upgrade whose rollback also failed.
	// The API reports it as RuntimeUpgradeRollbackFailed (50215) instead of
	// claiming a successful automatic rollback.
	errUpgradeRollbackFailed = errors.New("pod upgrade rollback failed")
	// errUpgradeFailForward marks a cross-version upgrade (allowRollback=false)
	// that stopped in error without restoring the old image: the new state is
	// irreversible, so 50216 replaces the rollback semantics. The generic
	// rollback feature itself is untouched for rollback-allowed upgrades.
	errUpgradeFailForward = errors.New("pod upgrade stopped in error (fail-forward)")
)

type upgradeRequest struct {
	ImageTag string `json:"imageTag"`
	// AllowRollback keeps the historical automatic rollback on failure.
	// nil/true = rollback allowed (default, unchanged behavior); false =
	// fail-forward, required for cross-version migrations whose new state the
	// old image can no longer read.
	AllowRollback *bool `json:"allowRollback"`
}

func (request upgradeRequest) rollbackAllowed() bool {
	return request.AllowRollback == nil || *request.AllowRollback
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
	// error 态放行：改镜像是一次性升级失败后切到修复版镜像的唯一出口
	// （回滚失败的 brick 与跨版本 fail-forward 共用该出口）。
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy &&
		pod.State != repo.PodStateError {
		writeErr(w, r, errcode.ConflictPodRunningUpgrade)
		return
	}
	if request.ImageTag == pod.ImageTag {
		s.writePodDetail(w, r, pod.PodID, http.StatusOK)
		return
	}
	rollback := request.rollbackAllowed()
	execute := func(ctx context.Context) error {
		_, upgradeErr := s.performPodUpgrade(ctx, pod, request.ImageTag, rollback)
		return upgradeErr
	}
	err = s.runPodUpgradeOperation(r.Context(), pod.PodID, pod.ImageTag, request.ImageTag, execute)
	if errors.Is(err, errRuntimeCoordinatorUnavailable) {
		writeErr(w, r, errcode.UnavailableRuntimeCoordinator)
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, errUpgradeRollbackFailed):
			s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rollback_failed")
			writeRuntimeFailure(w, r, err, errcode.RuntimeUpgradeRollbackFailed)
		case errors.Is(err, errUpgradeFailForward):
			s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_failed")
			writeRuntimeFailure(w, r, err, errcode.RuntimeUpgradeFailed)
		default:
			s.auditPodMutation(r, auditlog.ActionPodUpdate, pod.PodID, "upgrade_rolled_back")
			writeRuntimeFailure(w, r, err, errcode.RuntimeUpgradeRolledBack)
		}
		return
	}
	upgraded, err := s.store.GetPod(pod.PodID)
	if err != nil {
		writeRepoError(w, r, err)
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

// runPodUpgradeOperation funnels every one-way image switch (direct upgrade and
// image PATCH) through the same journaled orchestration (maintenance gate +
// operation record), regardless of the rollback policy.
func (s *Server) runPodUpgradeOperation(
	ctx context.Context, podID, sourceImage, targetImage string, execute func(context.Context) error,
) error {
	if s.upgradeSvc != nil {
		// 一次性升级整体以脱离请求的 15 分钟预算运行：客户端断开不中断升级，
		// 排空/切换也不会无限等待（排空另有更短的独立上限）。
		runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), podRuntimeOpTimeout)
		defer cancel()
		_, err := s.upgradeSvc.Run(runCtx, runtimeupgrade.Request{
			PodID:       podID,
			SourceImage: sourceImage,
			TargetImage: targetImage,
			Execute: func(runCtx context.Context) error {
				opCtx, cancel := podRuntimeOperationContext(runCtx)
				defer cancel()
				return execute(opCtx)
			},
		})
		return err
	}
	return s.runPodExclusive(ctx, podID, func(runCtx context.Context) error {
		opCtx, cancel := podRuntimeOperationContext(runCtx)
		defer cancel()
		return execute(opCtx)
	})
}

func (s *Server) performPodUpgrade(
	ctx context.Context, current repo.Pod, imageTag string, allowRollback bool,
) (repo.Pod, error) {
	// The request can wait behind an apply or another lifecycle operation.
	// Read the record again after acquiring the Pod lock before copying fields.
	current, err := s.store.GetPod(current.PodID)
	if err != nil {
		return repo.Pod{}, err
	}
	if current.ImageTag == imageTag {
		return current, nil
	}
	// Binding protection baseline (FEAT-02): captured after the lock re-read and
	// compared after the switch; any protected change stops the upgrade in error
	// instead of being reported as successful.
	before, err := s.store.SnapshotProtectedBindings(current.PodID)
	if err != nil {
		return repo.Pod{}, err
	}
	if !allowRollback {
		return s.applyPodUpgradeFailForward(ctx, current, imageTag, before)
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
	return s.applyPodImageUpgrade(ctx, current, target, snapshot, before)
}

// applyPodUpgradeFailForward is the cross-version path: the old image can no
// longer read the migrated state, so a failure stops in error with the target
// image kept for operator repair (no rollback).
func (s *Server) applyPodUpgradeFailForward(
	ctx context.Context, current repo.Pod, imageTag string, before repo.ProtectedBindings,
) (repo.Pod, error) {
	target, err := s.updatePodImage(current, imageTag)
	if err != nil {
		return repo.Pod{}, errors.Join(err, errUpgradeFailForward)
	}
	if err := s.applyPodImageUpgradeFailForward(ctx, target, before); err != nil {
		if errors.Is(err, errUpgradeFailForward) {
			return repo.Pod{}, err
		}
		return repo.Pod{}, s.failPodUpgradeForward(target, errors.Join(err, errUpgradeFailForward))
	}
	return s.store.GetPod(target.PodID)
}

// applyPodImageUpgradeFailForward switches the workload without any recovery
// bookkeeping: failures are handled by the caller via failPodUpgradeForward.
func (s *Server) applyPodImageUpgradeFailForward(
	ctx context.Context, target repo.Pod, before repo.ProtectedBindings,
) error {
	desired, err := s.buildDesiredPodRuntime(target)
	if err != nil {
		return err
	}
	if err := s.store.StartPodConfigApply(target.PodID, target.ConfigGeneration); err != nil {
		return err
	}
	if err := s.syncSkillsBeforeDirectApply(ctx, target); err != nil {
		return err
	}
	if err := s.replacePodRuntime(ctx, desired); err != nil {
		return err
	}
	// Binding verification runs before the apply is marked complete so a
	// protected-field change is reported as a binding failure (fail-forward)
	// instead of being masked by a later generation conflict.
	if err := s.verifyProtectedBindings(target.PodID, before); err != nil {
		return errors.Join(s.failPodUpgradeForward(target, err), errUpgradeFailForward)
	}
	return s.completePodUpgrade(target, desired)
}

// verifyProtectedBindings compares the protected records captured before the
// switch with the current ones. An empty error means every binding is intact.
func (s *Server) verifyProtectedBindings(podID string, before repo.ProtectedBindings) error {
	after, err := s.store.SnapshotProtectedBindings(podID)
	if err != nil {
		return err
	}
	if diff := repo.DiffProtectedBindings(before, after); len(diff) > 0 {
		return fmt.Errorf("protected bindings changed during upgrade: %s", strings.Join(diff, "; "))
	}
	return nil
}

// applyPodImageUpgrade keeps the historical recovery contract: any failure
// restores the original image and startup input, and a failed recovery is
// reported as errUpgradeRollbackFailed (50215).
func (s *Server) applyPodImageUpgrade(
	ctx context.Context, current, target repo.Pod, snapshot driver.RuntimeStartupSnapshot,
	before repo.ProtectedBindings,
) (repo.Pod, error) {
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
		if verifyErr := s.verifyProtectedBindings(target.PodID, before); verifyErr != nil {
			// Binding drift is not fixed by an image rollback: stop forward.
			return repo.Pod{}, errors.Join(s.failPodUpgradeForward(target, verifyErr), errUpgradeFailForward)
		}
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

// failPodUpgradeForward keeps the target image: cross-version state migration
// is irreversible, so the pod stops in error for operator repair instead of
// being rolled back to an image that can no longer read its state.
func (s *Server) failPodUpgradeForward(target repo.Pod, cause error) error {
	if err := s.store.FailPodConfigApply(
		target.PodID, target.ConfigGeneration, auditlog.RedactDiagnostic(cause.Error()),
	); err != nil {
		cause = errors.Join(cause, err)
	}
	if err := s.store.UpdatePodState(target.PodID, repo.PodStateError); err != nil {
		cause = errors.Join(cause, err)
	}
	return cause
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
		// 立即失败触发回滚/fail-forward，而不是轮询到 upgradeHealthTimeout。
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

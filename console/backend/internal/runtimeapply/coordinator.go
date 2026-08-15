package runtimeapply

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

type CoordinatorStore interface {
	GetPod(podID string) (repo.Pod, error)
	StartPodConfigApply(podID string, generation int64) error
	CompletePodConfigApply(podID string, generation int64, hash string, appliedAt time.Time) error
	FailPodConfigApply(podID string, generation int64, message string) error
	ClearPodSkillsPending(podID string, generation int64) error
	ListPodsNeedingApply() ([]repo.Pod, error)
}

type RuntimeBuilder interface {
	Build(podID string) (runtimeconfig.Result, error)
}

type ApplyExecutor interface {
	Apply(ctx context.Context, request Request) (Result, error)
}

type BeforeApplyHook interface {
	BeforeApply(ctx context.Context, podID string) error
}

type CoordinatorOptions struct {
	MaxAttempts         int
	NotReadyMaxAttempts int
	RetryDelay          time.Duration
	RescanInterval      time.Duration
	BeforeApply         BeforeApplyHook
}

// errPodNotRunning 表示 Pod 当前不能 apply（stopped/creating 等）：协调器跳过
// 本次同步——不重试、不写 failed，保留 pending 等 start 后的 enqueueReconcile 收敛。
var errPodNotRunning = errors.New("runtimeapply: pod is not running")

type Coordinator struct {
	store    CoordinatorStore
	builder  RuntimeBuilder
	executor ApplyExecutor
	hook     BeforeApplyHook
	options  CoordinatorOptions

	mu      sync.Mutex
	pending map[string]bool
	running map[string]bool
	locks   map[string]chan struct{}
	wake    chan struct{}
	started bool
	wg      sync.WaitGroup
}

func NewCoordinator(
	store CoordinatorStore, builder RuntimeBuilder, executor ApplyExecutor, options CoordinatorOptions,
) (*Coordinator, error) {
	if store == nil || builder == nil || executor == nil {
		return nil, errors.New("runtimeapply: coordinator dependencies are required")
	}
	if options.MaxAttempts <= 0 {
		options.MaxAttempts = 3
	}
	if options.NotReadyMaxAttempts <= 0 {
		options.NotReadyMaxAttempts = 60
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = 2 * time.Second
	}
	if options.RescanInterval <= 0 {
		options.RescanInterval = 30 * time.Second
	}
	return &Coordinator{
		store: store, builder: builder, executor: executor, hook: options.BeforeApply, options: options,
		pending: map[string]bool{}, running: map[string]bool{}, locks: map[string]chan struct{}{},
		wake: make(chan struct{}, 1),
	}, nil
}

// RunExclusive serializes lifecycle operations with config apply for one Pod.
func (coordinator *Coordinator) RunExclusive(
	ctx context.Context, podID string, operation func(context.Context) error,
) error {
	podID = strings.TrimSpace(podID)
	if podID == "" || operation == nil {
		return errors.New("runtimeapply: Pod operation is required")
	}
	lock := coordinator.operationLock(podID)
	select {
	case lock <- struct{}{}:
		defer func() { <-lock }()
		return operation(ctx)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (coordinator *Coordinator) operationLock(podID string) chan struct{} {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	lock := coordinator.locks[podID]
	if lock == nil {
		lock = make(chan struct{}, 1)
		coordinator.locks[podID] = lock
	}
	return lock
}

// Enqueue coalesces requests by Pod. The latest DB generation is loaded by the worker.
func (coordinator *Coordinator) Enqueue(podID string) {
	podID = strings.TrimSpace(podID)
	if podID == "" {
		return
	}
	coordinator.mu.Lock()
	coordinator.pending[podID] = true
	coordinator.mu.Unlock()
	coordinator.signal()
}

// ReconcileNow applies the latest desired generation for one Pod before returning.
func (coordinator *Coordinator) ReconcileNow(ctx context.Context, podID string) error {
	return coordinator.RunExclusive(ctx, podID, func(runCtx context.Context) error {
		return coordinator.reconcileImmediate(runCtx, podID)
	})
}

// Run recovers unconverged Pods and dispatches one serial worker per Pod. A
// periodic rescan re-lists Pods needing apply so a Pod that failed its apply
// transiently (or was created/updated without an explicit enqueue) is not
// permanently stuck in failed/pending.
func (coordinator *Coordinator) Run(ctx context.Context) {
	if !coordinator.markStarted() {
		return
	}
	coordinator.enqueueRecovery(ctx)
	ticker := time.NewTicker(coordinator.options.RescanInterval)
	defer ticker.Stop()
	for {
		coordinator.dispatch(ctx)
		select {
		case <-ctx.Done():
			coordinator.wg.Wait()
			return
		case <-coordinator.wake:
		case <-ticker.C:
			coordinator.rescan(ctx)
		}
	}
}

// rescan 周期性地把需要 apply 的 Pod 重新入队。running map 做去重：正在 apply
// 的 Pod 不会被再次入队，避免与并发 apply 冲突。
func (coordinator *Coordinator) rescan(ctx context.Context) {
	pods, err := coordinator.store.ListPodsNeedingApply()
	if err != nil {
		log.Printf("runtime_reconcile_rescan_failed error=%v", err)
		return
	}
	for _, pod := range pods {
		coordinator.enqueueIfIdle(pod.PodID)
	}
}

// enqueueIfIdle 只在 Pod 不在 running（无并发 apply）时置 pending；正在运行的
// apply 不受干扰，其 worker 结束后自然回到空闲。
func (coordinator *Coordinator) enqueueIfIdle(podID string) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.running[podID] {
		return
	}
	coordinator.pending[podID] = true
}

func (coordinator *Coordinator) markStarted() bool {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.started {
		return false
	}
	coordinator.started = true
	return true
}

func (coordinator *Coordinator) enqueueRecovery(ctx context.Context) {
	for attempt := 1; attempt <= coordinator.options.MaxAttempts; attempt++ {
		pods, err := coordinator.store.ListPodsNeedingApply()
		if err == nil {
			for _, pod := range pods {
				coordinator.Enqueue(pod.PodID)
			}
			return
		}
		if attempt == coordinator.options.MaxAttempts || !waitForRetry(ctx, coordinator.options.RetryDelay) {
			log.Printf("runtime_reconcile_recovery_scan_failed attempts=%d error=%v", attempt, err)
			return
		}
	}
}

func (coordinator *Coordinator) dispatch(ctx context.Context) {
	coordinator.mu.Lock()
	var podIDs []string
	for podID, pending := range coordinator.pending {
		if pending && !coordinator.running[podID] {
			coordinator.pending[podID] = false
			coordinator.running[podID] = true
			podIDs = append(podIDs, podID)
		}
	}
	coordinator.wg.Add(len(podIDs))
	coordinator.mu.Unlock()
	for _, podID := range podIDs {
		go coordinator.runPod(ctx, podID)
	}
}

func (coordinator *Coordinator) runPod(ctx context.Context, podID string) {
	defer coordinator.wg.Done()
	defer coordinator.recoverRunPodPanic(podID)
	for {
		err := coordinator.reconcileWithRetry(ctx, podID)
		if err != nil && ctx.Err() == nil {
			log.Printf("runtime_reconcile_failed pod=%s error=%v", podID, err)
		}
		if !coordinator.repeatPending(ctx, podID) {
			return
		}
	}
}

// recoverRunPodPanic 把 runPod goroutine 的 panic 转成该 Pod 的 apply 失败记录并
// 清理 running/pending 状态，进程不退出、其余 Pod 的 apply 不受影响。已收敛的
// Pod（AppliedGeneration >= ConfigGeneration）不覆盖为 failed。
func (coordinator *Coordinator) recoverRunPodPanic(podID string) {
	recovered := recover()
	if recovered == nil {
		return
	}
	log.Printf("runtime_reconcile_panic pod=%s panic=%v", podID, recovered)
	coordinator.mu.Lock()
	delete(coordinator.pending, podID)
	delete(coordinator.running, podID)
	coordinator.mu.Unlock()
	if pod, err := coordinator.store.GetPod(podID); err == nil &&
		pod.AppliedGeneration < pod.ConfigGeneration {
		_ = coordinator.recordFailure(podID, pod.ConfigGeneration,
			fmt.Errorf("reconcile panic: %v", recovered))
	}
}

func (coordinator *Coordinator) repeatPending(ctx context.Context, podID string) bool {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if ctx.Err() == nil && coordinator.pending[podID] {
		coordinator.pending[podID] = false
		return true
	}
	delete(coordinator.pending, podID)
	delete(coordinator.running, podID)
	return false
}

// reconcileWithRetry 每次尝试独立获取 per-pod 锁，重试间的等待在锁外进行。
// 这样对 runtime not ready 的 Pod（如坏镜像 ImagePullBackOff）长时间重试时不会独占
// per-pod 锁饿死用户的升级/删除操作——用户操作最多等一次尝试即可拿到锁。
func (coordinator *Coordinator) reconcileWithRetry(ctx context.Context, podID string) error {
	var last error
	for attempt := 1; ; attempt++ {
		last = coordinator.RunExclusive(ctx, podID, func(runCtx context.Context) error {
			return coordinator.reconcileOnce(runCtx, podID)
		})
		if last == nil || errors.Is(last, repo.ErrNotFound) || errors.Is(last, errPodNotRunning) {
			return nil
		}
		maxAttempts := coordinator.options.MaxAttempts
		if errors.Is(last, driver.ErrRuntimeNotReady) {
			maxAttempts = coordinator.options.NotReadyMaxAttempts
		}
		if attempt >= maxAttempts {
			break
		}
		if !errors.Is(last, repo.ErrGenerationConflict) && !waitForRetry(ctx, coordinator.options.RetryDelay) {
			return ctx.Err()
		}
	}
	return last
}

func (coordinator *Coordinator) reconcileImmediate(ctx context.Context, podID string) error {
	for attempt := 1; ; attempt++ {
		err := coordinator.reconcileOnce(ctx, podID)
		if err == nil || errors.Is(err, repo.ErrNotFound) || errors.Is(err, errPodNotRunning) {
			return nil
		}
		if !errors.Is(err, repo.ErrGenerationConflict) || attempt >= coordinator.options.MaxAttempts {
			return err
		}
	}
}

func (coordinator *Coordinator) reconcileOnce(ctx context.Context, podID string) error {
	built, err := coordinator.builder.Build(podID)
	if err != nil {
		return coordinator.recordBuildFailure(podID, err)
	}
	generation := built.Config.Generation
	pod, err := coordinator.store.GetPod(podID)
	if err != nil {
		return err
	}
	if pod.ConfigGeneration != generation {
		return repo.ErrGenerationConflict
	}
	// stopped/creating 等非运行态 Pod 不能 accept exec：直接跳过，不重试也不写
	// failed（否则 stopped 容器会被 NotReady 重试 60 次后误标 failed）。pending
	// 状态保留，由 api 侧 start 后的 enqueueReconcile / 周期 rescan 收敛。
	if pod.State != repo.PodStateRunning && pod.State != repo.PodStateUnhealthy {
		return errPodNotRunning
	}
	if pod.AppliedGeneration >= generation {
		if pod.SkillsPending {
			return coordinator.store.ClearPodSkillsPending(podID, generation)
		}
		return nil
	}
	if err := coordinator.store.StartPodConfigApply(podID, generation); err != nil {
		return err
	}
	if pod.SkillsPending && coordinator.hook == nil {
		return coordinator.recordFailure(podID, generation, errors.New("Skill syncer unavailable"))
	}
	if pod.SkillsPending {
		// Skill files are part of the generation contract. Do not mark runtime
		// config applied if the runtime-visible Skill tree cannot be synchronized.
		if err := coordinator.hook.BeforeApply(ctx, podID); err != nil {
			return coordinator.recordFailure(podID, generation, err)
		}
	}
	result, err := coordinator.executor.Apply(ctx, Request{
		PodID: podID, Generation: generation, RuntimeJSON: built.CanonicalJSON,
	})
	if err != nil {
		return coordinator.recordFailure(podID, generation, err)
	}
	if err := coordinator.store.CompletePodConfigApply(
		podID, generation, result.ConfigHash, time.Now().UTC(),
	); err != nil {
		return err
	}
	if pod.SkillsPending {
		return coordinator.store.ClearPodSkillsPending(podID, generation)
	}
	return nil
}

func (coordinator *Coordinator) recordBuildFailure(podID string, cause error) error {
	pod, err := coordinator.store.GetPod(podID)
	if err != nil {
		return errors.Join(cause, err)
	}
	return coordinator.recordFailure(podID, pod.ConfigGeneration, cause)
}

func (coordinator *Coordinator) recordFailure(podID string, generation int64, cause error) error {
	message := auditlog.RedactDiagnostic(cause.Error())
	if len(message) > 2048 {
		message = message[:2048]
	}
	if err := coordinator.store.FailPodConfigApply(podID, generation, message); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (coordinator *Coordinator) signal() {
	select {
	case coordinator.wake <- struct{}{}:
	default:
	}
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

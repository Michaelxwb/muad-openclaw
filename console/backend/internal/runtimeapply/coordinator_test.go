package runtimeapply

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

func TestCoordinatorCoalescesSamePodAndLoadsLatestGeneration(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	executor.block = make(chan struct{})
	coordinator := newTestCoordinator(t, store, executor, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	coordinator.Enqueue("pod-a")
	waitFor(t, func() bool { return executor.count("pod-a") == 1 })
	store.setGeneration("pod-a", 2)
	for range 20 {
		coordinator.Enqueue("pod-a")
	}
	close(executor.block)
	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 2 })
	if got := executor.generations("pod-a"); fmt.Sprint(got) != "[1 2]" {
		t.Fatalf("applied generations = %v", got)
	}
}

func TestCoordinatorRunsDifferentPodsConcurrently(t *testing.T) {
	store := newCoordinatorStore("pod-a", "pod-b")
	executor := newCoordinatorExecutor()
	executor.block = make(chan struct{})
	coordinator := newTestCoordinator(t, store, executor, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	coordinator.Enqueue("pod-a")
	coordinator.Enqueue("pod-b")
	waitFor(t, func() bool { return executor.activeCount() == 2 })
	close(executor.block)
	waitFor(t, func() bool {
		return store.appliedGeneration("pod-a") == 1 && store.appliedGeneration("pod-b") == 1
	})
	if executor.maxActiveCount() < 2 {
		t.Fatalf("max parallel applies = %d", executor.maxActiveCount())
	}
}

func TestCoordinatorSerializesApplyWithExternalPodOperation(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	coordinator := newTestCoordinator(t, store, executor, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	entered, release := make(chan struct{}), make(chan struct{})
	operationDone := make(chan error, 1)
	go func() {
		operationDone <- coordinator.RunExclusive(ctx, "pod-a", func(context.Context) error {
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	coordinator.Enqueue("pod-a")
	time.Sleep(5 * time.Millisecond)
	if executor.count("pod-a") != 0 {
		t.Fatal("config apply overlapped an external Pod operation")
	}
	close(release)
	if err := <-operationDone; err != nil {
		t.Fatalf("RunExclusive: %v", err)
	}
	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 1 })
}

func TestCoordinatorRetriesStaleCompletionWithoutOverwritingLatest(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.conflictFirstCompletion = true
	executor := newCoordinatorExecutor()
	coordinator := newTestCoordinator(t, store, executor, 3)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)
	coordinator.Enqueue("pod-a")

	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 2 })
	if got := executor.generations("pod-a"); fmt.Sprint(got) != "[1 2]" {
		t.Fatalf("applied generations = %v", got)
	}
}

func TestCoordinatorRecoversPendingPodsOnStartup(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.recovery = []repo.Pod{{PodID: "pod-a"}}
	executor := newCoordinatorExecutor()
	coordinator := newTestCoordinator(t, store, executor, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 1 })
}

func TestCoordinatorBoundsFailedApplyRetries(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	executor.applyError = errors.New("health failed")
	coordinator := newTestCoordinator(t, store, executor, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)
	coordinator.Enqueue("pod-a")

	waitFor(t, func() bool {
		return executor.count("pod-a") == 2 && store.failedCount("pod-a") == 2
	})
	if store.failedCount("pod-a") != 2 {
		t.Fatalf("failed status writes = %d", store.failedCount("pod-a"))
	}
}

func TestCoordinatorReconcileNowDoesNotRetryApplyFailures(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	executor.applyError = errors.New("health failed")
	coordinator := newTestCoordinator(t, store, executor, 3)

	err := coordinator.ReconcileNow(context.Background(), "pod-a")
	if err == nil {
		t.Fatal("ReconcileNow should report apply failure")
	}
	if executor.count("pod-a") != 1 || store.failedCount("pod-a") != 1 {
		t.Fatalf("sync apply should fail once, attempts=%d failures=%d",
			executor.count("pod-a"), store.failedCount("pod-a"))
	}
}

func TestCoordinatorSkipsBeforeApplyHookWhenSkillsAreNotPending(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	hook := &coordinatorHook{}
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, RetryDelay: time.Millisecond, BeforeApply: hook},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}

	err = coordinator.ReconcileNow(context.Background(), "pod-a")
	if err != nil {
		t.Fatalf("ReconcileNow: %v", err)
	}
	if len(hook.podIDs) != 0 {
		t.Fatalf("hook should be skipped, got %v", hook.podIDs)
	}
}

func TestCoordinatorRunsBeforeApplyHookOnlyForPendingSkills(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.setSkillsPending("pod-a", true)
	executor := newCoordinatorExecutor()
	hook := &coordinatorHook{}
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, RetryDelay: time.Millisecond, BeforeApply: hook},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}

	err = coordinator.ReconcileNow(context.Background(), "pod-a")
	if err != nil {
		t.Fatalf("ReconcileNow: %v", err)
	}
	if fmt.Sprint(hook.podIDs) != "[pod-a]" {
		t.Fatalf("hook pod IDs = %v", hook.podIDs)
	}
	if store.appliedGeneration("pod-a") != 1 {
		t.Fatalf("generation was not completed after hook")
	}
	if store.skillsPending("pod-a") {
		t.Fatal("skills pending was not cleared after successful apply")
	}
}

func TestCoordinatorClearsPendingOnlyAppliedGeneration(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.setGeneration("pod-a", 2)
	store.setAppliedGeneration("pod-a", 2)
	store.setSkillsPending("pod-a", true)
	executor := newCoordinatorExecutor()
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor, CoordinatorOptions{MaxAttempts: 1},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}

	err = coordinator.ReconcileNow(context.Background(), "pod-a")
	if err != nil {
		t.Fatalf("ReconcileNow: %v", err)
	}
	if executor.count("pod-a") != 0 {
		t.Fatalf("runtime apply should be skipped for applied generation: %d", executor.count("pod-a"))
	}
	if store.skillsPending("pod-a") {
		t.Fatal("stale skills pending was not cleared")
	}
}

func TestCoordinatorFailsPendingSkillsWhenHookMissing(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.setSkillsPending("pod-a", true)
	executor := newCoordinatorExecutor()
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor, CoordinatorOptions{MaxAttempts: 1},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}

	err = coordinator.ReconcileNow(context.Background(), "pod-a")
	if err == nil {
		t.Fatal("ReconcileNow should fail when Skill syncer is unavailable")
	}
	if executor.count("pod-a") != 0 {
		t.Fatalf("runtime apply should not run without Skill syncer: %d", executor.count("pod-a"))
	}
	if !store.skillsPending("pod-a") || store.failedCount("pod-a") != 1 {
		t.Fatalf("pending state/failure count = %v/%d", store.skillsPending("pod-a"), store.failedCount("pod-a"))
	}
}

func TestCoordinatorFailsGenerationWhenBeforeApplyHookFails(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.setSkillsPending("pod-a", true)
	executor := newCoordinatorExecutor()
	hook := &coordinatorHook{err: errors.New("sync failed")}
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, RetryDelay: time.Millisecond, BeforeApply: hook},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}

	err = coordinator.ReconcileNow(context.Background(), "pod-a")
	if err == nil {
		t.Fatal("ReconcileNow should fail when hook fails")
	}
	if executor.count("pod-a") != 0 {
		t.Fatalf("runtime apply should not run after hook failure: %d", executor.count("pod-a"))
	}
	if store.failedCount("pod-a") != 1 || store.appliedGeneration("pod-a") != 0 {
		t.Fatalf("hook failure should fail unapplied generation: failures=%d applied=%d",
			store.failedCount("pod-a"), store.appliedGeneration("pod-a"))
	}
	if !store.skillsPending("pod-a") {
		t.Fatal("skills pending should remain set after hook failure")
	}
}

func TestCoordinatorExtendsRetriesWhileRuntimeIsNotReady(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	executor.notReadyFailures = 3
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, NotReadyMaxAttempts: 4, RetryDelay: time.Millisecond},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)
	coordinator.Enqueue("pod-a")

	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 1 })
	if got := executor.count("pod-a"); got != 4 {
		t.Fatalf("apply attempts = %d, want 4", got)
	}
}

// 坏镜像等「runtime not ready」Pod 会让 reconcile 长时间重试；锁必须在每次尝试之间
// 释放，否则会饿死用户的升级/删除操作。这里验证重试间隙外部 RunExclusive 能快速拿到锁。
func TestCoordinatorReleasesLockBetweenNotReadyRetries(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	executor.notReadyFailures = 1 << 20 // 始终 not-ready
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, NotReadyMaxAttempts: 100000, RetryDelay: 50 * time.Millisecond},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)
	coordinator.Enqueue("pod-a")

	// 等第一个 not-ready 尝试完成并进入重试等待（锁已释放）
	time.Sleep(120 * time.Millisecond)

	opCtx, opCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer opCancel()
	start := time.Now()
	if err := coordinator.RunExclusive(opCtx, "pod-a", func(context.Context) error { return nil }); err != nil {
		t.Fatalf("RunExclusive blocked across not-ready retries: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 400*time.Millisecond {
		t.Fatalf("lock held across not-ready retries: op took %v", elapsed)
	}
}

type coordinatorHook struct {
	podIDs []string
	err    error
}

func (hook *coordinatorHook) BeforeApply(_ context.Context, podID string) error {
	hook.podIDs = append(hook.podIDs, podID)
	return hook.err
}

type coordinatorStore struct {
	mu                      sync.Mutex
	pods                    map[string]repo.Pod
	recovery                []repo.Pod
	failures                map[string]int
	conflictFirstCompletion bool
}

func newCoordinatorStore(podIDs ...string) *coordinatorStore {
	store := &coordinatorStore{pods: map[string]repo.Pod{}, failures: map[string]int{}}
	for _, podID := range podIDs {
		store.pods[podID] = repo.Pod{PodID: podID, ConfigGeneration: 1, State: repo.PodStateRunning}
	}
	return store
}

func (store *coordinatorStore) setState(podID, state string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	pod.State = state
	store.pods[podID] = pod
}

func (store *coordinatorStore) GetPod(podID string) (repo.Pod, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod, ok := store.pods[podID]
	if !ok {
		return repo.Pod{}, repo.ErrNotFound
	}
	return pod, nil
}

func (store *coordinatorStore) StartPodConfigApply(podID string, generation int64) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	if pod.ConfigGeneration != generation || pod.AppliedGeneration >= generation {
		return repo.ErrGenerationConflict
	}
	pod.LastApplyStatus = repo.ApplyStatusApplying
	store.pods[podID] = pod
	return nil
}

func (store *coordinatorStore) CompletePodConfigApply(
	podID string, generation int64, _ string, _ time.Time,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	if store.conflictFirstCompletion {
		store.conflictFirstCompletion = false
		pod.ConfigGeneration++
		store.pods[podID] = pod
		return repo.ErrGenerationConflict
	}
	if pod.ConfigGeneration != generation {
		return repo.ErrGenerationConflict
	}
	pod.AppliedGeneration = generation
	pod.LastApplyStatus = repo.ApplyStatusApplied
	store.pods[podID] = pod
	return nil
}

func (store *coordinatorStore) ClearPodSkillsPending(podID string, generation int64) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	if pod.ConfigGeneration != generation {
		return repo.ErrGenerationConflict
	}
	pod.SkillsPending = false
	store.pods[podID] = pod
	return nil
}

func (store *coordinatorStore) FailPodConfigApply(podID string, generation int64, _ string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	if pod.ConfigGeneration != generation {
		return repo.ErrGenerationConflict
	}
	store.failures[podID]++
	return nil
}

func (store *coordinatorStore) ListPodsNeedingApply() ([]repo.Pod, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]repo.Pod(nil), store.recovery...), nil
}

func (store *coordinatorStore) setGeneration(podID string, generation int64) {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	pod.ConfigGeneration = generation
	store.pods[podID] = pod
}

func (store *coordinatorStore) setAppliedGeneration(podID string, generation int64) {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	pod.AppliedGeneration = generation
	store.pods[podID] = pod
}

func (store *coordinatorStore) setSkillsPending(podID string, pending bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	pod := store.pods[podID]
	pod.SkillsPending = pending
	store.pods[podID] = pod
}

func (store *coordinatorStore) skillsPending(podID string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.pods[podID].SkillsPending
}

func (store *coordinatorStore) appliedGeneration(podID string) int64 {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.pods[podID].AppliedGeneration
}

func (store *coordinatorStore) failedCount(podID string) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.failures[podID]
}

type coordinatorBuilder struct{ store *coordinatorStore }

func (builder coordinatorBuilder) Build(podID string) (runtimeconfig.Result, error) {
	pod, err := builder.store.GetPod(podID)
	if err != nil {
		return runtimeconfig.Result{}, err
	}
	raw := []byte(fmt.Sprintf(`{"podId":%q,"generation":%d}`, podID, pod.ConfigGeneration))
	return runtimeconfig.Result{
		Config:        driver.RuntimeConfigV1{PodID: podID, Generation: pod.ConfigGeneration},
		CanonicalJSON: raw, Hash: fmt.Sprintf("dto-%d", pod.ConfigGeneration),
	}, nil
}

type coordinatorExecutor struct {
	mu               sync.Mutex
	byPod            map[string][]int64
	active           int
	maxActive        int
	block            chan struct{}
	applyError       error
	notReadyFailures int
}

func newCoordinatorExecutor() *coordinatorExecutor {
	return &coordinatorExecutor{byPod: map[string][]int64{}}
}

func (executor *coordinatorExecutor) Apply(ctx context.Context, request Request) (Result, error) {
	executor.mu.Lock()
	executor.byPod[request.PodID] = append(executor.byPod[request.PodID], request.Generation)
	executor.active++
	if executor.active > executor.maxActive {
		executor.maxActive = executor.active
	}
	block := executor.block
	executor.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
		}
	}
	executor.mu.Lock()
	executor.active--
	err := executor.applyError
	if executor.notReadyFailures > 0 {
		executor.notReadyFailures--
		err = driver.ErrRuntimeNotReady
	}
	executor.mu.Unlock()
	return Result{ConfigHash: fmt.Sprintf("config-%d", request.Generation)}, err
}

func (executor *coordinatorExecutor) count(podID string) int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return len(executor.byPod[podID])
}

func (executor *coordinatorExecutor) generations(podID string) []int64 {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return append([]int64(nil), executor.byPod[podID]...)
}

func (executor *coordinatorExecutor) activeCount() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.active
}

func (executor *coordinatorExecutor) maxActiveCount() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.maxActive
}

func newTestCoordinator(
	t *testing.T, store *coordinatorStore, executor *coordinatorExecutor, attempts int,
) *Coordinator {
	t.Helper()
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: attempts, RetryDelay: time.Millisecond},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	return coordinator
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func stopCoordinator(cancel context.CancelFunc, _ *Coordinator, _ context.Context) {
	cancel()
	time.Sleep(2 * time.Millisecond)
}

// 周期 rescan：新出现（或瞬时失败后仍待收敛）的 Pod 不需要显式 Enqueue 也会被拾起。
func TestCoordinatorRescanPicksUpNewlyNeededPods(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.recovery = []repo.Pod{{PodID: "pod-a", State: repo.PodStateRunning}}
	executor := newCoordinatorExecutor()
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, RetryDelay: time.Millisecond, RescanInterval: 10 * time.Millisecond},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	// 初始恢复扫描消费一次。
	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 1 })

	// 新 generation 出现但无显式 Enqueue → 周期 rescan 必须拾起。
	store.setGeneration("pod-a", 2)
	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 2 })
	if got := executor.generations("pod-a"); fmt.Sprint(got) != "[1 2]" {
		t.Fatalf("applied generations = %v, want [1 2]", got)
	}
}

func TestCoordinatorEnqueueIfIdleSkipsRunningPod(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	executor := newCoordinatorExecutor()
	coordinator := newTestCoordinator(t, store, executor, 1)

	coordinator.mu.Lock()
	coordinator.running["pod-a"] = true
	coordinator.mu.Unlock()
	coordinator.enqueueIfIdle("pod-a")
	coordinator.mu.Lock()
	pending := coordinator.pending["pod-a"]
	coordinator.mu.Unlock()
	if pending {
		t.Fatal("running pod must not be re-enqueued by rescan")
	}

	coordinator.mu.Lock()
	delete(coordinator.running, "pod-a")
	coordinator.mu.Unlock()
	coordinator.enqueueIfIdle("pod-a")
	coordinator.mu.Lock()
	pending = coordinator.pending["pod-a"]
	coordinator.mu.Unlock()
	if !pending {
		t.Fatal("idle pod should be enqueued by rescan")
	}
}

// stopped 态 Pod 收到配置变更：跳过、不重试、不写 failed；start 后收敛。
func TestCoordinatorSkipsStoppedPodWithoutFailing(t *testing.T) {
	store := newCoordinatorStore("pod-a")
	store.setState("pod-a", repo.PodStateStopped)
	executor := newCoordinatorExecutor()
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 3, NotReadyMaxAttempts: 60, RetryDelay: time.Millisecond},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)
	coordinator.Enqueue("pod-a")

	time.Sleep(20 * time.Millisecond)
	if executor.count("pod-a") != 0 {
		t.Fatalf("stopped pod must not be applied: %d", executor.count("pod-a"))
	}
	if store.failedCount("pod-a") != 0 {
		t.Fatalf("stopped pod must not be marked failed: %d", store.failedCount("pod-a"))
	}

	// start 后收敛路径。
	store.setState("pod-a", repo.PodStateRunning)
	coordinator.Enqueue("pod-a")
	waitFor(t, func() bool { return store.appliedGeneration("pod-a") == 1 })
}

// runPod panic 必须被 recover：转为该 Pod 的失败记录并清理 running 状态，
// 进程不退出、其余 Pod 继续 apply。
func TestCoordinatorRecoversFromRunPodPanic(t *testing.T) {
	store := newCoordinatorStore("pod-a", "pod-b")
	executor := &panicOnceCoordinatorExecutor{}
	coordinator, err := NewCoordinator(
		store, coordinatorBuilder{store: store}, executor,
		CoordinatorOptions{MaxAttempts: 1, RetryDelay: time.Millisecond, RescanInterval: time.Hour},
	)
	if err != nil {
		t.Fatalf("NewCoordinator: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer stopCoordinator(cancel, coordinator, ctx)
	go coordinator.Run(ctx)

	coordinator.Enqueue("pod-a")
	// panic 被 recover 并转成失败记录。
	waitFor(t, func() bool { return store.failedCount("pod-a") == 1 })
	coordinator.mu.Lock()
	_, stillRunning := coordinator.running["pod-a"]
	coordinator.mu.Unlock()
	if stillRunning {
		t.Fatal("running state was not cleaned up after panic")
	}

	// 控制面未退出，其他 Pod 仍可正常 apply。
	coordinator.Enqueue("pod-b")
	waitFor(t, func() bool { return store.appliedGeneration("pod-b") == 1 })
}

// panicOnceCoordinatorExecutor 在第一次 Apply 时 panic，之后恢复正常。
type panicOnceCoordinatorExecutor struct {
	mu       sync.Mutex
	panicked bool
}

func (executor *panicOnceCoordinatorExecutor) Apply(_ context.Context, _ Request) (Result, error) {
	executor.mu.Lock()
	if !executor.panicked {
		executor.panicked = true
		executor.mu.Unlock()
		panic("boom: apply panicked")
	}
	executor.mu.Unlock()
	return Result{ConfigHash: "config-2"}, nil
}

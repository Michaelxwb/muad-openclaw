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

	waitFor(t, func() bool { return executor.count("pod-a") == 2 })
	if store.failedCount("pod-a") != 2 {
		t.Fatalf("failed status writes = %d", store.failedCount("pod-a"))
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
		store.pods[podID] = repo.Pod{PodID: podID, ConfigGeneration: 1}
	}
	return store
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

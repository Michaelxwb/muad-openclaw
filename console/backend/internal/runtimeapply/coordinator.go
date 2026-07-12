package runtimeapply

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

type CoordinatorStore interface {
	GetPod(podID string) (repo.Pod, error)
	StartPodConfigApply(podID string, generation int64) error
	CompletePodConfigApply(podID string, generation int64, hash string, appliedAt time.Time) error
	FailPodConfigApply(podID string, generation int64, message string) error
	ListPodsNeedingApply() ([]repo.Pod, error)
}

type RuntimeBuilder interface {
	Build(podID string) (runtimeconfig.Result, error)
}

type ApplyExecutor interface {
	Apply(ctx context.Context, request Request) (Result, error)
}

type CoordinatorOptions struct {
	MaxAttempts         int
	NotReadyMaxAttempts int
	RetryDelay          time.Duration
}

type Coordinator struct {
	store    CoordinatorStore
	builder  RuntimeBuilder
	executor ApplyExecutor
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
	return &Coordinator{
		store: store, builder: builder, executor: executor, options: options,
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

// Run recovers unconverged Pods and dispatches one serial worker per Pod.
func (coordinator *Coordinator) Run(ctx context.Context) {
	if !coordinator.markStarted() {
		return
	}
	coordinator.enqueueRecovery(ctx)
	for {
		coordinator.dispatch(ctx)
		select {
		case <-ctx.Done():
			coordinator.wg.Wait()
			return
		case <-coordinator.wake:
		}
	}
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
	for {
		err := coordinator.RunExclusive(ctx, podID, func(runCtx context.Context) error {
			return coordinator.reconcileWithRetry(runCtx, podID)
		})
		if err != nil && ctx.Err() == nil {
			log.Printf("runtime_reconcile_failed pod=%s error=%v", podID, err)
		}
		if !coordinator.repeatPending(ctx, podID) {
			return
		}
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

func (coordinator *Coordinator) reconcileWithRetry(ctx context.Context, podID string) error {
	var last error
	for attempt := 1; ; attempt++ {
		last = coordinator.reconcileOnce(ctx, podID)
		if last == nil || errors.Is(last, repo.ErrNotFound) {
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
	if pod.AppliedGeneration >= generation {
		return nil
	}
	if err := coordinator.store.StartPodConfigApply(podID, generation); err != nil {
		return err
	}
	result, err := coordinator.executor.Apply(ctx, Request{
		PodID: podID, Generation: generation, RuntimeJSON: built.CanonicalJSON,
	})
	if err != nil {
		return coordinator.recordFailure(podID, generation, err)
	}
	return coordinator.store.CompletePodConfigApply(podID, generation, result.ConfigHash, time.Now().UTC())
}

func (coordinator *Coordinator) recordBuildFailure(podID string, cause error) error {
	pod, err := coordinator.store.GetPod(podID)
	if err != nil {
		return errors.Join(cause, err)
	}
	return coordinator.recordFailure(podID, pod.ConfigGeneration, cause)
}

func (coordinator *Coordinator) recordFailure(podID string, generation int64, cause error) error {
	message := cause.Error()
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

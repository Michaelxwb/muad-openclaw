package usercleanup

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// fakeStore records how many times ListDeletingHumanUsers was called.
type wakeCountingStore struct {
	Store
	lists atomic.Int64
}

func (store *wakeCountingStore) ListDeletingHumanUsers(_ string) ([]repo.HumanUser, error) {
	store.lists.Add(1)
	return nil, nil
}

func TestCleaner_WakeTriggersImmediateSweep(t *testing.T) {
	store := &wakeCountingStore{Store: emptyStore{}}
	cleaner, err := New(store, noopRuntime{}, &noopCoordinator{}, time.Hour)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		cleaner.Run(ctx)
		close(done)
	}()

	// Run() performs an initial sweep before the select loop.
	deadline := time.Now().Add(2 * time.Second)
	for store.lists.Load() < 1 {
		if time.Now().After(deadline) {
			t.Fatal("initial sweep did not run")
		}
		time.Sleep(time.Millisecond)
	}

	cleaner.Wake()
	deadline = time.Now().Add(2 * time.Second)
	for store.lists.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("Wake() did not trigger an extra sweep")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCleaner_RetryTimerReWakesAfterShortInterval(t *testing.T) {
	store := &wakeCountingStore{Store: emptyStore{}}
	cleaner, err := New(store, noopRuntime{}, &noopCoordinator{}, time.Hour)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cleaner.retryAfter = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cleaner.Run(ctx)

	// Wait for the initial sweep, then schedule a retry and expect a second
	// sweep shortly after retryAfter (without any external Wake call).
	deadline := time.Now().Add(2 * time.Second)
	for store.lists.Load() < 1 {
		if time.Now().After(deadline) {
			t.Fatal("initial sweep did not run")
		}
		time.Sleep(time.Millisecond)
	}
	cleaner.scheduleRetry("pod-a")
	deadline = time.Now().Add(2 * time.Second)
	for store.lists.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("scheduled retry did not re-wake the cleaner")
		}
		time.Sleep(time.Millisecond)
	}
}

// emptyStore satisfies Store with no-op methods for wake tests.
type emptyStore struct{}

func (emptyStore) ListDeletingHumanUsers(_ string) ([]repo.HumanUser, error) {
	return nil, nil
}
func (emptyStore) GetPod(_ string) (repo.Pod, error) {
	return repo.Pod{}, repo.ErrNotFound
}
func (emptyStore) DeleteHumanUser(_ string) error {
	return nil
}

// noopRuntime satisfies Runtime without executing anything.
type noopRuntime struct{}

func (noopRuntime) Exec(_ context.Context, _ string, _ ...string) (string, error) {
	return "", nil
}

// noopCoordinator satisfies Coordinator without doing work.
type noopCoordinator struct{}

func (noopCoordinator) Enqueue(_ string) {}
func (noopCoordinator) RunExclusive(_ context.Context, _ string, _ func(context.Context) error) error {
	return nil
}

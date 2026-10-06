package runtimeupgrade

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestService(t *testing.T, options ...Option) (*Service, *Journal) {
	t.Helper()
	journal, err := NewJournal(filepath.Join(t.TempDir(), "runtime-upgrades"))
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	runner := newFakeRunner()
	clock := func() time.Time { return time.Date(2026, 10, 7, 1, 0, 0, 0, time.UTC) }
	id := func() string { return "op-test" }
	service, err := NewService(journal, runner, append([]Option{WithClock(clock, id)}, options...)...)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return service, journal
}

type fakeRunner struct {
	mu     sync.Mutex
	locks  map[string]*sync.Mutex
	events *[]string
}

func newFakeRunner() *fakeRunner {
	events := []string{}
	return &fakeRunner{locks: map[string]*sync.Mutex{}, events: &events}
}

func (runner *fakeRunner) RunExclusive(
	ctx context.Context, podID string, operation func(context.Context) error,
) error {
	runner.mu.Lock()
	lock := runner.locks[podID]
	if lock == nil {
		lock = &sync.Mutex{}
		runner.locks[podID] = lock
	}
	runner.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	*runner.events = append(*runner.events, "acquire:"+podID)
	return operation(ctx)
}

func (runner *fakeRunner) record(event string) {
	*runner.events = append(*runner.events, event)
}

func TestRunJournalsFailForwardPhases(t *testing.T) {
	runner := newFakeRunner()
	journal, err := NewJournal(filepath.Join(t.TempDir(), "runtime-upgrades"))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(journal, runner, WithClock(
		func() time.Time { return time.Date(2026, 10, 7, 1, 0, 0, 0, time.UTC) },
		func() string { return "op-test" },
	))
	if err != nil {
		t.Fatal(err)
	}
	quiesced := false
	service.quiescer = QuiescerFunc(func(context.Context, string) error {
		quiesced = true
		runner.record("quiesce")
		return nil
	})

	operation, err := service.Run(context.Background(), Request{
		PodID: "pod-a", SourceImage: "img:old", TargetImage: "img:new",
		Execute: func(ctx context.Context) error {
			if !service.Maintenance("pod-a") {
				t.Error("maintenance gate must be closed during the switch")
			}
			runner.record("execute")
			return nil
		},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !quiesced {
		t.Fatal("quiesce must run before the switch")
	}
	if operation.Phase != PhaseCompleted || operation.Maintenance {
		t.Fatalf("operation = %+v, want completed without maintenance", operation)
	}
	if service.Maintenance("pod-a") {
		t.Fatal("maintenance gate must reopen after completion")
	}
	events := *runner.events
	if len(events) != 3 || events[0] != "acquire:pod-a" || events[1] != "quiesce" || events[2] != "execute" {
		t.Fatalf("event order = %v", events)
	}
	stored, err := journal.Load("pod-a", "op-test")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.Phase != PhaseCompleted || stored.SourceImage != "img:old" || stored.TargetImage != "img:new" {
		t.Fatalf("stored operation = %+v", stored)
	}
}

func TestRunDrainFailureAbortsBeforeExecute(t *testing.T) {
	service, journal := newTestService(t)
	service.quiescer = QuiescerFunc(func(context.Context, string) error {
		return errors.New("task still running")
	})
	executed := false
	_, err := service.Run(context.Background(), Request{
		PodID: "pod-a", Execute: func(context.Context) error {
			executed = true
			return nil
		},
	})
	if err == nil || executed {
		t.Fatalf("drain failure must abort before execute (err=%v executed=%t)", err, executed)
	}
	stored, loadErr := journal.Load("pod-a", "op-test")
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if stored.Phase != PhaseFailed || stored.Maintenance {
		t.Fatalf("stored operation = %+v, want failed without maintenance", stored)
	}
	if service.Maintenance("pod-a") {
		t.Fatal("maintenance must reopen after drain failure")
	}
}

func TestRunPreflightFailureLeavesPodUntouched(t *testing.T) {
	service, journal := newTestService(t)
	runner := service.runner.(*fakeRunner)
	_, err := service.Run(context.Background(), Request{
		PodID: "pod-a",
		Preflight: func(context.Context) error {
			return errors.New("evidence missing")
		},
		Execute: func(context.Context) error {
			t.Fatal("execute must not run when preflight fails")
			return nil
		},
	})
	if err == nil {
		t.Fatal("preflight failure must reject the upgrade")
	}
	if len(*runner.events) != 0 {
		t.Fatalf("runner must not lock or run: %v", *runner.events)
	}
	unfinished, err := journal.Unfinished()
	if err != nil || len(unfinished) != 0 {
		t.Fatalf("no operation may be journaled on rejection: %v %v", unfinished, err)
	}
}

func TestRunExecuteFailureStopsInErrorWithoutRollback(t *testing.T) {
	service, journal := newTestService(t)
	operation, err := service.Run(context.Background(), Request{
		PodID: "pod-a", SourceImage: "img:old", TargetImage: "img:new",
		Execute: func(context.Context) error {
			return errors.New("gateway failed to start")
		},
	})
	if err == nil {
		t.Fatal("execute failure must surface")
	}
	if operation.Phase != PhaseFailed || operation.Maintenance {
		t.Fatalf("operation = %+v, want failed without maintenance", operation)
	}
	if !strings.Contains(operation.Error, "gateway failed to start") {
		t.Fatalf("operation error = %q", operation.Error)
	}
	stored, loadErr := journal.Load("pod-a", "op-test")
	if loadErr != nil || stored.Phase != PhaseFailed {
		t.Fatalf("stored = %+v err=%v", stored, loadErr)
	}
	if service.Maintenance("pod-a") {
		t.Fatal("maintenance must reopen after failure so the operator can repair")
	}
}

func TestRecoverFailsUnfinishedOperations(t *testing.T) {
	journal, err := NewJournal(filepath.Join(t.TempDir(), "runtime-upgrades"))
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Save(Operation{
		OperationID: "op-unfinished", PodID: "pod-a", Phase: PhaseStarting,
		Maintenance: true, StartedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	marked := []string{}
	service, err := NewService(journal, newFakeRunner(), WithPodErrorMarker(func(podID string) error {
		marked = append(marked, podID)
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := service.Recover(context.Background())
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if len(recovered) != 1 || recovered[0].PodID != "pod-a" || recovered[0].Phase != PhaseFailed {
		t.Fatalf("recovered = %+v", recovered)
	}
	if len(marked) != 1 || marked[0] != "pod-a" {
		t.Fatalf("markPodError calls = %v", marked)
	}
	unfinished, err := journal.Unfinished()
	if err != nil || len(unfinished) != 0 {
		t.Fatalf("unfinished after recover = %+v err=%v", unfinished, err)
	}
}

func TestConcurrentRunsSerializePerPod(t *testing.T) {
	service, _ := newTestService(t)
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondEntered := make(chan struct{})
	done := make(chan error, 2)

	go func() {
		_, err := service.Run(context.Background(), Request{
			PodID: "pod-a", Execute: func(context.Context) error {
				close(firstEntered)
				<-releaseFirst
				return nil
			},
		})
		done <- err
	}()
	<-firstEntered
	go func() {
		_, err := service.Run(context.Background(), Request{
			PodID: "pod-a", Execute: func(context.Context) error {
				close(secondEntered)
				return nil
			},
		})
		done <- err
	}()
	select {
	case <-secondEntered:
		t.Fatal("second upgrade must wait for the first (no concurrent switch)")
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-done; err != nil {
		t.Fatalf("first run: %v", err)
	}
	select {
	case <-secondEntered:
	case <-time.After(time.Second):
		t.Fatal("second upgrade must proceed after the first completes")
	}
	if err := <-done; err != nil {
		t.Fatalf("second run: %v", err)
	}
}

func TestJournalRejectsInvalidIdentity(t *testing.T) {
	journal, err := NewJournal(filepath.Join(t.TempDir(), "runtime-upgrades"))
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Save(Operation{OperationID: "../escape", PodID: "pod-a"}); err == nil {
		t.Fatal("path-like operation id must be rejected")
	}
	if err := journal.Save(Operation{OperationID: "op", PodID: "../escape"}); err == nil {
		t.Fatal("path-like pod id must be rejected")
	}
	if _, err := os.Stat(filepath.Join(journal.dir, "pod-a")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected save must not create directories: %v", err)
	}
}

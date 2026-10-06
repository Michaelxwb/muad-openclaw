package runtimeupgrade

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ExclusiveRunner serializes one Pod's runtime operations (the runtimeapply
// coordinator implements this).
type ExclusiveRunner interface {
	RunExclusive(ctx context.Context, podID string, operation func(context.Context) error) error
}

// Quiescer drains in-flight work (skills, long tasks, browser leases) before the
// old runtime is stopped. A drain failure aborts the upgrade before any state
// is rewritten.
type Quiescer interface {
	WaitDrained(ctx context.Context, podID string) error
}

// QuiescerFunc adapts a function to Quiescer.
type QuiescerFunc func(ctx context.Context, podID string) error

// WaitDrained implements Quiescer.
func (fn QuiescerFunc) WaitDrained(ctx context.Context, podID string) error {
	return fn(ctx, podID)
}

// Request describes one one-way upgrade. Preflight runs before any lock or
// state change (rejection keeps the pod untouched); Execute performs the
// switch.
type Request struct {
	PodID       string
	SourceImage string
	TargetImage string
	Preflight   func(ctx context.Context) error
	Execute     func(ctx context.Context) error
}

// Service runs and journals one-way upgrades and exposes the maintenance gate.
type Service struct {
	journal      *Journal
	runner       ExclusiveRunner
	quiescer     Quiescer
	markPodError func(podID string) error
	now          func() time.Time
	newID        func() string

	mu     sync.Mutex
	active map[string]Operation
}

// Option customizes the service (tests use the clock/id options).
type Option func(*Service)

// WithQuiescer drains in-flight work before the switch.
func WithQuiescer(quiescer Quiescer) Option {
	return func(service *Service) { service.quiescer = quiescer }
}

// WithPodErrorMarker records a failed pod so the coordinator stops reconciling
// it as a normal config update.
func WithPodErrorMarker(marker func(podID string) error) Option {
	return func(service *Service) { service.markPodError = marker }
}

// WithClock overrides time/id generation for deterministic tests.
func WithClock(now func() time.Time, newID func() string) Option {
	return func(service *Service) {
		if now != nil {
			service.now = now
		}
		if newID != nil {
			service.newID = newID
		}
	}
}

// NewService wires a journal and exclusive runner.
func NewService(journal *Journal, runner ExclusiveRunner, options ...Option) (*Service, error) {
	if journal == nil || runner == nil {
		return nil, errors.New("runtimeupgrade: journal and runner are required")
	}
	service := &Service{
		journal: journal,
		runner:  runner,
		now:     func() time.Time { return time.Now().UTC() },
		newID:   randomOperationID,
		active:  map[string]Operation{},
	}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// Run executes one fail-forward upgrade: preflight, maintenance freeze, drain,
// switch and journal phases. Any failure stops in error; nothing is rolled
// back.
func (service *Service) Run(ctx context.Context, request Request) (Operation, error) {
	if strings.TrimSpace(request.PodID) == "" || request.Execute == nil {
		return Operation{}, errors.New("runtimeupgrade: pod id and execute step are required")
	}
	if request.Preflight != nil {
		if err := request.Preflight(ctx); err != nil {
			return Operation{}, err
		}
	}
	var result Operation
	err := service.runner.RunExclusive(ctx, request.PodID, func(runCtx context.Context) error {
		operation := Operation{
			OperationID: service.newID(),
			PodID:       request.PodID,
			Phase:       PhasePrepared,
			SourceImage: request.SourceImage,
			TargetImage: request.TargetImage,
			Maintenance: true,
			StartedAt:   service.now(),
			UpdatedAt:   service.now(),
		}
		if err := service.journal.Save(operation); err != nil {
			return err
		}
		service.setActive(operation)
		defer service.clearActive(operation.PodID)

		fail := func(cause error) error {
			operation.Phase = PhaseFailed
			operation.Maintenance = false
			operation.Error = cause.Error()
			operation.UpdatedAt = service.now()
			if err := service.journal.Save(operation); err != nil {
				cause = errors.Join(cause, err)
			}
			result = operation
			return cause
		}
		if service.quiescer != nil {
			if err := service.quiescer.WaitDrained(runCtx, request.PodID); err != nil {
				return fail(fmt.Errorf("drain in-flight work: %w", err))
			}
		}
		operation.Phase = PhaseStarting
		operation.UpdatedAt = service.now()
		if err := service.journal.Save(operation); err != nil {
			return fail(err)
		}
		if err := request.Execute(runCtx); err != nil {
			return fail(err)
		}
		operation.Phase = PhaseCompleted
		operation.Maintenance = false
		operation.UpdatedAt = service.now()
		if err := service.journal.Save(operation); err != nil {
			return fail(err)
		}
		result = operation
		return nil
	})
	return result, err
}

// Maintenance reports whether writes for the pod must be frozen.
func (service *Service) Maintenance(podID string) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	operation, ok := service.active[podID]
	return ok && operation.Maintenance
}

// Recover marks unfinished operations (e.g. console restarted mid-upgrade) as
// failed, keeps their diagnostics, and asks the pod to stop in error. It never
// resumes or rolls back the switch.
func (service *Service) Recover(ctx context.Context) ([]Operation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	unfinished, err := service.journal.Unfinished()
	if err != nil {
		return nil, err
	}
	recovered := make([]Operation, 0, len(unfinished))
	for _, operation := range unfinished {
		operation.Phase = PhaseFailed
		operation.Maintenance = false
		operation.Error = "console restarted during upgrade; operator repair required (no rollback)"
		operation.UpdatedAt = service.now()
		if err := service.journal.Save(operation); err != nil {
			return recovered, err
		}
		if service.markPodError != nil {
			_ = service.markPodError(operation.PodID)
		}
		recovered = append(recovered, operation)
	}
	return recovered, nil
}

func (service *Service) setActive(operation Operation) {
	service.mu.Lock()
	defer service.mu.Unlock()
	service.active[operation.PodID] = operation
}

func (service *Service) clearActive(podID string) {
	service.mu.Lock()
	defer service.mu.Unlock()
	delete(service.active, podID)
}

func randomOperationID() string {
	var buffer [8]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return fmt.Sprintf("op-%d", time.Now().UnixNano())
	}
	return "op-" + hex.EncodeToString(buffer[:])
}

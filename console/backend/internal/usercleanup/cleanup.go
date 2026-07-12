// Package usercleanup removes private runtime state after deleting routes converge.
package usercleanup

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	defaultSweepInterval = 30 * time.Second
	maxParallelPods      = 4
)

const cleanupScript = `set -eu
state="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || exit 64
  agent="$1"; profile="$2"; shift 2
  case "$agent:$profile" in *[!a-z0-9:-]*|:*) exit 65;; esac
  rm -rf -- "$state/workspace-$agent" "$state/agents/$agent" "$state/browser/$profile"
done`

type Store interface {
	ListDeletingHumanUsers(podID string) ([]repo.HumanUser, error)
	GetPod(podID string) (repo.Pod, error)
	DeleteHumanUser(humanUserID string) error
}

type Runtime interface {
	Exec(ctx context.Context, podID string, cmd ...string) (string, error)
}

type Coordinator interface {
	Enqueue(podID string)
	RunExclusive(ctx context.Context, podID string, operation func(context.Context) error) error
}

type Result struct {
	Deleted int
	Retry   int
}

type Cleaner struct {
	store       Store
	runtime     Runtime
	coordinator Coordinator
	interval    time.Duration
}

func New(store Store, runtime Runtime, coordinator Coordinator, interval time.Duration) (*Cleaner, error) {
	if store == nil || runtime == nil || coordinator == nil {
		return nil, errors.New("usercleanup: dependencies are required")
	}
	if interval <= 0 {
		interval = defaultSweepInterval
	}
	return &Cleaner{store: store, runtime: runtime, coordinator: coordinator, interval: interval}, nil
}

func (cleaner *Cleaner) Run(ctx context.Context) {
	cleaner.runSweep(ctx)
	ticker := time.NewTicker(cleaner.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleaner.runSweep(ctx)
		}
	}
}

func (cleaner *Cleaner) runSweep(ctx context.Context) {
	result, err := cleaner.Sweep(ctx)
	if err != nil {
		log.Printf("human_user_cleanup_failed retry=%d error=%s", result.Retry, auditlog.RedactDiagnostic(err.Error()))
	}
}

func (cleaner *Cleaner) Sweep(ctx context.Context) (Result, error) {
	users, err := cleaner.store.ListDeletingHumanUsers("")
	if err != nil {
		return Result{}, err
	}
	groups := groupByPod(users)
	results := make(chan podResult, len(groups))
	limit := make(chan struct{}, maxParallelPods)
	var wait sync.WaitGroup
	for podID, group := range groups {
		wait.Add(1)
		go func(id string, pending []repo.HumanUser) {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			results <- cleaner.cleanPod(ctx, id, pending)
		}(podID, group)
	}
	wait.Wait()
	close(results)
	return aggregateResults(results)
}

type podResult struct {
	deleted int
	retry   int
	err     error
}

func (cleaner *Cleaner) cleanPod(ctx context.Context, podID string, users []repo.HumanUser) podResult {
	pod, err := cleaner.store.GetPod(podID)
	if err != nil {
		return podResult{retry: len(users), err: err}
	}
	if !readyForCleanup(pod) {
		cleaner.coordinator.Enqueue(podID)
		return podResult{retry: len(users)}
	}
	var deleted int
	err = cleaner.coordinator.RunExclusive(ctx, podID, func(runCtx context.Context) error {
		current, getErr := cleaner.store.GetPod(podID)
		if getErr != nil {
			return getErr
		}
		if !readyForCleanup(current) {
			cleaner.coordinator.Enqueue(podID)
			return errors.New("Pod configuration is not converged")
		}
		deleted, getErr = cleaner.removePrivateState(runCtx, podID, users)
		return getErr
	})
	return podResult{deleted: deleted, retry: len(users) - deleted, err: err}
}

func readyForCleanup(pod repo.Pod) bool {
	return (pod.State == repo.PodStateRunning || pod.State == repo.PodStateUnhealthy) &&
		pod.AppliedGeneration >= pod.ConfigGeneration
}

func (cleaner *Cleaner) removePrivateState(
	ctx context.Context, podID string, users []repo.HumanUser,
) (int, error) {
	command := []string{"sh", "-c", cleanupScript, "muad-user-cleanup"}
	for _, user := range users {
		command = append(command, user.AgentID, user.BrowserProfile)
	}
	if _, err := cleaner.runtime.Exec(ctx, podID, command...); err != nil {
		return 0, fmt.Errorf("clean Pod private state: %w", err)
	}
	deleted := 0
	for _, user := range users {
		if err := cleaner.store.DeleteHumanUser(user.HumanUserID); err != nil {
			return deleted, fmt.Errorf("delete Human User record: %w", err)
		}
		deleted++
	}
	return deleted, nil
}

func groupByPod(users []repo.HumanUser) map[string][]repo.HumanUser {
	groups := make(map[string][]repo.HumanUser)
	for _, user := range users {
		groups[user.PodID] = append(groups[user.PodID], user)
	}
	return groups
}

func aggregateResults(input <-chan podResult) (Result, error) {
	var result Result
	var failures []error
	for item := range input {
		result.Deleted += item.deleted
		result.Retry += item.retry
		if item.err != nil {
			failures = append(failures, item.err)
		}
	}
	return result, errors.Join(failures...)
}

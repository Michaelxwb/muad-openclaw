package test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/usercleanup"
)

func TestUserCleanup_DeletesPrivateStateOnlyAfterGenerationConverges(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 2)
	if err := store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("set Pod running: %v", err)
	}
	user := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.MarkHumanUserDeleting(user.HumanUserID); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	markPodApplied(t, store, "pod-a")
	driver, queue := newFakeDriver(), &fakeReconcileQueue{}
	cleaner, err := usercleanup.New(store, driver, queue, time.Millisecond)
	if err != nil {
		t.Fatalf("New cleaner: %v", err)
	}
	result, err := cleaner.Sweep(context.Background())
	if err != nil || result.Deleted != 1 || result.Retry != 0 {
		t.Fatalf("Sweep = %+v, %v", result, err)
	}
	if _, err := store.GetHumanUser(user.HumanUserID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("Human User still exists: %v", err)
	}
	if len(driver.execCalls) != 1 || driver.execCalls[0].podID != "pod-a" ||
		!strings.Contains(strings.Join(driver.execCalls[0].cmd, " "), "alice") {
		t.Fatalf("cleanup command = %+v", driver.execCalls)
	}
}

func TestUserCleanup_OfflineAndFailuresRemainRetryable(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 1)
	user := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.MarkHumanUserDeleting(user.HumanUserID); err != nil {
		t.Fatalf("mark deleting: %v", err)
	}
	driver, queue := newFakeDriver(), &fakeReconcileQueue{}
	cleaner, _ := usercleanup.New(store, driver, queue, time.Millisecond)
	result, err := cleaner.Sweep(context.Background())
	if err != nil || result.Retry != 1 || len(queue.podIDs) != 1 {
		t.Fatalf("offline Sweep = %+v queue=%v error=%v", result, queue.podIDs, err)
	}
	if err := store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("set Pod running: %v", err)
	}
	markPodApplied(t, store, "pod-a")
	driver.cleanupErr = errors.New("simulated cleanup failure")
	result, err = cleaner.Sweep(context.Background())
	if err == nil || result.Retry != 1 {
		t.Fatalf("failed Sweep = %+v, %v", result, err)
	}
	if _, getErr := store.GetHumanUser(user.HumanUserID); getErr != nil {
		t.Fatalf("retryable user was deleted: %v", getErr)
	}
}

func markPodApplied(t *testing.T, store *repo.Store, podID string) {
	t.Helper()
	pod, err := store.GetPod(podID)
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if err := store.StartPodConfigApply(podID, pod.ConfigGeneration); err != nil {
		t.Fatalf("StartPodConfigApply: %v", err)
	}
	if err := store.CompletePodConfigApply(podID, pod.ConfigGeneration, "hash", time.Now().UTC()); err != nil {
		t.Fatalf("CompletePodConfigApply: %v", err)
	}
}

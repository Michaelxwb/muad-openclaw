package repo

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCompletePodConfigApplyClearsSkillsPending(t *testing.T) {
	store := newPodTestStore(t)
	pod := Pod{PodID: "pod-a", DisplayName: "A", ServiceTokenEnc: "enc", ServiceTokenFingerprint: "sha256:a"}
	if err := store.CreatePod(pod); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	generation, err := store.MarkPodSkillsPending("pod-a")
	if err != nil {
		t.Fatalf("MarkPodSkillsPending: %v", err)
	}
	if err := store.StartPodConfigApply("pod-a", generation); err != nil {
		t.Fatalf("StartPodConfigApply: %v", err)
	}
	if err := store.CompletePodConfigApply("pod-a", generation, "sha256:ok", time.Now().UTC()); err != nil {
		t.Fatalf("CompletePodConfigApply: %v", err)
	}

	got, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if got.SkillsPending || got.AppliedGeneration != generation {
		t.Fatalf("unexpected completed Pod state: %+v", got)
	}
}

func TestListPodsNeedingApplyIncludesPendingOnlyPod(t *testing.T) {
	store := newPodTestStore(t)
	pod := Pod{PodID: "pod-a", DisplayName: "A", ServiceTokenEnc: "enc", ServiceTokenFingerprint: "sha256:a"}
	if err := store.CreatePod(pod); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	if _, err := store.db.Exec(`UPDATE pods SET applied_generation = config_generation,
		last_apply_status = 'applied', skills_pending = 1 WHERE pod_id = ?`, "pod-a"); err != nil {
		t.Fatalf("force pending-only state: %v", err)
	}

	pods, err := store.ListPodsNeedingApply()
	if err != nil {
		t.Fatalf("ListPodsNeedingApply: %v", err)
	}
	if len(pods) != 1 || pods[0].PodID != "pod-a" || !pods[0].SkillsPending {
		t.Fatalf("pending Pods = %+v", pods)
	}
}

func newPodTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

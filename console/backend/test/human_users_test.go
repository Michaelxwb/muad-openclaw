package test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestHumanUser_CreateAllocatesPortsAndEnforcesCapacity(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 2)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, store, "pod-a", "bob", repo.HumanUserStatusPending)
	if alice.BrowserCDPPort != 18802 || bob.BrowserCDPPort != 18803 {
		t.Fatalf("ports = %d/%d, want 18802/18803", alice.BrowserCDPPort, bob.BrowserCDPPort)
	}
	_, err := store.CreateHumanUser(repo.HumanUser{
		PodID: "pod-a", DisplayName: "Charlie", AgentID: "charlie",
		BrowserProfile: "charlie", Status: repo.HumanUserStatusPending,
	}, 18802, 18810)
	if !errors.Is(err, repo.ErrPodCapacity) {
		t.Fatalf("third user error = %v, want ErrPodCapacity", err)
	}
	items, total, err := store.ListHumanUsersByPod("pod-a", repo.HumanUserListFilter{})
	if err != nil || total != 2 || len(items) != 2 {
		t.Fatalf("ListHumanUsersByPod = %d/%d, %v", len(items), total, err)
	}
	pods, _, err := store.ListPods(repo.PodListFilter{Query: "pod-a"})
	if err != nil || len(pods) != 1 || pods[0].UserCount != 2 || pods[0].AvailableSlots != 0 {
		t.Fatalf("Pod capacity summary = %+v, %v", pods, err)
	}
	pod, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if err := store.UpdatePod("pod-a", podUpdateFrom(pod, 1)); !errors.Is(err, repo.ErrPodCapacity) {
		t.Fatalf("lower maxUsers error = %v, want ErrPodCapacity", err)
	}
	storedAlice, err := store.GetHumanUser(alice.HumanUserID)
	if err != nil || storedAlice.BrowserCDPPort != 18802 {
		t.Fatalf("stable Alice Browser port = %d, %v", storedAlice.BrowserCDPPort, err)
	}
}

func TestHumanUser_IdentityBootstrapIsAtomic(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	identity := repo.UserIdentity{
		Channel: "wecom", OpenClawChannel: "wecom", AccountID: "default",
		ExternalID: "shared", ExternalIDType: "corp_userid", PeerKind: "direct",
	}
	result, err := store.CreateHumanUserWithIdentity(repo.HumanUser{
		PodID: "pod-a", DisplayName: "Alice", AgentID: "alice", BrowserProfile: "alice",
	}, identity, 18802, 18810)
	if err != nil || result.Identity == nil || result.HumanUser.Status != repo.HumanUserStatusActive {
		t.Fatalf("bootstrap = %+v, %v", result, err)
	}
	_, err = store.CreateHumanUserWithIdentity(repo.HumanUser{
		PodID: "pod-a", DisplayName: "Bob", AgentID: "bob", BrowserProfile: "bob",
	}, identity, 18802, 18810)
	if !errors.Is(err, repo.ErrIdentityExists) {
		t.Fatalf("duplicate identity error = %v", err)
	}
	users, total, _ := store.ListHumanUsersByPod("pod-a", repo.HumanUserListFilter{})
	pod, _ := store.GetPod("pod-a")
	if total != 1 || len(users) != 1 || pod.ConfigGeneration != 2 {
		t.Fatalf("failed bootstrap was not rolled back: users=%d/%d pod=%+v", len(users), total, pod)
	}
}

func TestHumanUser_BindingBootstrapReturnsPlainCodeOnce(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 2)
	codec := bindingCodec(t)
	result, err := store.CreateHumanUserWithBindingCode(codec, repo.HumanUser{
		PodID: "pod-a", DisplayName: "Charlie", AgentID: "charlie", BrowserProfile: "charlie",
	}, repo.BindingCodeRequest{
		Channel: "wecom", OpenClawChannel: "wecom", AccountID: "default",
		Purpose: repo.BindingPurposeFirstIdentity, ExpiresAt: time.Now().Add(time.Hour),
	}, 18802, 18810)
	if err != nil || result.BindingCode == nil || result.PlainCode == "" {
		t.Fatalf("binding bootstrap = %+v, %v", result, err)
	}
	codes, err := store.ListBindingCodesByHumanUser(result.HumanUser.HumanUserID)
	if err != nil || len(codes) != 1 || codes[0].CodeHash == result.PlainCode {
		t.Fatalf("stored binding code = %+v, %v", codes, err)
	}
	if result.HumanUser.Status != repo.HumanUserStatusPending || result.HumanUser.BrowserCDPPort != 18802 {
		t.Fatalf("unexpected pending user: %+v", result.HumanUser)
	}
}

func TestHumanUser_RejectsInvalidRuntimeIdentifiers(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	for _, agentID := range []string{"main", "quarantine", "Upper", "bad/path", "-leading"} {
		_, err := store.CreateHumanUser(repo.HumanUser{
			PodID: "pod-a", DisplayName: agentID, AgentID: agentID,
			BrowserProfile: "safe-profile", Status: repo.HumanUserStatusPending,
		}, 18802, 18810)
		if !errors.Is(err, repo.ErrInvalidHumanUser) {
			t.Errorf("agent %q error = %v, want ErrInvalidHumanUser", agentID, err)
		}
	}
}

func TestHumanUser_ReenableAndPodCapacityShareOneRule(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 1)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.UpdateHumanUser(alice.HumanUserID, repo.HumanUserUpdate{
		DisplayName: "Alice", Status: repo.HumanUserStatusDisabled,
	}); err != nil {
		t.Fatalf("disable Alice: %v", err)
	}
	createTestHumanUser(t, store, "pod-a", "bob", repo.HumanUserStatusPending)
	if err := store.UpdateHumanUser(alice.HumanUserID, repo.HumanUserUpdate{
		DisplayName: "Alice", Status: repo.HumanUserStatusActive,
	}); !errors.Is(err, repo.ErrPodCapacity) {
		t.Fatalf("re-enable error = %v, want ErrPodCapacity", err)
	}
	pod, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if err := store.UpdatePod("pod-a", podUpdateFrom(pod, 0)); !errors.Is(err, repo.ErrInvalidCapacity) {
		t.Fatalf("maxUsers=0 error = %v, want ErrInvalidCapacity", err)
	}
}

func TestHumanUser_DeletingRequiresCleanupBeforePhysicalDelete(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 1)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.DeleteHumanUser(alice.HumanUserID); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("direct delete error = %v, want ErrInvalidStateTransition", err)
	}
	if err := store.MarkHumanUserDeleting(alice.HumanUserID); err != nil {
		t.Fatalf("MarkHumanUserDeleting: %v", err)
	}
	deleting, err := store.ListDeletingHumanUsers("pod-a")
	if err != nil || len(deleting) != 1 {
		t.Fatalf("ListDeletingHumanUsers = %+v, %v", deleting, err)
	}
	if err := store.DeleteHumanUser(alice.HumanUserID); err != nil {
		t.Fatalf("DeleteHumanUser: %v", err)
	}
	if _, err := store.GetHumanUser(alice.HumanUserID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("GetHumanUser after delete = %v, want ErrNotFound", err)
	}
}

func TestHumanUser_ConcurrentCreateCannotExceedCapacity(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 1)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, agent := range []string{"alice", "bob"} {
		wg.Add(1)
		go func(agentID string) {
			defer wg.Done()
			_, err := store.CreateHumanUser(repo.HumanUser{
				PodID: "pod-a", DisplayName: agentID, AgentID: agentID,
				BrowserProfile: agentID, Status: repo.HumanUserStatusPending,
			}, 18802, 18810)
			errs <- err
		}(agent)
	}
	wg.Wait()
	close(errs)
	var succeeded, capacityErrors int
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, repo.ErrPodCapacity):
			capacityErrors++
		default:
			t.Fatalf("unexpected create error: %v", err)
		}
	}
	if succeeded != 1 || capacityErrors != 1 {
		t.Fatalf("success/capacity = %d/%d, want 1/1", succeeded, capacityErrors)
	}
}

func createTestPod(t *testing.T, store *repo.Store, podID string, maxUsers int) {
	t.Helper()
	err := store.CreatePod(repo.Pod{
		PodID: podID, DisplayName: podID, MaxUsers: maxUsers,
		ServiceTokenEnc: "enc-" + podID, ServiceTokenFingerprint: "sha256:" + podID,
	})
	if err != nil {
		t.Fatalf("CreatePod %s: %v", podID, err)
	}
}

func createTestHumanUser(t *testing.T, store *repo.Store, podID, agentID, status string) repo.HumanUser {
	t.Helper()
	user, err := store.CreateHumanUser(repo.HumanUser{
		PodID: podID, DisplayName: agentID, AgentID: agentID,
		BrowserProfile: agentID, Status: status,
	}, 18802, 18810)
	if err != nil {
		t.Fatalf("CreateHumanUser %s: %v", agentID, err)
	}
	return user
}

func podUpdateFrom(pod repo.Pod, maxUsers int) repo.PodUpdate {
	return repo.PodUpdate{
		DisplayName: pod.DisplayName, ImageTag: pod.ImageTag, MaxUsers: maxUsers,
		Channels: pod.Channels, ChannelConfigsEnc: pod.ChannelConfigsEnc,
		LLMOverrideEnc: pod.LLMOverrideEnc, MemLimit: pod.MemLimit,
		CPULimit: pod.CPULimit, RestartPolicy: pod.RestartPolicy,
		MaxSkillConcurrency:   pod.MaxSkillConcurrency,
		MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
	}
}

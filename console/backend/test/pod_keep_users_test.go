package test

import (
	"errors"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// TestDeletePodKeepsUsersUnbound covers the core contract: deleting a Pod
// detaches its Human Users (pod_id NULL, last_pod_id backfill, browser port
// released) and keeps their IM identities and private Skills, while pending
// binding codes cascade away with the Pod.
func TestDeletePodKeepsUsersUnbound(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestIdentity(t, store, alice, "default", "wx-alice")

	codec := bindingCodec(t)
	createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Hour))

	skill, err := store.CreateSkillAsset(repo.SkillAsset{
		Name: "xdr", Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
		Status: repo.SkillStatusActive, SourcePath: "/w", ManifestHash: "sha256:x",
		ManifestJSON: "{}", PlatformsJSON: "[]", EntryType: repo.SkillEntryManaged,
		Source: repo.SkillSourceUser,
	})
	if err != nil {
		t.Fatalf("CreateSkillAsset: %v", err)
	}

	if err := store.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}
	if _, err := store.GetPod("pod-a"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("GetPod after delete = %v, want ErrNotFound", err)
	}

	// User kept as unbound, remembering its last Pod, browser port released.
	stored, err := store.GetHumanUser(alice.HumanUserID)
	if err != nil {
		t.Fatalf("GetHumanUser: %v", err)
	}
	if stored.PodID != "" || stored.LastPodID != "pod-a" || stored.BrowserCDPPort != 0 {
		t.Fatalf("kept user = %+v, want unbound last_pod_id=pod-a port=0", stored)
	}

	// Identity survives (user-owned).
	identities, err := store.ListIdentitiesByHumanUser(alice.HumanUserID)
	if err != nil {
		t.Fatalf("ListIdentitiesByHumanUser: %v", err)
	}
	if len(identities) != 1 || identities[0].ExternalID != "wx-alice" {
		t.Fatalf("kept identities = %+v", identities)
	}

	// Private Skill survives (user-owned).
	got, err := store.GetSkillAsset(skill.SkillID)
	if err != nil {
		t.Fatalf("GetSkillAsset after delete: %v", err)
	}
	if got.HumanUserID != alice.HumanUserID {
		t.Fatalf("kept skill owner = %q", got.HumanUserID)
	}

	// Pending binding code was cascade-deleted with the Pod.
	codes, err := store.ListBindingCodesByHumanUser(alice.HumanUserID)
	if err != nil {
		t.Fatalf("ListBindingCodesByHumanUser: %v", err)
	}
	if len(codes) != 0 {
		t.Fatalf("binding codes survived Pod delete: %+v", codes)
	}
}

// TestRestorePodUsersReattaches covers recreate: unbound users whose last Pod
// matches are attached again (pod_id restored, agent_id unchanged, port
// reallocated).
func TestRestorePodUsersReattaches(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}

	createTestPod(t, store, "pod-a", 10)
	restorable, err := store.ListRestorableHumanUsers("pod-a")
	if err != nil {
		t.Fatalf("ListRestorableHumanUsers: %v", err)
	}
	if len(restorable) != 1 || restorable[0].AgentID != alice.AgentID {
		t.Fatalf("restorable users = %+v", restorable)
	}

	attached, err := store.AttachUsers([]string{alice.HumanUserID}, "pod-a", 18802, 18810)
	if err != nil {
		t.Fatalf("AttachUsers: %v", err)
	}
	if len(attached) != 1 || attached[0].PodID != "pod-a" || attached[0].LastPodID != "pod-a" {
		t.Fatalf("attached = %+v", attached)
	}
	if attached[0].BrowserCDPPort == 0 {
		t.Fatalf("attached user has no browser port: %+v", attached[0])
	}
	stored, err := store.GetHumanUser(alice.HumanUserID)
	if err != nil {
		t.Fatalf("GetHumanUser: %v", err)
	}
	if stored.PodID != "pod-a" || stored.AgentID != alice.AgentID {
		t.Fatalf("restored user = %+v", stored)
	}
}

// TestAttachUsersRequiresUnbound enforces the invariant that only unbound users
// may be attached; a user still bound to a running Pod is rejected.
func TestAttachUsersRequiresUnbound(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPod(t, store, "pod-b", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)

	if _, err := store.AttachUsers([]string{alice.HumanUserID}, "pod-b", 18802, 18810); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("attach bound user = %v, want ErrInvalidStateTransition", err)
	}
}

// TestAttachUsersRejectsAgentConflict ensures a target Pod cannot host two users
// with the same agent_id / browser_profile.
func TestAttachUsersRejectsAgentConflict(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPod(t, store, "pod-b", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	// pod-b already hosts an agent with the same id (same person on another Pod).
	createTestHumanUser(t, store, "pod-b", "alice", repo.HumanUserStatusActive)

	if err := store.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}
	if _, err := store.AttachUsers([]string{alice.HumanUserID}, "pod-b", 18802, 18810); !errors.Is(err, repo.ErrAgentAlreadyBound) {
		t.Fatalf("attach conflicting agent = %v, want ErrAgentAlreadyBound", err)
	}
}

// TestDeleteUnboundHumanUserDirect covers the synchronous delete path for a
// user whose Pod was deleted (no runtime to exec cleanup into).
func TestDeleteUnboundHumanUserDirect(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestIdentity(t, store, alice, "default", "wx-alice")
	if err := store.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}
	if err := store.DeleteUnboundHumanUser(alice.HumanUserID); err != nil {
		t.Fatalf("DeleteUnboundHumanUser: %v", err)
	}
	if _, err := store.GetHumanUser(alice.HumanUserID); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("user not removed: %v", err)
	}
	identities, err := store.ListIdentitiesByHumanUser(alice.HumanUserID)
	if err != nil {
		t.Fatalf("ListIdentitiesByHumanUser: %v", err)
	}
	if len(identities) != 0 {
		t.Fatalf("identities survived user delete: %+v", identities)
	}
}

// TestAttachUsersPreservesDisabledAndRejectsDeleting guards the state machine:
// a deleting user must not be revived by attach, and a disabled user must stay
// disabled (attach is not an explicit re-enable).
func TestAttachUsersPreservesDisabledAndRejectsDeleting(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPod(t, store, "pod-b", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, store, "pod-a", "bob", repo.HumanUserStatusActive)

	if err := store.UpdateHumanUser(alice.HumanUserID, repo.HumanUserUpdate{
		DisplayName: "Alice", Status: repo.HumanUserStatusDisabled,
	}); err != nil {
		t.Fatalf("disable Alice: %v", err)
	}
	if err := store.MarkHumanUserDeleting(bob.HumanUserID); err != nil {
		t.Fatalf("mark Bob deleting: %v", err)
	}
	if err := store.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}

	if _, err := store.AttachUsers([]string{bob.HumanUserID}, "pod-b", 18802, 18810); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("attach deleting user = %v, want ErrInvalidStateTransition", err)
	}

	attached, err := store.AttachUsers([]string{alice.HumanUserID}, "pod-b", 18802, 18810)
	if err != nil {
		t.Fatalf("AttachUsers disabled: %v", err)
	}
	if len(attached) != 1 || attached[0].Status != repo.HumanUserStatusDisabled {
		t.Fatalf("attached disabled user = %+v, want status disabled", attached)
	}
}

package test

import (
	"errors"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestIdentity_ScopedUniquenessAndExactExternalID(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPod(t, store, "pod-b", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	bob := createTestHumanUser(t, store, "pod-b", "bob", repo.HumanUserStatusPending)

	first := createTestIdentity(t, store, alice, "default", "Scoped-AbC")
	if _, err := store.CreateIdentity(identityFor(alice, "default", "Scoped-AbC")); !errors.Is(err, repo.ErrIdentityExists) {
		t.Fatalf("duplicate scoped Identity = %v, want ErrIdentityExists", err)
	}
	if _, err := store.CreateIdentity(identityFor(alice, "secondary", "Scoped-AbC")); err != nil {
		t.Fatalf("same external ID in another account: %v", err)
	}
	identities, err := store.ListIdentitiesByHumanUser(alice.HumanUserID)
	if err != nil || len(identities) != 2 {
		t.Fatalf("ListIdentitiesByHumanUser = %+v, %v", identities, err)
	}
	podIdentities, err := store.ListIdentitiesByPod("pod-a")
	if err != nil || len(podIdentities) != 2 {
		t.Fatalf("ListIdentitiesByPod = %+v, %v", podIdentities, err)
	}
	if _, err := store.CreateIdentity(identityFor(bob, "default", "Scoped-AbC")); err != nil {
		t.Fatalf("same external ID in another Pod: %v", err)
	}
	found, err := store.FindIdentityByExternalID("pod-a", "wecom", "default", "direct", "Scoped-AbC")
	if err != nil || found.IdentityID != first.IdentityID {
		t.Fatalf("exact lookup = %+v, %v", found, err)
	}
	if _, err := store.FindIdentityByExternalID("pod-a", "wecom", "default", "direct", "scoped-abc"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("lower-cased lookup = %v, want ErrNotFound", err)
	}
}

func TestIdentity_LastActiveIdentityControlsPendingState(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	first := createTestIdentity(t, store, alice, "default", "alice-1")
	second := createTestIdentity(t, store, alice, "secondary", "alice-2")
	assertHumanUserStatus(t, store, alice.HumanUserID, repo.HumanUserStatusActive)

	if err := store.UpdateIdentityStatus(first.IdentityID, repo.IdentityStatusDisabled); err != nil {
		t.Fatalf("disable first Identity: %v", err)
	}
	assertHumanUserStatus(t, store, alice.HumanUserID, repo.HumanUserStatusActive)
	if err := store.DeleteIdentity(second.IdentityID); err != nil {
		t.Fatalf("delete second Identity: %v", err)
	}
	assertHumanUserStatus(t, store, alice.HumanUserID, repo.HumanUserStatusPending)
	if err := store.UpdateIdentityStatus(first.IdentityID, repo.IdentityStatusActive); err != nil {
		t.Fatalf("re-enable first Identity: %v", err)
	}
	assertHumanUserStatus(t, store, alice.HumanUserID, repo.HumanUserStatusActive)
}

func TestIdentity_CannotEnableForDisabledHumanUser(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	identity, err := store.CreateIdentity(repo.UserIdentity{
		HumanUserID: alice.HumanUserID, PodID: alice.PodID, Channel: "wecom",
		OpenClawChannel: "wecom", ExternalID: "alice", ExternalIDType: "scoped_userid",
		Status: repo.IdentityStatusDisabled,
	})
	if err != nil {
		t.Fatalf("CreateIdentity: %v", err)
	}
	if err := store.UpdateHumanUser(alice.HumanUserID, repo.HumanUserUpdate{
		DisplayName: "Alice", Status: repo.HumanUserStatusDisabled,
	}); err != nil {
		t.Fatalf("disable Human User: %v", err)
	}
	if err := store.UpdateIdentityStatus(identity.IdentityID, repo.IdentityStatusActive); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("enable Identity error = %v, want ErrInvalidStateTransition", err)
	}
}

func createTestIdentity(
	t *testing.T, store *repo.Store, user repo.HumanUser, accountID, externalID string,
) repo.UserIdentity {
	t.Helper()
	identity, err := store.CreateIdentity(identityFor(user, accountID, externalID))
	if err != nil {
		t.Fatalf("CreateIdentity %s/%s: %v", accountID, externalID, err)
	}
	return identity
}

func identityFor(user repo.HumanUser, accountID, externalID string) repo.UserIdentity {
	return repo.UserIdentity{
		HumanUserID: user.HumanUserID, PodID: user.PodID, Channel: "wecom",
		OpenClawChannel: "wecom", AccountID: accountID, ExternalID: externalID,
		ExternalIDType: "scoped_userid", PeerKind: "direct", Status: repo.IdentityStatusActive,
	}
}

func assertHumanUserStatus(t *testing.T, store *repo.Store, humanUserID, want string) {
	t.Helper()
	user, err := store.GetHumanUser(humanUserID)
	if err != nil {
		t.Fatalf("GetHumanUser: %v", err)
	}
	if user.Status != want {
		t.Fatalf("Human User status = %q, want %q", user.Status, want)
	}
}

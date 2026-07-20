package test

import (
	"errors"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestBindingCode_ActivationIsAtomicAndOneTime(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	codec := bindingCodec(t)
	record, plain := createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Hour))
	if record.CodeHash == plain || record.CodeHint == plain {
		t.Fatal("binding-code record contains plaintext")
	}

	activation := bindingActivation(plain, "Scoped-Alice")
	result, err := store.ActivateBindingCode(codec, activation, time.Now().UTC())
	if err != nil {
		t.Fatalf("ActivateBindingCode: %v", err)
	}
	if result.HumanUser.Status != repo.HumanUserStatusActive || result.ConfigGeneration < 2 {
		t.Fatalf("unexpected activation result: %+v", result)
	}
	found, err := store.FindIdentityByExternalID("pod-a", "wecom", "default", "direct", "Scoped-Alice")
	if err != nil || found.HumanUserID != alice.HumanUserID {
		t.Fatalf("activated Identity = %+v, %v", found, err)
	}
	if _, err := store.ActivateBindingCode(codec, activation, time.Now().UTC()); !errors.Is(err, repo.ErrBindingCodeUsed) {
		t.Fatalf("replay error = %v, want ErrBindingCodeUsed", err)
	}
}

func TestBindingCode_WrongScopeCountsFailuresAndRevokes(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	codec := bindingCodec(t)
	record, plain := createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Hour))
	activation := bindingActivation(plain, "alice")
	activation.AccountID = "wrong-account"
	for attempt := 1; attempt <= 5; attempt++ {
		_, err := store.ActivateBindingCode(codec, activation, time.Now().UTC())
		if attempt < 5 && !errors.Is(err, repo.ErrBindingCodeScope) {
			t.Fatalf("attempt %d error = %v, want ErrBindingCodeScope", attempt, err)
		}
	}
	stored, err := store.GetBindingCode(record.BindingCodeID)
	if err != nil {
		t.Fatalf("GetBindingCode: %v", err)
	}
	if stored.Status != repo.BindingCodeStatusRevoked || stored.FailedAttempts != 5 {
		t.Fatalf("unexpected failed code state: %+v", stored)
	}
	if _, err := store.ActivateBindingCode(codec, bindingActivation(plain, "alice"), time.Now().UTC()); !errors.Is(err, repo.ErrBindingCodeRevoked) {
		t.Fatalf("revoked code error = %v, want ErrBindingCodeRevoked", err)
	}
}

func TestBindingCode_WrongPodIsRejected(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	codec := bindingCodec(t)
	record, plain := createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Hour))
	activation := bindingActivation(plain, "alice")
	activation.PodID = "pod-b"
	if _, err := store.ActivateBindingCode(codec, activation, time.Now().UTC()); !errors.Is(err, repo.ErrBindingCodeScope) {
		t.Fatalf("wrong Pod error = %v, want ErrBindingCodeScope", err)
	}
	stored, err := store.GetBindingCode(record.BindingCodeID)
	if err != nil || stored.FailedAttempts != 1 || stored.Status != repo.BindingCodeStatusPending {
		t.Fatalf("wrong Pod attempt state = %+v, %v", stored, err)
	}
}

func TestBindingCode_ExpiryAndExplicitRevoke(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	codec := bindingCodec(t)
	record, plain := createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Minute))
	if _, err := store.ActivateBindingCode(codec, bindingActivation(plain, "alice"), time.Now().Add(2*time.Minute)); !errors.Is(err, repo.ErrBindingCodeExpired) {
		t.Fatalf("expired activation = %v, want ErrBindingCodeExpired", err)
	}
	stored, err := store.GetBindingCode(record.BindingCodeID)
	if err != nil || stored.Status != repo.BindingCodeStatusExpired {
		t.Fatalf("stored expired code = %+v, %v", stored, err)
	}

	revoked, _ := createTestBindingCode(t, store, codec, alice, time.Now().Add(time.Hour))
	if err := store.RevokeBindingCode(revoked.BindingCodeID); err != nil {
		t.Fatalf("RevokeBindingCode: %v", err)
	}
	if err := store.RevokeBindingCode(revoked.BindingCodeID); !errors.Is(err, repo.ErrBindingCodeRevoked) {
		t.Fatalf("second revoke = %v, want ErrBindingCodeRevoked", err)
	}
}

func TestBindingCode_IdentityConflictRollsBackConsumption(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusPending)
	bob := createTestHumanUser(t, store, "pod-a", "bob", repo.HumanUserStatusPending)
	createTestIdentity(t, store, alice, "default", "shared-id")
	codec := bindingCodec(t)
	record, plain := createTestBindingCode(t, store, codec, bob, time.Now().Add(time.Hour))
	if _, err := store.ActivateBindingCode(codec, bindingActivation(plain, "shared-id"), time.Now().UTC()); !errors.Is(err, repo.ErrIdentityExists) {
		t.Fatalf("identity conflict = %v, want ErrIdentityExists", err)
	}
	stored, err := store.GetBindingCode(record.BindingCodeID)
	if err != nil || stored.Status != repo.BindingCodeStatusPending {
		t.Fatalf("conflicting activation consumed code: %+v, %v", stored, err)
	}
	assertHumanUserStatus(t, store, bob.HumanUserID, repo.HumanUserStatusPending)
}

func TestBindingCode_PurposeMustMatchUserStatus(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	codec := bindingCodec(t)

	// First-identity codes only activate pending users.
	active := createTestHumanUser(t, store, "pod-a", "active-user", repo.HumanUserStatusActive)
	firstForActive, plainFirst := createTestBindingCodeWithPurpose(
		t, store, codec, active, repo.BindingPurposeFirstIdentity, time.Now().Add(time.Hour),
	)
	if _, err := store.ActivateBindingCode(codec, bindingActivation(plainFirst, "active-ext"), time.Now().UTC()); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("first-identity on active user = %v, want ErrInvalidStateTransition", err)
	}
	if stored, err := store.GetBindingCode(firstForActive.BindingCodeID); err != nil || stored.Status != repo.BindingCodeStatusPending {
		t.Fatalf("first-identity mismatch consumed code: %+v, %v", stored, err)
	}

	// Add-identity codes only activate already-active users.
	pending := createTestHumanUser(t, store, "pod-a", "pending-user", repo.HumanUserStatusPending)
	addForPending, plainAdd := createTestBindingCodeWithPurpose(
		t, store, codec, pending, repo.BindingPurposeAddIdentity, time.Now().Add(time.Hour),
	)
	if _, err := store.ActivateBindingCode(codec, bindingActivation(plainAdd, "pending-ext"), time.Now().UTC()); !errors.Is(err, repo.ErrInvalidStateTransition) {
		t.Fatalf("add-identity on pending user = %v, want ErrInvalidStateTransition", err)
	}
	if stored, err := store.GetBindingCode(addForPending.BindingCodeID); err != nil || stored.Status != repo.BindingCodeStatusPending {
		t.Fatalf("add-identity mismatch consumed code: %+v, %v", stored, err)
	}

	// Matching purpose still succeeds for active + add_identity.
	okCode, plainOK := createTestBindingCodeWithPurpose(
		t, store, codec, active, repo.BindingPurposeAddIdentity, time.Now().Add(time.Hour),
	)
	result, err := store.ActivateBindingCode(codec, bindingActivation(plainOK, "second-id"), time.Now().UTC())
	if err != nil {
		t.Fatalf("matching add-identity: %v", err)
	}
	if result.HumanUser.HumanUserID != active.HumanUserID || result.HumanUser.Status != repo.HumanUserStatusActive {
		t.Fatalf("unexpected activation result: %+v", result)
	}
	if stored, err := store.GetBindingCode(okCode.BindingCodeID); err != nil || stored.Status != repo.BindingCodeStatusUsed {
		t.Fatalf("matching code status = %+v, %v", stored, err)
	}
}

func bindingCodec(t *testing.T) *crypto.BindingCodeCodec {
	t.Helper()
	codec, err := crypto.NewBindingCodeCodec("binding-test-master-key")
	if err != nil {
		t.Fatalf("NewBindingCodeCodec: %v", err)
	}
	return codec
}

func createTestBindingCode(
	t *testing.T, store *repo.Store, codec *crypto.BindingCodeCodec,
	user repo.HumanUser, expiresAt time.Time,
) (repo.BindingCode, string) {
	t.Helper()
	return createTestBindingCodeWithPurpose(
		t, store, codec, user, repo.BindingPurposeFirstIdentity, expiresAt,
	)
}

func createTestBindingCodeWithPurpose(
	t *testing.T, store *repo.Store, codec *crypto.BindingCodeCodec,
	user repo.HumanUser, purpose string, expiresAt time.Time,
) (repo.BindingCode, string) {
	t.Helper()
	record, plain, err := store.CreateBindingCode(codec, repo.BindingCodeRequest{
		HumanUserID: user.HumanUserID, PodID: user.PodID, Channel: "wecom",
		OpenClawChannel: "wecom", AccountID: "default",
		Purpose: purpose, ExpiresAt: expiresAt,
	})
	if err != nil {
		t.Fatalf("CreateBindingCode: %v", err)
	}
	return record, plain
}

func bindingActivation(code, externalID string) repo.BindingActivation {
	return repo.BindingActivation{
		Code: code, PodID: "pod-a", Channel: "wecom", OpenClawChannel: "wecom", AccountID: "default",
		ExternalID: externalID, ExternalIDType: "scoped_userid", PeerKind: "direct",
	}
}

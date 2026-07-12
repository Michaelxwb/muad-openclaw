package test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestPlatformConfig_SeedsAndCRUD(t *testing.T) {
	store := newStore(t)
	configs, err := store.ListPlatformConfigs()
	if err != nil {
		t.Fatalf("ListPlatformConfigs: %v", err)
	}
	if len(configs) != 5 {
		t.Fatalf("seeded platforms = %d, want 5", len(configs))
	}
	if err := store.CreatePlatformConfig(repo.PlatformConfig{
		Platform: "custom_api", DisplayName: "Custom API", ConfigEnc: "enc", Enabled: true,
	}); err != nil {
		t.Fatalf("CreatePlatformConfig: %v", err)
	}
	if err := store.UpdatePlatformConfig("custom_api", "Custom", "updated", false); err != nil {
		t.Fatalf("UpdatePlatformConfig: %v", err)
	}
	config, err := store.GetPlatformConfig("custom_api")
	if err != nil || config.DisplayName != "Custom" || config.Enabled || config.ConfigEnc != "updated" {
		t.Fatalf("GetPlatformConfig = %+v, %v", config, err)
	}
	if err := store.CreatePlatformConfig(repo.PlatformConfig{
		Platform: "Bad-Name", DisplayName: "Bad", Enabled: true,
	}); !errors.Is(err, repo.ErrInvalidPlatform) {
		t.Fatalf("invalid platform error = %v, want ErrInvalidPlatform", err)
	}
}

func TestPlatformConfig_UpdateAndPodGenerationAreAtomic(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 2)
	createTestPod(t, store, "pod-b", 2)
	podIDs, err := store.UpdatePlatformConfigAndMarkPods("xdr", "XDR Updated", "encrypted", true)
	if err != nil || len(podIDs) != 2 {
		t.Fatalf("UpdatePlatformConfigAndMarkPods = %v, %v", podIDs, err)
	}
	for _, podID := range []string{"pod-a", "pod-b"} {
		pod, getErr := store.GetPod(podID)
		if getErr != nil || pod.ConfigGeneration != 2 || pod.LastApplyStatus != repo.ApplyStatusPending {
			t.Fatalf("Pod %s generation = %+v, %v", podID, pod, getErr)
		}
	}
}

func TestPlatformCredential_EncryptedUpsertListResolveAndDelete(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	cipher := testCipher(t)

	first, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, "xdr", "xdr-key-one")
	if err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	if first.Platform != "xdr" || !strings.HasPrefix(first.KeyFingerprint, "sha256:") {
		t.Fatalf("unexpected summary: %+v", first)
	}
	if _, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, "xdr", "xdr-key-two"); err != nil {
		t.Fatalf("replace credential: %v", err)
	}
	summaries, err := store.ListUserPlatformCredentials(cipher, alice.HumanUserID)
	if err != nil || len(summaries) != 1 || summaries[0].KeyFingerprint == first.KeyFingerprint {
		t.Fatalf("credential summaries = %+v, %v", summaries, err)
	}
	stored, err := store.GetHumanUser(alice.HumanUserID)
	if err != nil || stored.PlatformCredentialsEnc == "" || strings.Contains(stored.PlatformCredentialsEnc, "xdr-key-two") {
		t.Fatalf("credential not encrypted at rest: %q, %v", stored.PlatformCredentialsEnc, err)
	}
	resolved, err := store.ResolveUserPlatformCredential(cipher, alice.HumanUserID, "xdr")
	if err != nil || resolved.APIKey != "xdr-key-two" {
		t.Fatalf("ResolveUserPlatformCredential = %+v, %v", resolved, err)
	}
	if err := store.DeleteUserPlatformCredential(cipher, alice.HumanUserID, "xdr"); err != nil {
		t.Fatalf("DeleteUserPlatformCredential: %v", err)
	}
	if _, err := store.ResolveUserPlatformCredential(cipher, alice.HumanUserID, "xdr"); !errors.Is(err, repo.ErrCredentialNotConfigured) {
		t.Fatalf("resolve deleted credential = %v, want ErrCredentialNotConfigured", err)
	}
}

func TestPlatformCredential_ConcurrentUpdatesDoNotLosePlatforms(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	cipher := testCipher(t)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for platform, key := range map[string]string{"xdr": "xdr-key", "mssw": "mssw-key"} {
		wg.Add(1)
		go func(platformName, apiKey string) {
			defer wg.Done()
			_, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, platformName, apiKey)
			errs <- err
		}(platform, key)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent upsert: %v", err)
		}
	}
	summaries, err := store.ListUserPlatformCredentials(cipher, alice.HumanUserID)
	if err != nil || len(summaries) != 2 || summaries[0].Platform != "mssw" || summaries[1].Platform != "xdr" {
		t.Fatalf("summaries = %+v, %v", summaries, err)
	}
}

func TestPlatformCredential_DisabledAndCorruptDataFailClosed(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	cipher := testCipher(t)
	if err := store.UpdatePlatformConfig("xdr", "XDR", "", false); err != nil {
		t.Fatalf("disable xdr: %v", err)
	}
	if _, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, "xdr", "key"); !errors.Is(err, repo.ErrPlatformDisabled) {
		t.Fatalf("disabled platform upsert = %v, want ErrPlatformDisabled", err)
	}

	corrupt, err := store.CreateHumanUser(repo.HumanUser{
		PodID: "pod-a", DisplayName: "Corrupt", AgentID: "corrupt",
		BrowserProfile: "corrupt", Status: repo.HumanUserStatusActive,
		PlatformCredentialsEnc: "not-ciphertext",
	}, 18802, 18810)
	if err != nil {
		t.Fatalf("CreateHumanUser corrupt fixture: %v", err)
	}
	if _, err := store.ListUserPlatformCredentials(cipher, corrupt.HumanUserID); err == nil {
		t.Fatal("corrupt encrypted credentials must not degrade to an empty list")
	}
}

func testCipher(t *testing.T) *crypto.Cipher {
	t.Helper()
	cipher, err := crypto.New("platform-test-master-key")
	if err != nil {
		t.Fatalf("crypto.New: %v", err)
	}
	return cipher
}

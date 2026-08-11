package test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestPlatformConfig_EmptyByDefaultAndCRUD(t *testing.T) {
	store := newStore(t)
	configs, err := store.ListPlatformConfigs()
	if err != nil {
		t.Fatalf("ListPlatformConfigs: %v", err)
	}
	if len(configs) != 0 {
		t.Fatalf("default platforms = %d, want 0", len(configs))
	}
	if err := store.CreatePlatformConfig(repo.PlatformConfig{
		Platform: "custom_api", DisplayName: "Custom API", Enabled: true,
	}); err != nil {
		t.Fatalf("CreatePlatformConfig: %v", err)
	}
	if err := store.UpdatePlatformConfig("custom_api", "Custom", false); err != nil {
		t.Fatalf("UpdatePlatformConfig: %v", err)
	}
	config, err := store.GetPlatformConfig("custom_api")
	if err != nil || config.DisplayName != "Custom" || config.Enabled {
		t.Fatalf("GetPlatformConfig = %+v, %v", config, err)
	}
	if err := store.CreatePlatformConfig(repo.PlatformConfig{
		Platform: "Bad-Name", DisplayName: "Bad", Enabled: true,
	}); !errors.Is(err, repo.ErrInvalidPlatform) {
		t.Fatalf("invalid platform error = %v, want ErrInvalidPlatform", err)
	}
	podIDs, err := store.DeletePlatformConfigAndMarkPods("custom_api")
	if err != nil || len(podIDs) != 0 {
		t.Fatalf("DeletePlatformConfigAndMarkPods = %v, %v", podIDs, err)
	}
	if _, err := store.GetPlatformConfig("custom_api"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("deleted platform error = %v, want ErrNotFound", err)
	}
}

func TestPlatformConfig_UpdateAndPodGenerationAreAtomic(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 2)
	createTestPod(t, store, "pod-b", 2)
	createTestPlatform(t, store, "xdr", "XDR")
	podIDs, err := store.UpdatePlatformConfigAndMarkPods("xdr", "XDR Updated", true)
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

func TestPlatformCredential_PlainJSONUpsertListResolveAndDelete(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPlatform(t, store, "xdr", "XDR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)

	first, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key-one",
	})
	if err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	if first.Platform != "xdr" || !strings.HasPrefix(first.CredentialFingerprint, "sha256:") {
		t.Fatalf("unexpected summary: %+v", first)
	}
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key-two",
	}); err != nil {
		t.Fatalf("replace credential: %v", err)
	}
	summaries, err := store.ListUserPlatformCredentials(alice.HumanUserID)
	if err != nil || len(summaries) != 1 || summaries[0].CredentialFingerprint == first.CredentialFingerprint {
		t.Fatalf("credential summaries = %+v, %v", summaries, err)
	}
	if !strings.Contains(summaries[0].CredentialsJSON, "xdr-key-two") {
		t.Fatalf("credential summary did not include plaintext JSON: %+v", summaries[0])
	}
	resolved, err := store.ResolveUserPlatformCredential(alice.HumanUserID, "xdr")
	if err != nil || !strings.Contains(resolved.CredentialsJSON, "xdr-key-two") {
		t.Fatalf("ResolveUserPlatformCredential = %+v, %v", resolved, err)
	}
	if err := store.DeleteUserPlatformCredential(alice.HumanUserID, "xdr"); err != nil {
		t.Fatalf("DeleteUserPlatformCredential: %v", err)
	}
	if _, err := store.ResolveUserPlatformCredential(alice.HumanUserID, "xdr"); !errors.Is(err, repo.ErrCredentialNotConfigured) {
		t.Fatalf("resolve deleted credential = %v, want ErrCredentialNotConfigured", err)
	}
}

func TestPlatformConfig_DeleteRemovesUserCredentialsAndMarksPods(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPlatform(t, store, "xdr", "XDR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key",
	}); err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	before, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod before delete: %v", err)
	}
	podIDs, err := store.DeletePlatformConfigAndMarkPods("xdr")
	if err != nil || len(podIDs) != 1 || podIDs[0] != "pod-a" {
		t.Fatalf("DeletePlatformConfigAndMarkPods = %v, %v", podIDs, err)
	}
	summaries, err := store.ListUserPlatformCredentials(alice.HumanUserID)
	if err != nil || len(summaries) != 0 {
		t.Fatalf("credentials after platform delete = %+v, %v", summaries, err)
	}
	pod, err := store.GetPod("pod-a")
	if err != nil || pod.ConfigGeneration != before.ConfigGeneration+1 ||
		pod.LastApplyStatus != repo.ApplyStatusPending {
		t.Fatalf("pod after platform delete = %+v, %v", pod, err)
	}
}

func TestPlatformCredential_ConcurrentUpdatesDoNotLosePlatforms(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPlatform(t, store, "xdr", "XDR")
	createTestPlatform(t, store, "mssw", "MSSW")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for platform, key := range map[string]string{"xdr": "xdr-key", "mssw": "mssw-key"} {
		wg.Add(1)
		go func(platformName, apiKey string) {
			defer wg.Done()
			_, err := store.UpsertUserPlatformCredential(alice.HumanUserID, platformName, map[string]any{
				"apiKey": apiKey,
			})
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
	summaries, err := store.ListUserPlatformCredentials(alice.HumanUserID)
	if err != nil || len(summaries) != 2 || summaries[0].Platform != "mssw" || summaries[1].Platform != "xdr" {
		t.Fatalf("summaries = %+v, %v", summaries, err)
	}
}

func TestPlatformCredential_DisabledAndCorruptDataFailClosed(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPlatform(t, store, "xdr", "XDR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	if err := store.UpdatePlatformConfig("xdr", "XDR", false); err != nil {
		t.Fatalf("disable xdr: %v", err)
	}
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "key",
	}); !errors.Is(err, repo.ErrPlatformDisabled) {
		t.Fatalf("disabled platform upsert = %v, want ErrPlatformDisabled", err)
	}
}

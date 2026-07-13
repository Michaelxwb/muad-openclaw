package test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func newStore(t *testing.T) *repo.Store {
	t.Helper()
	s, err := repo.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestPod_CRUDAndUniqueness(t *testing.T) {
	s := newStore(t)
	pod := repo.Pod{
		PodID:                   "pod-a",
		DisplayName:             "Pod A",
		ImageTag:                "tag:1",
		ServiceTokenEnc:         "cipher-a",
		ServiceTokenFingerprint: "sha256:a",
	}
	if err := s.CreatePod(pod); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	if err := s.CreatePod(pod); err != repo.ErrPodExists {
		t.Fatalf("duplicate create = %v, want ErrPodExists", err)
	}

	got, err := s.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if got.State != repo.PodStateCreating || got.MaxUsers != 10 || got.ConfigGeneration != 1 {
		t.Errorf("unexpected Pod defaults: %+v", got)
	}

	if err := s.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("UpdatePodState: %v", err)
	}
	got, _ = s.GetPod("pod-a")
	if got.State != repo.PodStateRunning {
		t.Errorf("state = %q, want running", got.State)
	}
	if err := s.UpdatePod("pod-a", repo.PodUpdate{
		DisplayName: "Pod A Updated", ImageTag: "tag:2", MaxUsers: 12,
		Channels: `["wecom"]`, ChannelConfigsEnc: "channels-enc",
		MemLimit: "4g", CPULimit: "2",
		RestartPolicy: "unless-stopped", MaxSkillConcurrency: 2,
		MaxBrowserConcurrency: 3,
	}); err != nil {
		t.Fatalf("UpdatePod: %v", err)
	}
	got, _ = s.GetPod("pod-a")
	if got.DisplayName != "Pod A Updated" || got.ConfigGeneration != 2 || got.LastApplyStatus != repo.ApplyStatusPending {
		t.Errorf("unexpected updated Pod: %+v", got)
	}

	list, total, err := s.ListPods(repo.PodListFilter{})
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("ListPods len = %d, want 1", len(list))
	}
	if total != 1 || list[0].UserCount != 0 || list[0].AvailableSlots != 12 {
		t.Errorf("unexpected Pod summary: total=%d item=%+v", total, list[0])
	}

	if err := s.DeletePod("pod-a"); err != nil {
		t.Fatalf("DeletePod: %v", err)
	}
	if _, err := s.GetPod("pod-a"); err != repo.ErrNotFound {
		t.Errorf("after delete = %v, want ErrNotFound", err)
	}
}

func TestPod_ListFilterAndPagination(t *testing.T) {
	s := newStore(t)
	for _, pod := range []repo.Pod{
		{PodID: "pod-a", DisplayName: "Alpha", State: repo.PodStateRunning, ServiceTokenEnc: "a", ServiceTokenFingerprint: "sha256:a"},
		{PodID: "pod-b", DisplayName: "Beta", State: repo.PodStateStopped, ServiceTokenEnc: "b", ServiceTokenFingerprint: "sha256:b"},
		{PodID: "pod-c", DisplayName: "Alpha Two", State: repo.PodStateRunning, ServiceTokenEnc: "c", ServiceTokenFingerprint: "sha256:c"},
	} {
		if err := s.CreatePod(pod); err != nil {
			t.Fatalf("CreatePod %s: %v", pod.PodID, err)
		}
	}
	items, total, err := s.ListPods(repo.PodListFilter{Limit: 1, State: repo.PodStateRunning, Query: "Alpha"})
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if total != 2 || len(items) != 1 || items[0].PodID != "pod-a" {
		t.Fatalf("unexpected filtered page: total=%d items=%+v", total, items)
	}
}

func TestPod_TokenRotationAndLookup(t *testing.T) {
	s := newStore(t)
	cipher, err := crypto.New("test-master-key")
	if err != nil {
		t.Fatalf("New cipher: %v", err)
	}
	oldToken, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken: %v", err)
	}
	oldEncrypted, err := cipher.Encrypt(oldToken)
	if err != nil {
		t.Fatalf("Encrypt old token: %v", err)
	}
	pod := repo.Pod{
		PodID: "pod-a", DisplayName: "A", ServiceTokenEnc: oldEncrypted,
		ServiceTokenFingerprint: crypto.Fingerprint(oldToken),
	}
	if err := s.CreatePod(pod); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	newToken, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken new: %v", err)
	}
	newEncrypted, err := cipher.Encrypt(newToken)
	if err != nil {
		t.Fatalf("Encrypt new token: %v", err)
	}
	if err := s.RotatePodServiceToken("pod-a", newEncrypted, crypto.Fingerprint(newToken), time.Now().UTC()); err != nil {
		t.Fatalf("RotatePodServiceToken: %v", err)
	}
	got, err := s.FindPodByServiceTokenFingerprint(crypto.Fingerprint(newToken))
	if err != nil {
		t.Fatalf("FindPodByServiceTokenFingerprint: %v", err)
	}
	decrypted, err := cipher.Decrypt(got.ServiceTokenEnc)
	if err != nil || !crypto.ConstantTimeEqual(decrypted, newToken) {
		t.Fatalf("stored token does not match rotated token: %v", err)
	}
	if _, err := s.FindPodByServiceTokenFingerprint(crypto.Fingerprint(oldToken)); err != repo.ErrNotFound {
		t.Fatalf("old token lookup = %v, want ErrNotFound", err)
	}
}

func TestPod_ConfigGenerationRejectsStaleResults(t *testing.T) {
	s := newStore(t)
	pod := repo.Pod{PodID: "pod-a", DisplayName: "A", ServiceTokenEnc: "enc", ServiceTokenFingerprint: "sha256:a"}
	if err := s.CreatePod(pod); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	if err := s.StartPodConfigApply("pod-a", 1); err != nil {
		t.Fatalf("StartPodConfigApply: %v", err)
	}
	generation, err := s.MarkPodConfigPending("pod-a")
	if err != nil || generation != 2 {
		t.Fatalf("MarkPodConfigPending = %d, %v; want 2", generation, err)
	}
	if err := s.CompletePodConfigApply("pod-a", 1, "old-hash", time.Now().UTC()); err != repo.ErrGenerationConflict {
		t.Fatalf("stale completion = %v, want ErrGenerationConflict", err)
	}
	if err := s.StartPodConfigApply("pod-a", 2); err != nil {
		t.Fatalf("start generation 2: %v", err)
	}
	if err := s.FailPodConfigApply("pod-a", 2, "health failed"); err != nil {
		t.Fatalf("fail generation 2: %v", err)
	}
	pending, err := s.ListPodsNeedingApply()
	if err != nil || len(pending) != 1 || pending[0].LastApplyError != "health failed" {
		t.Fatalf("ListPodsNeedingApply = %+v, %v", pending, err)
	}
	if err := s.StartPodConfigApply("pod-a", 2); err != nil {
		t.Fatalf("restart generation 2: %v", err)
	}
	if err := s.CompletePodConfigApply("pod-a", 2, "new-hash", time.Now().UTC()); err != nil {
		t.Fatalf("complete generation 2: %v", err)
	}
	got, _ := s.GetPod("pod-a")
	if got.AppliedGeneration != 2 || got.LastConfigHash != "new-hash" || got.LastApplyStatus != repo.ApplyStatusApplied {
		t.Fatalf("unexpected applied state: %+v", got)
	}
}

func TestLLMModelConfig_CreateListAndUniqueBinding(t *testing.T) {
	s := newStore(t)
	createTestPod(t, s, "pod-a", 10)
	models, err := s.CreateLLMModelConfigs([]repo.LLMModelConfigCreate{{
		DisplayName: "Alice Model", Provider: "deepseek", BaseURL: "https://api.deepseek.com",
		APIKeyEnc: "encrypted-key", APIKeyFingerprint: "fingerprint", Model: "deepseek-chat",
	}})
	if err != nil {
		t.Fatalf("CreateLLMModelConfigs: %v", err)
	}
	if len(models) != 1 || models[0].ModelConfigID == "" {
		t.Fatalf("created models = %+v", models)
	}
	alice := repo.HumanUser{
		PodID: "pod-a", ModelConfigID: models[0].ModelConfigID, DisplayName: "Alice",
		AgentID: "alice", BrowserProfile: "alice", Status: repo.HumanUserStatusActive,
	}
	if _, err := s.CreateHumanUser(alice, 18802, 18810); err != nil {
		t.Fatalf("CreateHumanUser alice: %v", err)
	}
	available, err := s.ListLLMModelConfigs(repo.LLMModelConfigListFilter{AvailableOnly: true})
	if err != nil || len(available) != 0 {
		t.Fatalf("available models = %+v, %v", available, err)
	}
	bob := repo.HumanUser{
		PodID: "pod-a", ModelConfigID: models[0].ModelConfigID, DisplayName: "Bob",
		AgentID: "bob", BrowserProfile: "bob", Status: repo.HumanUserStatusActive,
	}
	if _, err := s.CreateHumanUser(bob, 18802, 18810); err != repo.ErrLLMModelAlreadyBound {
		t.Fatalf("duplicate model binding = %v, want ErrLLMModelAlreadyBound", err)
	}
}

func TestAudit_AppendAndQuery(t *testing.T) {
	s := newStore(t)
	base := time.Now().UTC()
	_ = s.AddAudit(repo.AuditEntry{Actor: "admin", Action: "create", Target: "alice", TS: base})
	_ = s.AddAudit(repo.AuditEntry{Actor: "admin", Action: "delete", Target: "bob", TS: base.Add(time.Second)})
	_ = s.AddAudit(repo.AuditEntry{Actor: "ops", Action: "restart", Target: "carol", TS: base.Add(2 * time.Second)})

	all, _, _ := s.QueryAudit("", time.Time{}, time.Time{}, 0, 0)
	if len(all) != 3 {
		t.Fatalf("QueryAudit all = %d, want 3", len(all))
	}
	if all[0].Action != "restart" {
		t.Errorf("newest first expected, got %q", all[0].Action)
	}

	byActor, _, _ := s.QueryAudit("admin", time.Time{}, time.Time{}, 0, 0)
	if len(byActor) != 2 {
		t.Errorf("by actor = %d, want 2", len(byActor))
	}
}

func TestAdmin_BootstrapIdempotent(t *testing.T) {
	s := newStore(t)
	if err := s.CreateAdminIfAbsent(repo.Admin{Username: "root", PasswordHash: "h1"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateAdminIfAbsent(repo.Admin{Username: "root", PasswordHash: "h2"}); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	a, err := s.GetAdmin("root")
	if err != nil {
		t.Fatalf("GetAdmin: %v", err)
	}
	if a.PasswordHash != "h1" {
		t.Errorf("hash = %q, want original h1 (ON CONFLICT DO NOTHING)", a.PasswordHash)
	}
}

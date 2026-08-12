package test

import (
	"errors"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSkillAsset_CRUDListAndConstraints(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	createTestPlatform(t, store, "xdr", "XDR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)

	public := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`, ProgressSupported: true,
	})
	if public.DisplayName != "xdr-query" || public.Status != repo.SkillStatusActive {
		t.Fatalf("unexpected public Skill defaults: %+v", public)
	}
	if _, err := store.CreateSkillAsset(repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/xdr-query", ManifestHash: "sha256:system",
	}); !errors.Is(err, repo.ErrSkillExists) {
		t.Fatalf("system/public duplicate = %v, want ErrSkillExists", err)
	}

	private := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate,
		HumanUserID:   alice.HumanUserID,
		SourcePath:    "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash:  "sha256:private",
		PlatformsJSON: `["xdr"]`,
	})
	if !private.CreatedAt.Before(private.UpdatedAt) && !private.CreatedAt.Equal(private.UpdatedAt) {
		t.Fatalf("invalid timestamps: %+v", private)
	}
	if _, err := store.CreateSkillAsset(repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID,
		SourcePath:  "/duplicate", ManifestHash: "sha256:duplicate",
		PlatformsJSON: `["xdr"]`,
	}); !errors.Is(err, repo.ErrSkillExists) {
		t.Fatalf("private duplicate = %v, want ErrSkillExists", err)
	}

	items, total, err := store.ListSkillAssets(repo.SkillAssetListFilter{
		Query: "xdr", Limit: 1,
	})
	if err != nil || total != 2 || len(items) != 1 {
		t.Fatalf("ListSkillAssets page = %d/%d, %v", len(items), total, err)
	}
	privateItems, total, err := store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
	})
	if err != nil || total != 1 || privateItems[0].SkillID != private.SkillID {
		t.Fatalf("private filtered page = %+v/%d, %v", privateItems, total, err)
	}
	if err := store.UpdateSkillAssetStatus(private.SkillID, repo.SkillStatusDisabled); err != nil {
		t.Fatalf("UpdateSkillAssetStatus: %v", err)
	}
	updated, err := store.GetSkillAsset(private.SkillID)
	if err != nil || updated.Status != repo.SkillStatusDisabled {
		t.Fatalf("updated Skill = %+v, %v", updated, err)
	}
	if err := store.DeleteSkillAsset(private.SkillID); err != nil {
		t.Fatalf("DeleteSkillAsset: %v", err)
	}
	deleted, err := store.GetSkillAsset(private.SkillID)
	if err != nil || deleted.Status != repo.SkillStatusDeleted {
		t.Fatalf("deleted Skill = %+v, %v", deleted, err)
	}
}

func TestSkillAsset_RejectsLegacyEntryType(t *testing.T) {
	store := newStore(t)
	_, err := store.CreateSkillAsset(repo.SkillAsset{
		Name: "legacy-skill", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/legacy-skill", ManifestHash: "sha256:legacy",
		EntryType: "prompt-only",
	})
	if !errors.Is(err, repo.ErrInvalidSkill) {
		t.Fatalf("legacy entry type = %v, want ErrInvalidSkill", err)
	}
}

func TestSkillPolicy_CRUD(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	policy, err := store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-query",
		Action: repo.SkillPolicyAllowOverride, Reason: "approved", CreatedBy: "admin",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("CreateSkillPolicy: %v", err)
	}
	policies, err := store.ListSkillPoliciesByHumanUser(alice.HumanUserID)
	if err != nil || len(policies) != 1 || policies[0].PolicyID != policy.PolicyID {
		t.Fatalf("ListSkillPoliciesByHumanUser = %+v, %v", policies, err)
	}
	if _, err := store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "Bad.Name",
		Action: repo.SkillPolicyDisable, CreatedBy: "admin",
	}); !errors.Is(err, repo.ErrInvalidSkill) {
		t.Fatalf("invalid policy = %v, want ErrInvalidSkill", err)
	}
	if err := store.DeleteSkillPolicy(policy.PolicyID); err != nil {
		t.Fatalf("DeleteSkillPolicy: %v", err)
	}
	policies, err = store.ListSkillPoliciesByHumanUser(alice.HumanUserID)
	if err != nil || len(policies) != 0 {
		t.Fatalf("policies after delete = %+v, %v", policies, err)
	}
}

func TestSkillExecutionRecord_UpsertListAndFilters(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute)
	record, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-1", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		StartedAt: started,
	})
	if err != nil {
		t.Fatalf("UpsertSkillExecutionRecord: %v", err)
	}
	if record.ExecutionID != "exec-1" || record.CreatedAt.IsZero() {
		t.Fatalf("unexpected execution defaults: %+v", record)
	}
	duplicate, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-1", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "other-skill", SkillScope: repo.SkillScopePrivate,
		StartedAt: started.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("UpsertSkillExecutionRecord duplicate: %v", err)
	}
	if duplicate.SkillName != "xdr-query" || !duplicate.StartedAt.Equal(record.StartedAt) {
		t.Fatalf("duplicate execution_id changed record: %+v", duplicate)
	}
	items, total, err := store.ListSkillExecutionRecords(repo.SkillExecutionListFilter{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		From: started.Add(-time.Second), To: started.Add(time.Second),
	})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("ListSkillExecutionRecords = %+v/%d, %v", items, total, err)
	}
	if items[0].ExecutionID != "exec-1" || items[0].SkillScope != repo.SkillScopePublic {
		t.Fatalf("unexpected execution row: %+v", items[0])
	}
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		PodID: "pod-a", HumanUserID: alice.HumanUserID, AgentID: alice.AgentID,
		SkillName: "bad/name", SkillScope: repo.SkillScopePublic,
	}); !errors.Is(err, repo.ErrInvalidSkill) {
		t.Fatalf("invalid execution = %v, want ErrInvalidSkill", err)
	}
}

func TestSkillExecutionRecord_IgnoresDuplicateFromOtherPod(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	createTestPod(t, store, "pod-b", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute)
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-cross-pod", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		StartedAt: started,
	}); err != nil {
		t.Fatalf("insert execution: %v", err)
	}

	stored, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-cross-pod", PodID: "pod-b", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "forged-skill", SkillScope: repo.SkillScopePrivate,
		StartedAt: started.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("cross-pod duplicate: %v", err)
	}
	if stored.PodID != "pod-a" || stored.SkillName != "xdr-query" {
		t.Fatalf("cross-pod update leaked: %+v", stored)
	}
}

func TestEffectiveSkillResolver_MergesSourcesPoliciesCredentialsAndExecutions(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	createTestPlatform(t, store, "xdr", "XDR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/session-manager", ManifestHash: "sha256:system",
	})
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopePrivate,
		HumanUserID:   alice.HumanUserID,
		SourcePath:    "/home/node/.openclaw/workspace-alice/skills/session-manager",
		ManifestHash:  "sha256:private-system",
		PlatformsJSON: `["xdr"]`,
	})
	publicXDR := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`, Version: "1.0.0", ManifestJSON: `{"longTask":true}`,
	})
	privateXDR := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate,
		HumanUserID:  alice.HumanUserID,
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash: "sha256:private", Version: "2.0.0", PlatformsJSON: `["xdr"]`,
	})
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-xdr", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionRecord: %v", err)
	}

	skills, total, err := store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills: %v", err)
	}
	if total != 2 {
		t.Fatalf("effective skills total = %d, want 2: %+v", total, skills)
	}
	byName := indexEffectiveSkills(skills)
	if got := byName["session-manager"]; got.EffectiveSource != repo.SkillScopeSystem ||
		got.Status != repo.EffectiveSkillStatusEffective || got.PrivateSkillID != "" {
		t.Fatalf("system protected effective Skill = %+v", got)
	}
	if got := byName["xdr-query"]; got.Status != repo.EffectiveSkillStatusConflict ||
		!got.Conflict || got.EffectiveSource != repo.SkillScopePublic ||
		got.PublicSkillID != publicXDR.SkillID || got.PrivateSkillID != privateXDR.SkillID ||
		got.LastExecution == nil || !got.LongTask {
		t.Fatalf("public/private conflict effective Skill = %+v", got)
	}

	if _, err := store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-query",
		Action: repo.SkillPolicyAllowOverride, CreatedBy: "admin",
	}); err != nil {
		t.Fatalf("CreateSkillPolicy allow override: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills after override: %v", err)
	}
	xdr := indexEffectiveSkills(skills)["xdr-query"]
	if xdr.Status != repo.EffectiveSkillStatusMissingCredential || xdr.Effective ||
		xdr.EffectiveSource != repo.SkillScopePrivate ||
		xdr.Platforms[0].CredentialStatus != repo.SkillCredentialMissing {
		t.Fatalf("override without credential = %+v", xdr)
	}
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key",
	}); err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{
		Status: repo.EffectiveSkillStatusEffective,
	})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills with credential: %v", err)
	}
	xdr = indexEffectiveSkills(skills)["xdr-query"]
	if !xdr.Effective || xdr.Status != repo.EffectiveSkillStatusEffective ||
		xdr.Platforms[0].CredentialStatus != repo.SkillCredentialConfigured {
		t.Fatalf("override with credential = %+v", xdr)
	}
}

func TestEffectiveSkillResolver_PlatformlessAndMultiPlatformSkills(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	createTestPlatform(t, store, "xdr", "XDR")
	createTestPlatform(t, store, "mssw", "MSSW")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "web-tools-guide", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/web-tools-guide", ManifestHash: "sha256:web",
		PlatformsJSON: `[]`,
	})
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "multi-report", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/multi-report", ManifestHash: "sha256:multi",
		PlatformsJSON: `["mssw","xdr"]`,
	})
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key",
	}); err != nil {
		t.Fatalf("UpsertUserPlatformCredential xdr: %v", err)
	}

	skills, _, err := store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills: %v", err)
	}
	byName := indexEffectiveSkills(skills)
	if web := byName["web-tools-guide"]; !web.Effective ||
		web.Status != repo.EffectiveSkillStatusEffective || len(web.Platforms) != 0 {
		t.Fatalf("platformless Skill = %+v", web)
	}
	multi := byName["multi-report"]
	if multi.Effective || multi.Status != repo.EffectiveSkillStatusMissingCredential ||
		len(multi.Platforms) != 2 || multi.Platforms[0].CredentialStatus != repo.SkillCredentialMissing ||
		multi.Platforms[1].CredentialStatus != repo.SkillCredentialConfigured {
		t.Fatalf("multi-platform missing credential = %+v", multi)
	}

	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "mssw", map[string]any{
		"apiKey": "mssw-key",
	}); err != nil {
		t.Fatalf("UpsertUserPlatformCredential mssw: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{
		Status: repo.EffectiveSkillStatusEffective,
	})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills with credentials: %v", err)
	}
	multi = indexEffectiveSkills(skills)["multi-report"]
	if !multi.Effective || multi.Status != repo.EffectiveSkillStatusEffective ||
		len(multi.Platforms) != 2 {
		t.Fatalf("multi-platform configured = %+v", multi)
	}
}

func TestEffectiveSkillResolver_DisablePolicyAndPlatformDisabled(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	createTestPlatform(t, store, "soar", "SOAR")
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "soar-sync", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/soar-sync", ManifestHash: "sha256:soar",
		PlatformsJSON: `["soar"]`,
	})
	if _, err := store.UpsertUserPlatformCredential(alice.HumanUserID, "soar", map[string]any{
		"apiKey": "soar-key",
	}); err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	if err := store.UpdatePlatformConfig("soar", "SOAR", false); err != nil {
		t.Fatalf("UpdatePlatformConfig: %v", err)
	}
	skills, _, err := store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills platform disabled: %v", err)
	}
	soar := indexEffectiveSkills(skills)["soar-sync"]
	if soar.Status != repo.EffectiveSkillStatusMissingCredential ||
		soar.Platforms[0].CredentialStatus != repo.SkillCredentialPlatformDisabled {
		t.Fatalf("platform disabled effective Skill = %+v", soar)
	}
	if _, err := store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "soar-sync",
		Action: repo.SkillPolicyDisable, CreatedBy: "admin",
	}); err != nil {
		t.Fatalf("CreateSkillPolicy disable: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(alice.HumanUserID, repo.EffectiveSkillFilter{
		Status: repo.EffectiveSkillStatusDisabled,
	})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills disabled: %v", err)
	}
	soar = indexEffectiveSkills(skills)["soar-sync"]
	if soar.Status != repo.EffectiveSkillStatusDisabled || soar.Effective {
		t.Fatalf("disabled effective Skill = %+v", soar)
	}
}

func createSkillAsset(t *testing.T, store *repo.Store, asset repo.SkillAsset) repo.SkillAsset {
	t.Helper()
	created, err := store.CreateSkillAsset(asset)
	if err != nil {
		t.Fatalf("CreateSkillAsset %s/%s: %v", asset.Scope, asset.Name, err)
	}
	return created
}

func indexEffectiveSkills(skills []repo.EffectiveSkill) map[string]repo.EffectiveSkill {
	out := make(map[string]repo.EffectiveSkill, len(skills))
	for _, skill := range skills {
		out[skill.Name] = skill
	}
	return out
}

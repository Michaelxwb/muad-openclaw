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
		HumanUserID: alice.HumanUserID, PodID: "pod-a",
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash: "sha256:private",
	})
	if !private.CreatedAt.Before(private.UpdatedAt) && !private.CreatedAt.Equal(private.UpdatedAt) {
		t.Fatalf("invalid timestamps: %+v", private)
	}
	if _, err := store.CreateSkillAsset(repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID, PodID: "pod-a",
		SourcePath: "/duplicate", ManifestHash: "sha256:duplicate",
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
		Status: repo.SkillExecutionRunning, EventSeq: 1,
		StartedAt: started, ProgressJSON: `[{"stage":"start"}]`,
	})
	if err != nil {
		t.Fatalf("UpsertSkillExecutionRecord running: %v", err)
	}
	if record.ExecutionID != "exec-1" || record.CreatedAt.IsZero() {
		t.Fatalf("unexpected execution defaults: %+v", record)
	}
	ended := time.Now().UTC()
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-1", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		Status: repo.SkillExecutionSucceeded, EventSeq: 2,
		StartedAt: started, EndedAt: ended,
		DurationMS: 1500, ProgressJSON: `[{"stage":"done"}]`, OutputSummary: "ok",
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionRecord done: %v", err)
	}
	items, total, err := store.ListSkillExecutionRecords(repo.SkillExecutionListFilter{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-query", Status: repo.SkillExecutionSucceeded,
		From: started.Add(-time.Second), To: ended.Add(time.Second),
	})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("ListSkillExecutionRecords = %+v/%d, %v", items, total, err)
	}
	if items[0].Status != repo.SkillExecutionSucceeded || items[0].DurationMS != 1500 {
		t.Fatalf("unexpected execution row: %+v", items[0])
	}
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		PodID: "pod-a", HumanUserID: alice.HumanUserID, AgentID: alice.AgentID,
		SkillName: "bad/name", SkillScope: repo.SkillScopePublic,
	}); !errors.Is(err, repo.ErrInvalidSkill) {
		t.Fatalf("invalid execution = %v, want ErrInvalidSkill", err)
	}
}

func TestSkillExecutionRepositoryRejectsLateEventAfterTerminal(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute)
	base := repo.SkillExecutionRecord{
		ExecutionID: "exec-terminal", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		SkillVersion: "1.0.0", EntryType: repo.SkillEntryTraditionalPrompt,
		ActivationMode: repo.SkillActivationTool, StartedAt: started, ProgressJSON: `[]`,
	}
	running := base
	running.Status = repo.SkillExecutionRunning
	running.EventSeq = 1
	if _, err := store.UpsertSkillExecutionRecord(running); err != nil {
		t.Fatalf("insert running execution: %v", err)
	}
	terminal := base
	terminal.Status = repo.SkillExecutionSucceeded
	terminal.EventSeq = 2
	terminal.EndedAt = started.Add(time.Second)
	terminal.TerminalReason = "agent_end"
	terminal.OutputSummary = "completed"
	stored, err := store.UpsertSkillExecutionRecord(terminal)
	if err != nil {
		t.Fatalf("finish execution: %v", err)
	}
	if stored.Status != repo.SkillExecutionSucceeded || stored.EventSeq != 2 {
		t.Fatalf("terminal execution = %+v", stored)
	}

	late := base
	late.Status = repo.SkillExecutionRunning
	late.EventSeq = 1
	late.ProgressJSON = `[{"stage":"late"}]`
	stored, err = store.UpsertSkillExecutionRecord(late)
	if err != nil {
		t.Fatalf("upsert late event: %v", err)
	}
	if stored.Status != repo.SkillExecutionSucceeded || stored.EventSeq != 2 ||
		stored.TerminalReason != "agent_end" || stored.OutputSummary != "completed" {
		t.Fatalf("late event changed terminal execution: %+v", stored)
	}

	conflictingTerminal := base
	conflictingTerminal.Status = repo.SkillExecutionFailed
	conflictingTerminal.EventSeq = 3
	conflictingTerminal.TerminalReason = "tool_error"
	stored, err = store.UpsertSkillExecutionRecord(conflictingTerminal)
	if err != nil {
		t.Fatalf("upsert conflicting terminal event: %v", err)
	}
	if stored.Status != repo.SkillExecutionSucceeded || stored.EventSeq != 2 ||
		stored.TerminalReason != "agent_end" {
		t.Fatalf("terminal state was overwritten: %+v", stored)
	}
}

func TestEffectiveSkillResolver_MergesSourcesPoliciesCredentialsAndExecutions(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	cipher := testCipher(t)
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/session-manager", ManifestHash: "sha256:system",
	})
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID, PodID: "pod-a",
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/session-manager",
		ManifestHash: "sha256:private-system",
	})
	publicXDR := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`, Version: "1.0.0",
	})
	privateXDR := createSkillAsset(t, store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID, PodID: "pod-a",
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash: "sha256:private", Version: "2.0.0", PlatformsJSON: `["xdr"]`,
	})
	if _, err := store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-xdr", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		AgentID: alice.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
		Status: repo.SkillExecutionSucceeded, ProgressJSON: `[]`,
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionRecord: %v", err)
	}

	skills, total, err := store.ResolveEffectiveSkills(cipher, alice.HumanUserID, repo.EffectiveSkillFilter{})
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
		got.LastExecution == nil {
		t.Fatalf("public/private conflict effective Skill = %+v", got)
	}

	if _, err := store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-query",
		Action: repo.SkillPolicyAllowOverride, CreatedBy: "admin",
	}); err != nil {
		t.Fatalf("CreateSkillPolicy allow override: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(cipher, alice.HumanUserID, repo.EffectiveSkillFilter{})
	if err != nil {
		t.Fatalf("ResolveEffectiveSkills after override: %v", err)
	}
	xdr := indexEffectiveSkills(skills)["xdr-query"]
	if xdr.Status != repo.EffectiveSkillStatusMissingCredential || xdr.Effective ||
		xdr.EffectiveSource != repo.SkillScopePrivate ||
		xdr.Platforms[0].CredentialStatus != repo.SkillCredentialMissing {
		t.Fatalf("override without credential = %+v", xdr)
	}
	if _, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, "xdr", "xdr-key"); err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	skills, _, err = store.ResolveEffectiveSkills(cipher, alice.HumanUserID, repo.EffectiveSkillFilter{
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

func TestEffectiveSkillResolver_DisablePolicyAndPlatformDisabled(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 3)
	alice := createTestHumanUser(t, store, "pod-a", "alice", repo.HumanUserStatusActive)
	cipher := testCipher(t)
	createSkillAsset(t, store, repo.SkillAsset{
		Name: "soar-sync", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/soar-sync", ManifestHash: "sha256:soar",
		PlatformsJSON: `["soar"]`,
	})
	if _, err := store.UpsertUserPlatformCredential(cipher, alice.HumanUserID, "soar", "soar-key"); err != nil {
		t.Fatalf("UpsertUserPlatformCredential: %v", err)
	}
	if err := store.UpdatePlatformConfig("soar", "SOAR", "", false); err != nil {
		t.Fatalf("UpdatePlatformConfig: %v", err)
	}
	skills, _, err := store.ResolveEffectiveSkills(cipher, alice.HumanUserID, repo.EffectiveSkillFilter{})
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
	skills, _, err = store.ResolveEffectiveSkills(cipher, alice.HumanUserID, repo.EffectiveSkillFilter{
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

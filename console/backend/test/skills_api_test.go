package test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSkillAPI_ListDetailEffectiveAndPolicies(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	publicSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`,
	})
	privateSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
		SourcePath: "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash: "sha256:private", PlatformsJSON: `["xdr"]`,
	})

	rr := e.do(http.MethodGet, "/api/v1/skills?q=xdr&pageSize=10", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []struct {
			SkillID string `json:"skillId"`
			Name    string `json:"name"`
			Scope   string `json:"scope"`
		} `json:"items"`
		Total int `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 2 || len(list.Items) != 2 {
		t.Fatalf("Skill list = %+v", list)
	}

	rr = e.do(http.MethodGet, "/api/v1/skills/"+publicSkill.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"name":"xdr-query"`) {
		t.Fatalf("Skill detail response = %s", rr.Body.String())
	}

	rr = e.do(http.MethodGet, "/api/v1/human-users/"+alice.HumanUserID+"/skills", "")
	assertStatus(t, rr, http.StatusOK)
	effective := decodeAPIData[struct {
		Items []struct {
			Name            string `json:"name"`
			Status          string `json:"status"`
			EffectiveSource string `json:"effectiveSource"`
			PublicSkillID   string `json:"publicSkillId"`
			PrivateSkillID  string `json:"privateSkillId"`
			Conflict        bool   `json:"conflict"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	if len(effective.Items) != 1 || !effective.Items[0].Conflict ||
		effective.Items[0].PublicSkillID != publicSkill.SkillID ||
		effective.Items[0].PrivateSkillID != privateSkill.SkillID {
		t.Fatalf("effective Skill conflict = %+v", effective)
	}

	e.reconcile.podIDs = nil // ignore pod-creation enqueues from setup
	rr = e.do(http.MethodPost, "/api/v1/human-users/"+alice.HumanUserID+"/skill-policies",
		`{"skillName":"xdr-query","action":"allow_override","reason":"approved"}`)
	assertStatus(t, rr, http.StatusCreated)
	policy := decodeAPIData[struct {
		PolicyID string `json:"policyId"`
		Action   string `json:"action"`
	}](t, rr.Body.Bytes())
	if policy.PolicyID == "" || policy.Action != repo.SkillPolicyAllowOverride {
		t.Fatalf("policy response = %+v", policy)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("skill policy change should auto-enqueue reconcile: %v", e.reconcile.podIDs)
	}

	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skill-policies/"+policy.PolicyID, "")
	assertStatus(t, rr, http.StatusOK)
}

func TestSkillAPI_StatusUpdateAndProtectedSystemSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "soar", "SOAR")
	if err := os.MkdirAll(filepath.Join(e.skillsDir, "soar-sync"), 0o700); err != nil {
		t.Fatalf("create public Skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(e.skillsDir, "soar-sync", "SKILL.md"), []byte("skill"), 0o600); err != nil {
		t.Fatalf("write public Skill file: %v", err)
	}
	publicSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "soar-sync", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/soar-sync", ManifestHash: "sha256:soar",
		PlatformsJSON: `["soar"]`,
	})
	systemSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/session-manager", ManifestHash: "sha256:system",
	})

	e.reconcile.podIDs = nil // ignore pod-creation enqueues from setup
	rr := e.do(http.MethodPatch, "/api/v1/skills/"+publicSkill.SkillID, `{"status":"disabled"}`)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"affectedPodIds":["pod-a"]`) {
		t.Fatalf("patch Skill response = %s", rr.Body.String())
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("public Skill status change should auto-enqueue reconcile: %v", e.reconcile.podIDs)
	}
	got, err := e.store.GetSkillAsset(publicSkill.SkillID)
	if err != nil || got.Status != repo.SkillStatusDisabled {
		t.Fatalf("updated Skill = %+v, %v", got, err)
	}

	rr = e.do(http.MethodPatch, "/api/v1/skills/"+publicSkill.SkillID, `{"status":"active"}`)
	assertStatus(t, rr, http.StatusOK)
	got, err = e.store.GetSkillAsset(publicSkill.SkillID)
	if err != nil || got.Status != repo.SkillStatusActive {
		t.Fatalf("enabled Skill = %+v, %v", got, err)
	}

	rr = e.do(http.MethodPatch, "/api/v1/skills/"+publicSkill.SkillID, `{"status":"deleted"}`)
	assertStatus(t, rr, http.StatusOK)
	if _, err := os.Stat(filepath.Join(e.skillsDir, "soar-sync")); !os.IsNotExist(err) {
		t.Fatalf("public Skill directory should be removed, err=%v", err)
	}
	got, err = e.store.GetSkillAsset(publicSkill.SkillID)
	if err != nil || got.Status != repo.SkillStatusDeleted {
		t.Fatalf("deleted public Skill = %+v, %v", got, err)
	}

	rr = e.do(http.MethodPatch, "/api/v1/skills/"+publicSkill.SkillID, `{"status":"active"}`)
	assertStatus(t, rr, http.StatusBadRequest)

	rr = e.do(http.MethodPatch, "/api/v1/skills/"+systemSkill.SkillID, `{"status":"disabled"}`)
	assertStatus(t, rr, http.StatusBadRequest)
	got, err = e.store.GetSkillAsset(systemSkill.SkillID)
	if err != nil || got.Status != repo.SkillStatusActive {
		t.Fatalf("system Skill should remain active: %+v, %v", got, err)
	}
}

func TestSkillAPI_ScanWritesSemanticAudit(t *testing.T) {
	e := newTestEnv(t)
	rr := e.do(http.MethodPost, "/api/v1/skills/scan", "")
	assertStatus(t, rr, http.StatusOK)
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{Action: "skill.asset.scan"})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("scan audit = %+v/%d, %v", entries, total, err)
	}
}

func TestSkillAPI_PrivateUploadAndDelete(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	e.reconcile.podIDs = nil // ignore pod-creation enqueues from setup

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script", "platform": "xdr"},
	))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			SkillID     string `json:"skillId"`
			Name        string `json:"name"`
			Scope       string `json:"scope"`
			HumanUserID string `json:"humanUserId"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "xdr-private" || created.Skill.Scope != repo.SkillScopePrivate ||
		created.Skill.HumanUserID != alice.HumanUserID {
		t.Fatalf("private Skill response = %+v", created)
	}
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("private upload should not exec installer before apply: %+v", e.drv.execStdinCalls)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("private upload should auto-enqueue reconcile for the user Pod: %v", e.reconcile.podIDs)
	}
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "_private", alice.HumanUserID, "xdr-private", "SKILL.md")); err != nil {
		t.Fatalf("private Skill was not saved locally: %v", err)
	}

	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+created.Skill.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	got, err := e.store.GetSkillAsset(created.Skill.SkillID)
	if err != nil || got.Status != repo.SkillStatusDeleted {
		t.Fatalf("deleted private Skill = %+v, %v", got, err)
	}
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("private delete should not exec installer before apply: %+v", e.drv.execStdinCalls)
	}
	if len(e.reconcile.podIDs) != 2 || e.reconcile.podIDs[1] != "pod-a" {
		t.Fatalf("private delete should auto-enqueue reconcile for the user Pod: %v", e.reconcile.podIDs)
	}
}

func TestSkillAPI_PrivateIngestCreatesAssetAndDirectSyncs(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	bundle := makeSkillBundle(t, "ingest-skill", map[string]any{"name": "ingest-skill"})
	body := fmt.Sprintf(`{"agentId":%q,"bundleFormat":"tar.gz","bundle":%q}`,
		alice.AgentID, base64.StdEncoding.EncodeToString(bundle))
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skills/private/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created["pod-a"].ServiceToken.Value)
	e.reconcile.podIDs = nil // ignore pod-creation enqueues from setup
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusOK)

	assets, _, err := e.store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
	})
	if err != nil || len(assets) != 1 || assets[0].Name != "ingest-skill" {
		t.Fatalf("ingest assets = %+v, %v", assets, err)
	}
	// Direct sync: the installer should have been invoked without a reconcile
	// enqueue (no config_generation bump / no gateway restart path).
	if len(e.drv.execStdinCalls) == 0 {
		t.Fatalf("ingest should trigger direct installer sync")
	}
	if len(e.reconcile.podIDs) != 0 {
		t.Fatalf("ingest should not enqueue reconcile: %v", e.reconcile.podIDs)
	}
}

func TestSkillAPI_PrivateIngestDoesNotBumpConfigGeneration(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	podBefore, err := e.store.GetPod(alice.PodID)
	if err != nil {
		t.Fatalf("get pod before: %v", err)
	}
	bundle := makeSkillBundle(t, "decouple-skill", map[string]any{"name": "decouple-skill"})
	body := fmt.Sprintf(`{"agentId":%q,"bundleFormat":"tar.gz","bundle":%q}`,
		alice.AgentID, base64.StdEncoding.EncodeToString(bundle))
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skills/private/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created["pod-a"].ServiceToken.Value)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusOK)

	// Decoupling: skill ingest syncs files directly and must NOT bump
	// config_generation (no config apply / no gateway restart).
	podAfter, err := e.store.GetPod(alice.PodID)
	if err != nil {
		t.Fatalf("get pod after: %v", err)
	}
	if podAfter.ConfigGeneration != podBefore.ConfigGeneration {
		t.Fatalf("ingest must not bump config_generation: %d -> %d",
			podBefore.ConfigGeneration, podAfter.ConfigGeneration)
	}
	// skills_pending is a pod-creation artifact (new pod syncs skills); the
	// ingest must not change it (no new config apply is queued).
	if podAfter.SkillsPending != podBefore.SkillsPending {
		t.Fatalf("ingest must not alter skills_pending: %v -> %v",
			podBefore.SkillsPending, podAfter.SkillsPending)
	}
}

func TestSkillAPI_PrivateIngestRejectsInvalidBundle(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	body := fmt.Sprintf(`{"agentId":%q,"bundleFormat":"tar.gz","bundle":%q}`,
		alice.AgentID, base64.StdEncoding.EncodeToString([]byte("not-a-bundle")))
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skills/private/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created["pod-a"].ServiceToken.Value)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusBadRequest)

	assets, _, err := e.store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
	})
	if err != nil || len(assets) != 0 {
		t.Fatalf("invalid ingest should not create an asset: %+v, %v", assets, err)
	}
}

func TestSkillAPI_PrivateIngestRespectsConfiguredMaxSize(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	// 把 bundle 上限压到 1 字节，重建 handler 使配置生效。
	// ingest 走 skill-upload 的咽喉路径，必须与 multipart 上传一致 respect
	// maxSkillUploadBundleSize，超限返回 40504 而非创建资产。
	e.cfg.SkillMaxUploadBundleBytes = 1
	e.h = api.NewServer(e.cfg, e.store, e.cipher, e.drv, e.cache, e.syncer, e.reconcile).Handler()

	bundle := makeSkillBundle(t, "oversize-skill", map[string]any{"name": "oversize-skill"})
	body := fmt.Sprintf(`{"agentId":%q,"bundleFormat":"tar.gz","bundle":%q}`,
		alice.AgentID, base64.StdEncoding.EncodeToString(bundle))
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skills/private/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created["pod-a"].ServiceToken.Value)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), `"code":40504`) {
		t.Fatalf("oversize ingest body = %s, want code 40504", rr.Body.String())
	}
	assets, _, err := e.store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
	})
	if err != nil || len(assets) != 0 {
		t.Fatalf("oversize ingest should not create an asset: %+v, %v", assets, err)
	}
}

func TestSkillAPI_PrivateUploadAcceptsZipBundle(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	createTestPlatform(t, e.store, "sdsp", "SDSP")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUploadFile(
		alice.HumanUserID, "sdsp-private", "sdsp-private.zip",
		makeZipSkillBundle(t, "sdsp-private", map[string]any{
			"name": "sdsp-private", "runtime": "script", "platform": "sdsp",
		}),
	)
	assertStatus(t, rr, http.StatusCreated)
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("zip private upload should not exec installer before apply: %+v", e.drv.execStdinCalls)
	}
}

func TestSkillAPI_PrivateUploadPlatformOverrideSupportsMultiplePlatforms(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "mssw", "MSSW")
	createTestPlatform(t, e.store, "sdsp", "SDSP")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUploadFileWithPlatforms(
		alice.HumanUserID, "xdr-private", "xdr-private.tar.gz",
		makeSkillBundle(t, "xdr-private", map[string]any{
			"name": "xdr-private", "runtime": "script", "platform": "xdr",
		}),
		[]string{"sdsp", "mssw", "sdsp"},
	)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			SkillID       string `json:"skillId"`
			PlatformsJSON string `json:"platformsJson"`
			ManifestJSON  string `json:"manifestJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.PlatformsJSON != `["mssw","sdsp"]` ||
		!strings.Contains(created.Skill.ManifestJSON, `"platforms":["mssw","sdsp"]`) {
		t.Fatalf("private override platforms = %+v", created.Skill)
	}
}

func TestSkillAPI_PrivateUploadPlatformOverrideAllowsPlatformlessSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUploadFileWithPlatforms(
		alice.HumanUserID, "generic-private", "generic-private.tar.gz",
		makeSkillBundle(t, "generic-private", map[string]any{
			"name": "generic-private", "runtime": "script",
		}), []string{},
	)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			Name          string `json:"name"`
			PlatformsJSON string `json:"platformsJson"`
			ManifestJSON  string `json:"manifestJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "generic-private" || created.Skill.PlatformsJSON != `[]` ||
		!strings.Contains(created.Skill.ManifestJSON, `"platforms":[]`) {
		t.Fatalf("platformless private override = %+v", created.Skill)
	}
}

func TestSkillAPI_PrivateDeleteDoesNotDependOnRuntime(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	asset := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID,
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/xdr-private",
		ManifestHash: "sha256:private", PlatformsJSON: `["xdr"]`,
	})
	e.drv.execStdinErr = errors.New("runtime unavailable")

	rr := e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+asset.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	got, err := e.store.GetSkillAsset(asset.SkillID)
	if err != nil || got.Status != repo.SkillStatusDeleted {
		t.Fatalf("private Skill should be deleted without runtime access: %+v, %v", got, err)
	}
}

func TestSkillAPI_PrivateDeleteThenUploadSameName(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUpload(alice.HumanUserID, "replace-private", makeSkillBundle(
		t, "replace-private", map[string]any{"name": "replace-private", "runtime": "script", "version": "1.0.0"},
	))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			SkillID string `json:"skillId"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())

	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+created.Skill.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	rr = e.privateSkillUpload(alice.HumanUserID, "replace-private", makeSkillBundle(
		t, "replace-private", map[string]any{"name": "replace-private", "runtime": "script", "version": "2.0.0"},
	))
	assertStatus(t, rr, http.StatusCreated)
}

func TestSkillAPI_PublicUploadCreatesAssetAndMarksPods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	e.reconcile.podIDs = nil // ignore pod-creation enqueues from setup

	rr := e.publicSkillUpload("xdr-public.tar.gz", makeSkillBundle(t, "xdr-public", map[string]any{
		"name": "xdr-public", "runtime": "script", "version": "1.2.0",
		"platforms": []string{"xdr"}, "progress": map[string]any{"source": "manual"},
	}))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			SkillID       string `json:"skillId"`
			Name          string `json:"name"`
			Scope         string `json:"scope"`
			Version       string `json:"version"`
			PlatformsJSON string `json:"platformsJson"`
		} `json:"skill"`
		AffectedPodIDs []string `json:"affectedPodIds"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "xdr-public" || created.Skill.Scope != repo.SkillScopePublic ||
		created.Skill.Version != "1.2.0" || !strings.Contains(created.Skill.PlatformsJSON, "xdr") {
		t.Fatalf("public Skill response = %+v", created)
	}
	if len(created.AffectedPodIDs) != 1 || created.AffectedPodIDs[0] != "pod-a" {
		t.Fatalf("affected Pod IDs = %v", created.AffectedPodIDs)
	}
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "xdr-public", "SKILL.md")); err != nil {
		t.Fatalf("public Skill was not written: %v", err)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("public upload should auto-enqueue reconcile for affected Pods: %v", e.reconcile.podIDs)
	}
}

func TestSkillAPI_PublicUploadRespectsConfiguredMaxSize(t *testing.T) {
	e := newTestEnv(t)
	// 把上传压缩包上限压到 1 字节，重建 handler 使配置生效。
	// 任何非空 bundle 都必然超限；若代码未 respect 配置（仍写死 5MB），此测试会因上传成功而失败。
	e.cfg.SkillMaxUploadBundleBytes = 1
	e.h = api.NewServer(e.cfg, e.store, e.cipher, e.drv, e.cache, e.syncer, e.reconcile).Handler()

	rr := e.publicSkillUpload("tiny.tar.gz", makeSkillBundle(t, "tiny", map[string]any{"name": "tiny"}))
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), `"code":40504`) {
		t.Fatalf("oversize upload body = %s, want code 40504", rr.Body.String())
	}
}

func TestSkillAPI_ConcurrentPublicUploadSameNameDoesNotRemoveWinner(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	start := make(chan struct{})
	bundles := [][]byte{
		makeSkillBundle(t, "race-public", map[string]any{
			"name": "race-public", "runtime": "script", "version": "1.0.0",
		}),
		makeSkillBundle(t, "race-public", map[string]any{
			"name": "race-public", "runtime": "script", "version": "2.0.0",
		}),
	}
	responses := make([]*httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for index, bundle := range bundles {
		wg.Add(1)
		go func(index int, bundle []byte) {
			defer wg.Done()
			<-start
			responses[index] = e.publicSkillUpload("race-public.tar.gz", bundle)
		}(index, bundle)
	}
	close(start)
	wg.Wait()

	created, conflicted := 0, 0
	for _, rr := range responses {
		switch rr.Code {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicted++
		default:
			t.Fatalf("concurrent upload status = %d, body=%s", rr.Code, rr.Body.String())
		}
	}
	if created != 1 || conflicted != 1 {
		t.Fatalf("concurrent upload statuses: created=%d conflict=%d", created, conflicted)
	}
	assets, err := e.store.ListSkillAssetsByName("race-public")
	if err != nil || len(assets) != 1 {
		t.Fatalf("race public Skill assets = %+v, %v", assets, err)
	}
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "race-public", "SKILL.md")); err != nil {
		t.Fatalf("winning public Skill files were removed: %v", err)
	}
}

func TestSkillAPI_PublicDeleteThenUploadSameName(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)

	rr := e.publicSkillUpload("replace-public.tar.gz", makeSkillBundle(t, "replace-public", map[string]any{
		"name": "replace-public", "runtime": "script", "version": "1.0.0",
	}))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			SkillID string `json:"skillId"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())

	rr = e.do(http.MethodPatch, "/api/v1/skills/"+created.Skill.SkillID, `{"status":"deleted"}`)
	assertStatus(t, rr, http.StatusOK)
	rr = e.publicSkillUpload("replace-public.tar.gz", makeSkillBundle(t, "replace-public", map[string]any{
		"name": "replace-public", "runtime": "script", "version": "2.0.0",
	}))
	assertStatus(t, rr, http.StatusCreated)
}

func TestSkillAPI_PublicUploadAllowsPlatformlessSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)

	rr := e.publicSkillUpload("web-tools-guide.tar.gz", makeSkillBundle(t, "web-tools-guide", map[string]any{
		"name": "web-tools-guide", "runtime": "prompt",
	}))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			Name          string `json:"name"`
			PlatformsJSON string `json:"platformsJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "web-tools-guide" || created.Skill.PlatformsJSON != `[]` {
		t.Fatalf("platformless public Skill = %+v", created.Skill)
	}
}

func TestSkillAPI_PublicUploadPlatformOverrideAllowsPlatformlessSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)

	rr := e.publicSkillUploadWithPlatforms(
		"generic-public.tar.gz",
		makeSkillBundle(t, "generic-public", map[string]any{
			"name": "generic-public", "runtime": "script", "platform": "xdr",
		}),
		[]string{},
	)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			Name          string `json:"name"`
			PlatformsJSON string `json:"platformsJson"`
			ManifestJSON  string `json:"manifestJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "generic-public" || created.Skill.PlatformsJSON != `[]` ||
		!strings.Contains(created.Skill.ManifestJSON, `"platforms":[]`) {
		t.Fatalf("platformless public override = %+v", created.Skill)
	}
}

func TestSkillAPI_PublicUploadPlatformOverrideSupportsMultiplePlatforms(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "mssw", "MSSW")
	createTestPlatform(t, e.store, "sdsp", "SDSP")

	rr := e.publicSkillUploadWithPlatforms(
		"report-bridge.tar.gz",
		makeSkillBundle(t, "report-bridge", map[string]any{
			"name": "report-bridge", "runtime": "script",
		}),
		[]string{"sdsp", "mssw", "sdsp"},
	)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			PlatformsJSON string `json:"platformsJson"`
			ManifestJSON  string `json:"manifestJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.PlatformsJSON != `["mssw","sdsp"]` ||
		!strings.Contains(created.Skill.ManifestJSON, `"platforms":["mssw","sdsp"]`) {
		t.Fatalf("public override platforms = %+v", created.Skill)
	}
}

func TestSkillAPI_PublicStorageStatusAndEnsure(t *testing.T) {
	e := newTestEnv(t)
	e.drv.publicSkillStorage = driver.PublicSkillsStorageStatus{
		Driver: "k8s", Name: "muad-skills", Namespace: "muad",
		Configured: true, Ready: false, Phase: "Missing", AccessMode: "ReadWriteMany",
		Size: "5Gi",
	}

	rr := e.do(http.MethodGet, "/api/v1/skills/public-storage", "")
	assertStatus(t, rr, http.StatusOK)
	status := decodeAPIData[struct {
		Name  string `json:"name"`
		Ready bool   `json:"ready"`
		Phase string `json:"phase"`
	}](t, rr.Body.Bytes())
	if status.Name != "muad-skills" || status.Ready || status.Phase != "Missing" {
		t.Fatalf("public storage status = %+v", status)
	}

	rr = e.do(http.MethodPost, "/api/v1/skills/public-storage", "")
	assertStatus(t, rr, http.StatusOK)
	status = decodeAPIData[struct {
		Name  string `json:"name"`
		Ready bool   `json:"ready"`
		Phase string `json:"phase"`
	}](t, rr.Body.Bytes())
	if status.Name != "muad-skills" || !status.Ready || status.Phase != "Bound" {
		t.Fatalf("ensured public storage status = %+v", status)
	}
}

func TestSkillAPI_PublicUploadRequiresReadyStorage(t *testing.T) {
	e := newTestEnv(t)
	e.drv.publicSkillStorage = driver.PublicSkillsStorageStatus{
		Driver: "k8s", Name: "muad-skills", Configured: true, Ready: false, Phase: "Missing",
	}

	rr := e.publicSkillUpload("xdr-public.tar.gz", makeSkillBundle(t, "xdr-public", map[string]any{
		"name": "xdr-public", "runtime": "script",
	}))
	assertStatus(t, rr, http.StatusConflict)
	if strings.Contains(rr.Body.String(), "SKILL.md") {
		t.Fatalf("upload parsed bundle before checking storage readiness: %s", rr.Body.String())
	}
}

func TestSkillAPI_PublicUploadAcceptsZipBundle(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "sdsp", "SDSP")

	rr := e.publicSkillUpload("sdsp-public.zip", makeZipSkillBundle(t, "sdsp-public", map[string]any{
		"name": "sdsp-public", "runtime": "script", "platform": "sdsp",
	}))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			Name          string `json:"name"`
			Scope         string `json:"scope"`
			PlatformsJSON string `json:"platformsJson"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "sdsp-public" || created.Skill.Scope != repo.SkillScopePublic ||
		!strings.Contains(created.Skill.PlatformsJSON, "sdsp") {
		t.Fatalf("zip public Skill response = %+v", created)
	}
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "sdsp-public", "SKILL.md")); err != nil {
		t.Fatalf("zip public Skill was not written: %v", err)
	}
}

func TestSkillAPI_PublicUploadIgnoresZipMetadataEntries(t *testing.T) {
	e := newTestEnv(t)
	createTestPlatform(t, e.store, "mssw", "MSSW")

	rr := e.publicSkillUpload("mssw-public.zip", makeZipWithFiles(t, map[string][]byte{
		"mssw-public/":                           {},
		"mssw-public/SKILL.md":                   []byte("---\nname: mssw-public\ndescription: MSSW public Skill.\n---\n# MSSW\n"),
		"mssw-public/muad.skill.json":            []byte(`{"name":"mssw-public","platform":"mssw"}`),
		"mssw-public/.DS_Store":                  []byte("metadata"),
		"__MACOSX/mssw-public/._SKILL.md":        []byte("metadata"),
		"__MACOSX/mssw-public/._muad.skill.json": []byte("metadata"),
	}))
	assertStatus(t, rr, http.StatusCreated)
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "mssw-public", "SKILL.md")); err != nil {
		t.Fatalf("zip public Skill with metadata was not written: %v", err)
	}
}

func TestSkillAPI_PublicUploadUsesSkillMarkdownFrontmatterName(t *testing.T) {
	e := newTestEnv(t)
	createTestPlatform(t, e.store, "mssw", "MSSW")

	rr := e.publicSkillUpload("web-tools-guide-1.0.2.zip", makeZipWithFiles(t, map[string][]byte{
		"web-tools-guide-1.0.2/SKILL.md":        []byte("---\nname: web-tools-guide\ndescription: test\n---\n# Web\n"),
		"web-tools-guide-1.0.2/muad.skill.json": []byte(`{"platform":"mssw"}`),
	}))
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Skill struct {
			Name       string `json:"name"`
			SourcePath string `json:"sourcePath"`
		} `json:"skill"`
	}](t, rr.Body.Bytes())
	if created.Skill.Name != "web-tools-guide" ||
		!strings.HasSuffix(created.Skill.SourcePath, filepath.Join("web-tools-guide")) {
		t.Fatalf("frontmatter Skill response = %+v", created)
	}
	if _, err := os.ReadFile(filepath.Join(e.skillsDir, "web-tools-guide", "SKILL.md")); err != nil {
		t.Fatalf("frontmatter public Skill was not written: %v", err)
	}
}

func TestSkillAPI_PublicUploadRejectsMissingOpenClawFrontmatter(t *testing.T) {
	e := newTestEnv(t)

	rr := e.publicSkillUpload("policy-check.zip", makeZipWithFiles(t, map[string][]byte{
		"policy-check/SKILL.md":        []byte("# Policy Check\n"),
		"policy-check/muad.skill.json": []byte(`{"name":"policy-check"}`),
	}))

	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "frontmatter") {
		t.Fatalf("frontmatter upload error not surfaced: %s", rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(e.skillsDir, "policy-check")); !os.IsNotExist(err) {
		t.Fatalf("invalid public Skill directory should not be written: %v", err)
	}
}

func TestSkillAPI_PublicUploadRejectsManifestFrontmatterNameMismatch(t *testing.T) {
	e := newTestEnv(t)

	rr := e.publicSkillUpload("policy-check.zip", makeZipWithFiles(t, map[string][]byte{
		"policy-check/SKILL.md":        []byte("---\nname: policy-check\ndescription: Policy check Skill.\n---\n# Policy\n"),
		"policy-check/muad.skill.json": []byte(`{"name":"extract"}`),
	}))

	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "frontmatter name") {
		t.Fatalf("name mismatch upload error not surfaced: %s", rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(e.skillsDir, "extract")); !os.IsNotExist(err) {
		t.Fatalf("mismatched public Skill directory should not be written: %v", err)
	}
}

func TestSkillAPI_PublicUploadRejectsUnsafeZipPath(t *testing.T) {
	e := newTestEnv(t)

	rr := e.publicSkillUpload("bad.zip", makeZipWithFiles(t, map[string][]byte{
		"../evil/SKILL.md": []byte("# bad\n"),
	}))
	assertStatus(t, rr, http.StatusBadRequest)
	if _, err := os.Stat(filepath.Join(e.skillsDir, "evil")); !os.IsNotExist(err) {
		t.Fatalf("unsafe zip wrote outside target: %v", err)
	}
}

func TestSkillAPI_PublicUploadRejectsSystemOverrideBeforeWriting(t *testing.T) {
	e := newTestEnv(t)
	if err := os.MkdirAll(filepath.Join(e.skillsDir, "session-manager"), 0o700); err != nil {
		t.Fatalf("mkdir system dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(e.skillsDir, "session-manager", "SKILL.md"), []byte("original"), 0o600); err != nil {
		t.Fatalf("write system file: %v", err)
	}
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopeSystem,
		SourcePath: filepath.Join(e.skillsDir, "session-manager"), ManifestHash: "sha256:system",
	})

	rr := e.publicSkillUpload("session-manager.tar.gz", makeSkillBundle(t, "session-manager", map[string]any{
		"name": "session-manager", "runtime": "script",
	}))
	assertStatus(t, rr, http.StatusBadRequest)
	got, err := os.ReadFile(filepath.Join(e.skillsDir, "session-manager", "SKILL.md"))
	if err != nil || string(got) != "original" {
		t.Fatalf("system Skill directory was changed: %q, %v", string(got), err)
	}
}

func TestSkillAPI_PrivateUploadRejectsPublicConflictAndCleansLocalStaging(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-private", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`,
	})

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script", "platform": "xdr"},
	))
	assertStatus(t, rr, http.StatusConflict)
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("private upload conflict should not touch runtime: %+v", e.drv.execStdinCalls)
	}
	if _, err := os.Stat(filepath.Join(e.skillsDir, "_private", alice.HumanUserID, "xdr-private")); !os.IsNotExist(err) {
		t.Fatalf("conflicted private Skill directory should be cleaned up: %v", err)
	}
}

func TestSkillAPI_PrivateUploadRejectsExistingPrivateWithoutReplacingFiles(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	privateDir := filepath.Join(e.skillsDir, "_private", alice.HumanUserID, "xdr-private")
	if err := os.MkdirAll(privateDir, 0o700); err != nil {
		t.Fatalf("mkdir private Skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(privateDir, "SKILL.md"), []byte("# old\n"), 0o600); err != nil {
		t.Fatalf("write private Skill file: %v", err)
	}
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID,
		SourcePath: privateDir, ManifestHash: "sha256:private", PlatformsJSON: `[]`,
	})

	rr := e.privateSkillUploadFile(alice.HumanUserID, "xdr-private", "xdr-private.zip", makeZipWithFiles(
		t, map[string][]byte{
			"xdr-private/SKILL.md":        []byte("# new\n"),
			"xdr-private/muad.skill.json": []byte(`{"name":"xdr-private","runtime":"script"}`),
		},
	))
	assertStatus(t, rr, http.StatusConflict)
	got, err := os.ReadFile(filepath.Join(privateDir, "SKILL.md"))
	if err != nil || string(got) != "# old\n" {
		t.Fatalf("existing private Skill file was changed: %q, %v", got, err)
	}
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("private upload conflict should not touch runtime: %+v", e.drv.execStdinCalls)
	}
}

func TestSkillAPI_PrivateUploadAllowsPublicOverrideWithPolicy(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-private", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`,
	})
	if _, err := e.store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-private",
		Action: repo.SkillPolicyAllowOverride, CreatedBy: "root",
	}); err != nil {
		t.Fatalf("CreateSkillPolicy: %v", err)
	}

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script", "platform": "xdr"},
	))
	assertStatus(t, rr, http.StatusCreated)
}

func TestSkillAPI_PrivateUploadAllowOverrideCreatesPolicyAtomically(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-private", ManifestHash: "sha256:public",
		PlatformsJSON: `["xdr"]`,
	})

	rr := e.privateSkillUploadFileWithOptions(
		alice.HumanUserID, "xdr-private", "xdr-private.tar.gz", []byte("not a bundle"), nil, true,
	)
	assertStatus(t, rr, http.StatusBadRequest)
	policies, err := e.store.ListSkillPoliciesByHumanUser(alice.HumanUserID)
	if err != nil || len(policies) != 0 {
		t.Fatalf("failed upload should not create policy: %+v, %v", policies, err)
	}

	rr = e.privateSkillUploadFileWithOptions(
		alice.HumanUserID, "xdr-private", "xdr-private.tar.gz",
		makeSkillBundle(t, "xdr-private", map[string]any{
			"name": "xdr-private", "runtime": "script", "platform": "xdr",
		}), nil, true,
	)
	assertStatus(t, rr, http.StatusCreated)
	policies, err = e.store.ListSkillPoliciesByHumanUser(alice.HumanUserID)
	if err != nil || len(policies) != 1 ||
		policies[0].SkillName != "xdr-private" ||
		policies[0].Action != repo.SkillPolicyAllowOverride {
		t.Fatalf("successful override policy = %+v, %v", policies, err)
	}
}

func TestSkillAPI_PrivateUploadAllowsNonRunningPod(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	if err := e.store.UpdatePodState("pod-a", repo.PodStateStopped); err != nil {
		t.Fatalf("stop Pod: %v", err)
	}
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script"},
	))
	assertStatus(t, rr, http.StatusCreated)
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("non-running Pod upload should not exec installer: %+v", e.drv.execStdinCalls)
	}
}

func (e *testEnv) privateSkillUpload(
	humanUserID, expectedName string, bundle []byte,
) *httptest.ResponseRecorder {
	return e.privateSkillUploadFile(humanUserID, expectedName, expectedName+".tar.gz", bundle)
}

func (e *testEnv) privateSkillUploadFile(
	humanUserID, expectedName, filename string, bundle []byte,
) *httptest.ResponseRecorder {
	return e.privateSkillUploadFileWithPlatforms(humanUserID, expectedName, filename, bundle, nil)
}

func (e *testEnv) privateSkillUploadFileWithPlatforms(
	humanUserID, expectedName, filename string, bundle []byte, platforms []string,
) *httptest.ResponseRecorder {
	return e.privateSkillUploadFileWithOptions(
		humanUserID, expectedName, filename, bundle, platforms, false,
	)
}

func (e *testEnv) privateSkillUploadFileWithOptions(
	humanUserID, expectedName, filename string, bundle []byte, platforms []string, allowOverride bool,
) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("expectedName", expectedName)
	if platforms != nil {
		raw, _ := json.Marshal(platforms)
		_ = writer.WriteField("platforms", string(raw))
	}
	if allowOverride {
		_ = writer.WriteField("allowOverride", "true")
	}
	file, _ := writer.CreateFormFile("bundle", filename)
	_, _ = file.Write(bundle)
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/human-users/"+humanUserID+"/skills/private", &body)
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	return rr
}

func (e *testEnv) publicSkillUpload(filename string, bundle []byte) *httptest.ResponseRecorder {
	return e.publicSkillUploadWithPlatforms(filename, bundle, nil)
}

func (e *testEnv) publicSkillUploadWithPlatforms(
	filename string, bundle []byte, platforms []string,
) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if platforms != nil {
		raw, _ := json.Marshal(platforms)
		_ = writer.WriteField("platforms", string(raw))
	}
	file, _ := writer.CreateFormFile("bundle", filename)
	_, _ = file.Write(bundle)
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/skills/public", &body)
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	return rr
}

func makeSkillBundle(t *testing.T, name string, manifest map[string]any) []byte {
	t.Helper()
	var body bytes.Buffer
	gz := gzip.NewWriter(&body)
	tarball := tar.NewWriter(gz)
	writeTarFile(t, tarball, name+"/SKILL.md", []byte(skillMarkdownFixture(name)))
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	writeTarFile(t, tarball, name+"/muad.skill.json", rawManifest)
	if err := tarball.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return body.Bytes()
}

func makeZipSkillBundle(t *testing.T, name string, manifest map[string]any) []byte {
	t.Helper()
	var body bytes.Buffer
	archive := zip.NewWriter(&body)
	writeZipFile(t, archive, name+"/SKILL.md", []byte(skillMarkdownFixture(name)))
	rawManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	writeZipFile(t, archive, name+"/muad.skill.json", rawManifest)
	if err := archive.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return body.Bytes()
}

func skillMarkdownFixture(name string) string {
	return fmt.Sprintf("---\nname: %s\ndescription: %s test Skill.\n---\n# %s\n", name, name, name)
}

func makeZipWithFiles(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var archiveBody bytes.Buffer
	archive := zip.NewWriter(&archiveBody)
	for name, body := range files {
		writeZipFile(t, archive, name, body)
	}
	if err := archive.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return archiveBody.Bytes()
}

func writeTarFile(t *testing.T, writer *tar.Writer, name string, body []byte) {
	t.Helper()
	if err := writer.WriteHeader(&tar.Header{
		Name: name, Mode: 0o600, Size: int64(len(body)),
	}); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := writer.Write(body); err != nil {
		t.Fatalf("write tar body: %v", err)
	}
}

func writeZipFile(t *testing.T, writer *zip.Writer, name string, body []byte) {
	t.Helper()
	file, err := writer.Create(name)
	if err != nil {
		t.Fatalf("create zip file: %v", err)
	}
	if _, err := file.Write(body); err != nil {
		t.Fatalf("write zip body: %v", err)
	}
}

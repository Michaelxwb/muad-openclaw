package test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSkillAPI_ListDetailEffectiveAndPolicies(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	publicSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:public",
	})
	privateSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePrivate, HumanUserID: alice.HumanUserID,
		PodID: "pod-a", SourcePath: "/home/node/.openclaw/workspace-alice/skills/xdr-query",
		ManifestHash: "sha256:private",
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
	if len(e.reconcile.podIDs) == 0 || e.reconcile.podIDs[len(e.reconcile.podIDs)-1] != "pod-a" {
		t.Fatalf("policy did not enqueue reconcile: %v", e.reconcile.podIDs)
	}

	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skill-policies/"+policy.PolicyID, "")
	assertStatus(t, rr, http.StatusOK)
}

func TestSkillAPI_StatusUpdateAndProtectedSystemSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	if err := os.MkdirAll(filepath.Join(e.skillsDir, "soar-sync"), 0o700); err != nil {
		t.Fatalf("create public Skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(e.skillsDir, "soar-sync", "SKILL.md"), []byte("skill"), 0o600); err != nil {
		t.Fatalf("write public Skill file: %v", err)
	}
	publicSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "soar-sync", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/soar-sync", ManifestHash: "sha256:soar",
	})
	systemSkill := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "session-manager", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/session-manager", ManifestHash: "sha256:system",
	})

	rr := e.do(http.MethodPatch, "/api/v1/skills/"+publicSkill.SkillID, `{"status":"disabled"}`)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"affectedPodIds":["pod-a"]`) {
		t.Fatalf("patch Skill response = %s", rr.Body.String())
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
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", []byte("bundle"))
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
	if len(e.drv.execStdinCalls) != 1 || !strings.Contains(
		strings.Join(e.drv.execStdinCalls[0].cmd, " "), "private-skill-installer.mjs install",
	) {
		t.Fatalf("installer calls = %+v", e.drv.execStdinCalls)
	}
	if len(e.reconcile.podIDs) == 0 || e.reconcile.podIDs[len(e.reconcile.podIDs)-1] != "pod-a" {
		t.Fatalf("upload reconcile queue = %v", e.reconcile.podIDs)
	}

	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+created.Skill.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	got, err := e.store.GetSkillAsset(created.Skill.SkillID)
	if err != nil || got.Status != repo.SkillStatusDeleted {
		t.Fatalf("deleted private Skill = %+v, %v", got, err)
	}
	if len(e.drv.execStdinCalls) != 2 || !strings.Contains(
		strings.Join(e.drv.execStdinCalls[1].cmd, " "), "private-skill-installer.mjs delete",
	) {
		t.Fatalf("delete installer calls = %+v", e.drv.execStdinCalls)
	}
}

func TestSkillAPI_PrivateUploadAcceptsZipBundle(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUploadFile(
		alice.HumanUserID, "sdsp-private", "sdsp-private.zip",
		makeZipSkillBundle(t, "sdsp-private", map[string]any{
			"name": "sdsp-private", "runtime": "script", "platform": "sdsp",
		}),
	)
	assertStatus(t, rr, http.StatusCreated)
	if len(e.drv.execStdinCalls) != 1 {
		t.Fatalf("installer calls = %+v", e.drv.execStdinCalls)
	}
	cmd := strings.Join(e.drv.execStdinCalls[0].cmd, " ")
	if !strings.Contains(cmd, "--bundle-format zip") {
		t.Fatalf("installer did not receive zip format: %v", e.drv.execStdinCalls[0].cmd)
	}
}

func TestSkillAPI_PrivateDeleteRuntimeFailureDoesNotMutateDB(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	asset := createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePrivate,
		HumanUserID: alice.HumanUserID, PodID: alice.PodID,
		SourcePath:   "/home/node/.openclaw/workspace-alice/skills/xdr-private",
		ManifestHash: "sha256:private",
	})
	e.drv.execStdinErr = errors.New("runtime unavailable")

	rr := e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+asset.SkillID, "")
	assertStatus(t, rr, http.StatusBadGateway)
	got, err := e.store.GetSkillAsset(asset.SkillID)
	if err != nil || got.Status != repo.SkillStatusActive {
		t.Fatalf("private Skill should remain active after runtime failure: %+v, %v", got, err)
	}
}

func TestSkillAPI_PublicUploadCreatesAssetAndMarksPods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)

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
	if len(e.reconcile.podIDs) == 0 || e.reconcile.podIDs[len(e.reconcile.podIDs)-1] != "pod-a" {
		t.Fatalf("public upload reconcile queue = %v", e.reconcile.podIDs)
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

	rr := e.publicSkillUpload("mssw-public.zip", makeZipWithFiles(t, map[string][]byte{
		"mssw-public/":                           {},
		"mssw-public/SKILL.md":                   []byte("# MSSW\n"),
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

	rr := e.publicSkillUpload("web-tools-guide-1.0.2.zip", makeZipWithFiles(t, map[string][]byte{
		"web-tools-guide-1.0.2/SKILL.md": []byte("---\nname: web-tools-guide\ndescription: test\n---\n# Web\n"),
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

func TestSkillAPI_PrivateUploadRejectsPublicConflictAndCleansRuntime(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-private", ManifestHash: "sha256:public",
	})

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", []byte("bundle"))
	assertStatus(t, rr, http.StatusConflict)
	if len(e.drv.execStdinCalls) != 2 || !strings.Contains(
		strings.Join(e.drv.execStdinCalls[1].cmd, " "), "private-skill-installer.mjs delete",
	) {
		t.Fatalf("conflict cleanup calls = %+v", e.drv.execStdinCalls)
	}
}

func TestSkillAPI_PrivateUploadAllowsPublicOverrideWithPolicy(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "xdr-private", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-private", ManifestHash: "sha256:public",
	})
	if _, err := e.store.CreateSkillPolicy(repo.SkillPolicy{
		HumanUserID: alice.HumanUserID, SkillName: "xdr-private",
		Action: repo.SkillPolicyAllowOverride, CreatedBy: "root",
	}); err != nil {
		t.Fatalf("CreateSkillPolicy: %v", err)
	}

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", []byte("bundle"))
	assertStatus(t, rr, http.StatusCreated)
}

func TestSkillAPI_PrivateUploadRejectsNonRunningPod(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	if err := e.store.UpdatePodState("pod-a", repo.PodStateStopped); err != nil {
		t.Fatalf("stop Pod: %v", err)
	}
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", []byte("bundle"))
	assertStatus(t, rr, http.StatusConflict)
	if len(e.drv.execStdinCalls) != 0 {
		t.Fatalf("non-running Pod should not exec installer: %+v", e.drv.execStdinCalls)
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
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("expectedName", expectedName)
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
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
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
	writeTarFile(t, tarball, name+"/SKILL.md", []byte("# "+name+"\n"))
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
	writeZipFile(t, archive, name+"/SKILL.md", []byte("# "+name+"\n"))
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

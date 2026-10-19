package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// TestAdminSkillReviewFlow_S07 verifies the existing admin review workflow end
// to end without new production code: download a user's pending bundle, install
// it privately under the admin's own Human User, sync it to the admin agent
// workspace through the installer, then delete the temporary copy. The original
// user's asset and workspace must stay untouched, and layering/conflict rules
// must keep their existing semantics.
func TestAdminSkillReviewFlow_S07(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-admin"))
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	admin := createTestHumanUser(t, e.store, "pod-admin", "review-admin", repo.HumanUserStatusActive)

	const name = "review-target"
	skillID := ingestReviewSkill(t, e, alice, name)
	aliceDir := filepath.Join(e.skillsDir, "_private", alice.HumanUserID, name)
	aliceBefore, err := os.ReadFile(filepath.Join(aliceDir, "SKILL.md"))
	if err != nil || !strings.Contains(string(aliceBefore), reviewSkillMarker) {
		t.Fatalf("pending Skill staging = %q, %v", string(aliceBefore), err)
	}

	// 1. Admin downloads the pending bundle.
	rr := e.do(http.MethodGet, "/api/v1/skills/"+skillID+"/download", "")
	assertStatus(t, rr, http.StatusOK)
	if disposition := rr.Header().Get("Content-Disposition"); !strings.Contains(disposition, name+".tar.gz") {
		t.Fatalf("download disposition = %q", disposition)
	}
	downloaded := rr.Body.Bytes()
	if files := readGzipTarFiles(t, downloaded); !strings.Contains(files["SKILL.md"], reviewSkillMarker) {
		t.Fatalf("downloaded bundle = %+v", files)
	}

	// 2. Admin installs the bundle under their own Human User (private scope).
	rr = e.privateSkillUploadFile(admin.HumanUserID, name, name+".tar.gz", downloaded)
	assertStatus(t, rr, http.StatusCreated)
	adminSkill := decodeAPIData[struct {
		Skill struct {
			SkillID     string `json:"skillId"`
			Name        string `json:"name"`
			Scope       string `json:"scope"`
			HumanUserID string `json:"humanUserId"`
			Status      string `json:"status"`
		} `json:"skill"`
	}](t, rr.Body.Bytes()).Skill
	if adminSkill.SkillID == "" || adminSkill.SkillID == skillID ||
		adminSkill.Scope != repo.SkillScopePrivate ||
		adminSkill.HumanUserID != admin.HumanUserID || adminSkill.Status != repo.SkillStatusActive {
		t.Fatalf("admin review copy = %+v", adminSkill)
	}
	adminDir := filepath.Join(e.skillsDir, "_private", admin.HumanUserID, name)
	adminFiles, err := os.ReadFile(filepath.Join(adminDir, "SKILL.md"))
	if err != nil || !strings.Contains(string(adminFiles), reviewSkillMarker) {
		t.Fatalf("admin staging = %q, %v", string(adminFiles), err)
	}

	// 3. Same-name private conflicts keep the existing policy: a duplicate
	// private copy for the same user is rejected without replacing files.
	rr = e.privateSkillUploadFile(admin.HumanUserID, name, name+".tar.gz", downloaded)
	assertStatus(t, rr, http.StatusConflict)
	if got, err := os.ReadFile(filepath.Join(adminDir, "SKILL.md")); err != nil ||
		!strings.Contains(string(got), reviewSkillMarker) {
		t.Fatalf("conflict changed admin staging: %q, %v", string(got), err)
	}

	// Cross-user delete must not touch another user's private asset.
	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+alice.HumanUserID+"/skills/private/"+adminSkill.SkillID, "")
	assertStatus(t, rr, http.StatusNotFound)
	assertReviewAsset(t, e, adminSkill.SkillID, admin.HumanUserID, repo.SkillStatusActive)

	// 4. The runtime apply chain installs the copy only for the admin agent.
	e.drv.execStdinCalls = nil
	if err := e.syncer.SyncPod(context.Background(), "pod-admin"); err != nil {
		t.Fatalf("sync admin Pod: %v", err)
	}
	install := reviewInstallerCall(t, e.drv.execStdinCalls, "install", admin.AgentID)
	if argValue(install.cmd, "--expected-name") != name {
		t.Fatalf("installer expected name = %q", argValue(install.cmd, "--expected-name"))
	}
	if files := readGzipTarFiles(t, []byte(install.stdin)); !strings.Contains(files[name+"/SKILL.md"], reviewSkillMarker) {
		t.Fatalf("installer bundle = %+v", files)
	}
	if e.drv.privateSkillHashes[admin.AgentID][name] == "" {
		t.Fatalf("admin agent workspace state = %+v", e.drv.privateSkillHashes[admin.AgentID])
	}
	assertNoAgentCalls(t, e.drv.execStdinCalls, alice.AgentID)
	assertReviewAsset(t, e, skillID, alice.HumanUserID, repo.SkillStatusPending)

	adminList := effectiveSkillsByName(t, e, admin.HumanUserID)
	if item := adminList[name]; item.PrivateSkillID != adminSkill.SkillID ||
		item.EffectiveSource != repo.SkillScopePrivate ||
		item.Status != repo.EffectiveSkillStatusEffective {
		t.Fatalf("admin effective Skill = %+v", item)
	}
	aliceList := effectiveSkillsByName(t, e, alice.HumanUserID)
	if item := aliceList[name]; item.PrivateSkillID != skillID ||
		item.Status != repo.EffectiveSkillStatusPending {
		t.Fatalf("alice effective Skill = %+v", item)
	}

	// 5. Delete the temporary copy: staging and the admin agent copy are cleaned
	// up while the original user's pending asset stays untouched.
	rr = e.do(http.MethodDelete,
		"/api/v1/human-users/"+admin.HumanUserID+"/skills/private/"+adminSkill.SkillID, "")
	assertStatus(t, rr, http.StatusOK)
	if _, err := os.Stat(adminDir); !os.IsNotExist(err) {
		t.Fatalf("admin staging should be removed, err=%v", err)
	}
	assertReviewAsset(t, e, adminSkill.SkillID, admin.HumanUserID, repo.SkillStatusDeleted)
	e.drv.execStdinCalls = nil
	if err := e.syncer.SyncPod(context.Background(), "pod-admin"); err != nil {
		t.Fatalf("sync admin Pod after delete: %v", err)
	}
	remove := reviewInstallerCall(t, e.drv.execStdinCalls, "delete", admin.AgentID)
	if argValue(remove.cmd, "--skill-name") != name {
		t.Fatalf("installer delete skill = %q", argValue(remove.cmd, "--skill-name"))
	}
	assertNoAgentCalls(t, e.drv.execStdinCalls, alice.AgentID)

	assertReviewAsset(t, e, skillID, alice.HumanUserID, repo.SkillStatusPending)
	aliceAfter, err := os.ReadFile(filepath.Join(aliceDir, "SKILL.md"))
	if err != nil || !bytes.Equal(aliceBefore, aliceAfter) {
		t.Fatalf("alice staging changed: before=%q after=%q err=%v", aliceBefore, aliceAfter, err)
	}
	if _, ok := effectiveSkillsByName(t, e, admin.HumanUserID)[name]; ok {
		t.Fatal("deleted admin review copy must disappear from the effective view")
	}
	if item := effectiveSkillsByName(t, e, alice.HumanUserID)[name]; item.PrivateSkillID != skillID {
		t.Fatalf("alice effective Skill after cleanup = %+v", item)
	}

	// 6. Layering stays unchanged after the review flow: public names still need
	// an explicit allow_override policy, and system Skills cannot be shadowed.
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "review-public-layer", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/review-public-layer", ManifestHash: "sha256:public-layer",
		PlatformsJSON: `[]`,
	})
	rr = e.privateSkillUpload(admin.HumanUserID, "review-public-layer",
		makeReviewSkillBundle(t, "review-public-layer"))
	assertStatus(t, rr, http.StatusConflict)
	rr = e.privateSkillUploadFileWithOptions(admin.HumanUserID, "review-public-layer",
		"review-public-layer.tar.gz", makeReviewSkillBundle(t, "review-public-layer"), nil, true)
	assertStatus(t, rr, http.StatusCreated)
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "review-system-layer", Scope: repo.SkillScopeSystem,
		SourcePath: "/opt/system/review-system-layer", ManifestHash: "sha256:system-layer",
	})
	rr = e.privateSkillUploadFileWithOptions(admin.HumanUserID, "review-system-layer",
		"review-system-layer.tar.gz", makeReviewSkillBundle(t, "review-system-layer"), nil, true)
	assertStatus(t, rr, http.StatusBadRequest)
}

const reviewSkillMarker = "REVIEW_ONLY_MARKER"

func makeReviewSkillBundle(t *testing.T, name string) []byte {
	t.Helper()
	var body bytes.Buffer
	gz := gzip.NewWriter(&body)
	tarball := tar.NewWriter(gz)
	writeTarFile(t, tarball, name+"/SKILL.md", []byte(
		"---\nname: "+name+"\ndescription: admin review fixture.\n---\n# "+name+"\n\n"+reviewSkillMarker+"\n"))
	writeTarFile(t, tarball, name+"/muad.skill.json",
		[]byte(`{"name":"`+name+`","author":"Test Author","runtime":"script"}`))
	if err := tarball.Close(); err != nil {
		t.Fatalf("close review bundle tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close review bundle gzip: %v", err)
	}
	return body.Bytes()
}

func ingestReviewSkill(t *testing.T, e *testEnv, user repo.HumanUser, name string) string {
	t.Helper()
	bundle := makeReviewSkillBundle(t, name)
	body := fmt.Sprintf(`{"agentId":%q,"bundleFormat":"tar.gz","bundle":%q}`,
		user.AgentID, base64.StdEncoding.EncodeToString(bundle))
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skills/private/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created["pod-a"].ServiceToken.Value)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(&skillDeadlineRecorder{ResponseRecorder: rr}, req)
	assertStatus(t, rr, http.StatusOK)
	assets, _, err := e.store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
	})
	if err != nil || len(assets) != 1 || assets[0].Status != repo.SkillStatusPending {
		t.Fatalf("ingested pending Skill = %+v, %v", assets, err)
	}
	return assets[0].SkillID
}

func readGzipTarFiles(t *testing.T, bundle []byte) map[string]string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(bundle))
	if err != nil {
		t.Fatalf("open bundle gzip: %v", err)
	}
	defer gz.Close()
	files := map[string]string{}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return files
		}
		if err != nil {
			t.Fatalf("read bundle tar: %v", err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read bundle entry %s: %v", header.Name, err)
		}
		files[header.Name] = string(content)
	}
}

func reviewInstallerCall(t *testing.T, calls []execStdinCall, action, agentID string) execStdinCall {
	t.Helper()
	for _, call := range calls {
		if !strings.Contains(strings.Join(call.cmd, " "), "private-skill-installer.mjs "+action) {
			continue
		}
		if argValue(call.cmd, "--agent-id") == agentID {
			return call
		}
	}
	t.Fatalf("installer %s for agent %s not found: %+v", action, agentID, calls)
	return execStdinCall{}
}

func assertNoAgentCalls(t *testing.T, calls []execStdinCall, agentID string) {
	t.Helper()
	for _, call := range calls {
		if argValue(call.cmd, "--agent-id") == agentID {
			t.Fatalf("unexpected installer call for agent %s: %v", agentID, call.cmd)
		}
	}
}

func assertReviewAsset(
	t *testing.T, e *testEnv, skillID, humanUserID, status string,
) {
	t.Helper()
	asset, err := e.store.GetSkillAsset(skillID)
	if err != nil || asset.HumanUserID != humanUserID || asset.Status != status {
		t.Fatalf("Skill asset %s = %+v, %v", skillID, asset, err)
	}
}

func effectiveSkillsByName(t *testing.T, e *testEnv, humanUserID string) map[string]struct {
	Name            string `json:"name"`
	Status          string `json:"status"`
	EffectiveSource string `json:"effectiveSource"`
	PrivateSkillID  string `json:"privateSkillId"`
} {
	t.Helper()
	rr := e.do(http.MethodGet, "/api/v1/human-users/"+humanUserID+"/skills", "")
	assertStatus(t, rr, http.StatusOK)
	result := decodeAPIData[struct {
		Items []struct {
			Name            string `json:"name"`
			Status          string `json:"status"`
			EffectiveSource string `json:"effectiveSource"`
			PrivateSkillID  string `json:"privateSkillId"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	out := make(map[string]struct {
		Name            string `json:"name"`
		Status          string `json:"status"`
		EffectiveSource string `json:"effectiveSource"`
		PrivateSkillID  string `json:"privateSkillId"`
	}, len(result.Items))
	for _, item := range result.Items {
		out[item.Name] = item
	}
	return out
}

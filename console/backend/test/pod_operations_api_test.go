package test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestPodOperationsAPI_LifecycleAndStateConflicts(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/stop", ""), http.StatusOK)
	pod, _ := e.store.GetPod("pod-a")
	if pod.State != repo.PodStateStopped || e.drv.stopCalls != 1 {
		t.Fatalf("stop result = %s/%d", pod.State, e.drv.stopCalls)
	}
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/stop", ""), http.StatusConflict)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/start", ""), http.StatusOK)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/restart", ""), http.StatusOK)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/reap", ""), http.StatusBadRequest)
}

func TestPodOperationsAPI_ApplyConfigQueuesCurrentGeneration(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.reconcile.podIDs = nil
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/apply-config", "")
	assertStatus(t, rr, http.StatusAccepted)
	data := decodeAPIData[struct {
		PodID             string `json:"podId"`
		Status            string `json:"status"`
		ConfigGeneration  int64  `json:"configGeneration"`
		AppliedGeneration int64  `json:"appliedGeneration"`
	}](t, rr.Body.Bytes())
	if data.PodID != "pod-a" || data.Status != "queued" || data.ConfigGeneration != 1 || data.AppliedGeneration != 0 {
		t.Fatalf("unexpected apply response: %+v", data)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodOperationsAPI_LogsAreRedactedAndQRCodeUsesPodChannels(t *testing.T) {
	e := newTestEnv(t)
	body := `{"podId":"pod-qr","channels":["wechat"],"channelConfigs":{}}`
	createPodThroughAPI(t, e, body)
	e.drv.channelLogsOutput = "started api_key=sk-secretvalue Bearer abcdefgh\n"
	rr := e.do(http.MethodGet, "/api/v1/containers/pod-qr/logs?tail=9999", "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), "sk-secretvalue") || strings.Contains(rr.Body.String(), "abcdefgh") {
		t.Fatal("Pod logs exposed a credential")
	}
	if !strings.Contains(rr.Body.String(), `"tail":2000`) {
		t.Fatalf("log tail was not capped: %s", rr.Body.String())
	}
	rr = e.do(http.MethodGet, "/api/v1/containers/pod-qr/qrcode", "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"connected":true`) || !strings.Contains(rr.Body.String(), `"podId":"pod-qr"`) {
		t.Fatalf("unexpected QR response: %s", rr.Body.String())
	}
}

func TestPodOperationsAPI_SkillReloadReportsPartialResults(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	podABefore, _ := e.store.GetPod("pod-a")
	podBBefore, _ := e.store.GetPod("pod-b")
	e.reconcile.podIDs = nil
	e.drv.removeErr = errors.New("unused runtime error")
	body := `{"podIds":["pod-a","pod-b","pod-missing"]}`
	rr := e.do(http.MethodPost, "/api/v1/skills/reload", body)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	want := map[string]string{"pod-a": "queued", "pod-b": "queued", "pod-missing": "not_found"}
	for podID, status := range want {
		if data.Results[podID] != status {
			t.Errorf("result[%s] = %q, want %q", podID, data.Results[podID], status)
		}
	}
	if strings.Contains(rr.Body.String(), "unused runtime error") {
		t.Fatal("reload response exposed a runtime error")
	}
	if strings.Join(e.reconcile.podIDs, ",") != "pod-a,pod-b" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
	if len(e.drv.syncPublicSkillCalls) != 2 ||
		e.drv.syncPublicSkillCalls[0].podID != "pod-a" ||
		e.drv.syncPublicSkillCalls[1].podID != "pod-b" {
		t.Fatalf("public Skill sync calls = %+v", e.drv.syncPublicSkillCalls)
	}
	if e.drv.restarted["pod-a"] != 0 || e.drv.restarted["pod-b"] != 0 {
		t.Fatalf("Skill reload should enqueue config apply instead of direct restart: %+v", e.drv.restarted)
	}
	podAAfter, _ := e.store.GetPod("pod-a")
	podBAfter, _ := e.store.GetPod("pod-b")
	if podAAfter.ConfigGeneration != podABefore.ConfigGeneration+1 ||
		podBAfter.ConfigGeneration != podBBefore.ConfigGeneration+1 {
		t.Fatalf("Skill reload did not mark Pods pending: before=%d/%d after=%d/%d",
			podABefore.ConfigGeneration, podBBefore.ConfigGeneration,
			podAAfter.ConfigGeneration, podBAfter.ConfigGeneration)
	}
}

func TestPodOperationsAPI_SkillReloadWithoutPodIDsAppliesAllPods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	e.reconcile.podIDs = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{}`)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	if data.Results["pod-a"] != "queued" || data.Results["pod-b"] != "queued" {
		t.Fatalf("global reload results = %+v", data.Results)
	}
	if strings.Join(e.reconcile.podIDs, ",") != "pod-a,pod-b" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodOperationsAPI_SkillReloadSyncsOnlyActivePublicSkills(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPublicSkillDir(t, e.skillsDir, "enabled-skill")
	createPublicSkillDir(t, e.skillsDir, "disabled-skill")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "enabled-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "enabled-skill"), ManifestHash: "sha256:enabled",
	})
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "disabled-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusDisabled,
		SourcePath: filepath.Join(e.skillsDir, "disabled-skill"), ManifestHash: "sha256:disabled",
	})

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)
	if len(e.drv.syncPublicSkillCalls) != 1 {
		t.Fatalf("public Skill sync calls = %+v", e.drv.syncPublicSkillCalls)
	}
	if got := strings.Join(e.drv.syncPublicSkillCalls[0].sourceSkillNames, ","); got != "enabled-skill" {
		t.Fatalf("synced public Skills = %q, want enabled-skill", got)
	}
	if got := e.drv.syncPublicSkillCalls[0].sourceIndex; got != "disabled-skill\nenabled-skill\n" {
		t.Fatalf("managed public Skill index = %q", got)
	}
}

func TestPodOperationsAPI_SkillReloadStopsBeforeApplyWhenPublicSkillSyncFails(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.reconcile.podIDs = nil
	e.drv.syncPublicSkillErr = errors.New("sync failed")

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	if data.Results["pod-a"] != "failed_sync" {
		t.Fatalf("result[pod-a] = %q", data.Results["pod-a"])
	}
	if len(e.reconcile.podIDs) != 0 {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
	if strings.Contains(rr.Body.String(), "sync failed") {
		t.Fatal("Skill reload response exposed sync error details")
	}
}

func TestPodOperationsAPI_UpgradeAppliesTargetGeneration(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:v2"}`)
	assertStatus(t, rr, http.StatusOK)
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if pod.ImageTag != "img:v2" || pod.AppliedGeneration != pod.ConfigGeneration || pod.State != repo.PodStateRunning {
		t.Fatalf("unexpected upgraded Pod: %+v", pod)
	}
	if e.drv.created["pod-a"].ImageTag != "img:v2" || !e.drv.keepState["pod-a"] {
		t.Fatalf("unexpected upgraded runtime: %+v", e.drv.created["pod-a"])
	}
}

func TestPodOperationsAPI_UpgradeFailureRestoresOldImage(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.drv.createErrors = []error{errors.New("simulated create failure"), nil}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:bad"}`)
	assertStatus(t, rr, http.StatusBadGateway)
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if pod.ImageTag != "img:test" || pod.State != repo.PodStateRunning || pod.AppliedGeneration != pod.ConfigGeneration {
		t.Fatalf("rollback did not converge: %+v", pod)
	}
	if e.drv.created["pod-a"].ImageTag != "img:test" {
		t.Fatalf("runtime image = %q", e.drv.created["pod-a"].ImageTag)
	}
	if strings.Contains(rr.Body.String(), "simulated create failure") {
		t.Fatal("upgrade response exposed a runtime error")
	}
}

func assertStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d", response.Code, want)
	}
}

func createPublicSkillDir(t *testing.T, root, name string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir public Skill %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# "+name+"\n"), 0o600); err != nil {
		t.Fatalf("write public Skill %s: %v", name, err)
	}
}

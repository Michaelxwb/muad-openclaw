package test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
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
	markPodSkillsPending(t, e.store, "pod-a")
	markPodSkillsPending(t, e.store, "pod-b")
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
	if e.drv.restarted["pod-a"] != 0 || e.drv.restarted["pod-b"] != 0 {
		t.Fatalf("Skill reload should enqueue config apply instead of direct restart: %+v", e.drv.restarted)
	}
	podAAfter, _ := e.store.GetPod("pod-a")
	podBAfter, _ := e.store.GetPod("pod-b")
	if podAAfter.ConfigGeneration != podABefore.ConfigGeneration ||
		podBAfter.ConfigGeneration != podBBefore.ConfigGeneration ||
		podAAfter.SkillsPending || podBAfter.SkillsPending {
		t.Fatalf("Skill reload did not clear pending state: before=%d/%d after=%d/%d pending=%v/%v",
			podABefore.ConfigGeneration, podBBefore.ConfigGeneration,
			podAAfter.ConfigGeneration, podBAfter.ConfigGeneration,
			podAAfter.SkillsPending, podBAfter.SkillsPending)
	}
}

func TestPodOperationsAPI_SkillReloadWithoutPodIDsAppliesAllPods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	markPodSkillsPending(t, e.store, "pod-a")
	markPodSkillsPending(t, e.store, "pod-b")
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

func TestPodOperationsAPI_SkillReloadAlreadyAppliedResyncsFilesWithoutQueue(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	markPodApplied(t, e.store, "pod-a")
	createPublicSkillDir(t, e.skillsDir, "drift-public")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "drift-public", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "drift-public"), ManifestHash: "sha256:drift",
		PlatformsJSON: `[]`,
	})
	e.reconcile.podIDs = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	if data.Results["pod-a"] != "synced" {
		t.Fatalf("result[pod-a] = %q", data.Results["pod-a"])
	}
	if len(e.drv.syncPublicSkillCalls) != 1 || len(e.drv.execStdinCalls) != 0 ||
		len(e.reconcile.podIDs) != 0 {
		t.Fatalf("reload should repair files without queueing config apply: public=%v private=%v queue=%v",
			e.drv.syncPublicSkillCalls, e.drv.execStdinCalls, e.reconcile.podIDs)
	}
}

func TestPodOperationsAPI_SkillReloadSyncsOnlyActivePublicSkills(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	createPublicSkillDir(t, e.skillsDir, "enabled-skill")
	createPublicSkillDir(t, e.skillsDir, "disabled-skill")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "enabled-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "enabled-skill"), ManifestHash: "sha256:enabled",
		PlatformsJSON: `["xdr"]`,
	})
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "disabled-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusDisabled,
		SourcePath: filepath.Join(e.skillsDir, "disabled-skill"), ManifestHash: "sha256:disabled",
		PlatformsJSON: `["xdr"]`,
	})
	markPodSkillsPending(t, e.store, "pod-a")

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
	if got := e.drv.syncPublicSkillCalls[0].sourceRemove; got != "disabled-skill\n" {
		t.Fatalf("remove public Skill index = %q", got)
	}
}

func TestPodOperationsAPI_SkillReloadWarnsAndContinuesWhenPublicAssetStagingFails(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPublicSkillDir(t, e.skillsDir, "good-skill")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "good-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "good-skill"), ManifestHash: "sha256:good",
		PlatformsJSON: `[]`,
	})
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "bad-skill", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "missing-bad-skill"), ManifestHash: "sha256:bad",
		PlatformsJSON: `[]`,
	})
	markPodSkillsPending(t, e.store, "pod-a")
	e.reconcile.podIDs = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results  map[string]string `json:"results"`
		Warnings []string          `json:"warnings"`
	}](t, rr.Body.Bytes())
	if data.Results["pod-a"] != "queued" {
		t.Fatalf("result[pod-a] = %q, want queued", data.Results["pod-a"])
	}
	if len(data.Warnings) != 1 || !strings.Contains(data.Warnings[0], "bad-skill") {
		t.Fatalf("warnings = %v", data.Warnings)
	}
	if got := strings.Join(e.drv.syncPublicSkillCalls[0].sourceSkillNames, ","); got != "good-skill" {
		t.Fatalf("published public Skills = %q, want good-skill", got)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodOperationsAPI_SkillReloadSyncsPublicFilesOnceForMultiplePods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	createPublicSkillDir(t, e.skillsDir, "shared-public")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "shared-public", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath: filepath.Join(e.skillsDir, "shared-public"), ManifestHash: "sha256:shared",
		PlatformsJSON: `[]`,
	})
	markPodSkillsPending(t, e.store, "pod-a")
	markPodSkillsPending(t, e.store, "pod-b")

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{}`)
	assertStatus(t, rr, http.StatusOK)
	if len(e.drv.syncPublicSkillCalls) != 1 {
		t.Fatalf("public Skill files should sync once, got %+v", e.drv.syncPublicSkillCalls)
	}
	if strings.Join(e.drv.publicSkillMountCalls, ",") != "pod-a,pod-b" {
		t.Fatalf("public Skill mounts = %v, want pod-a,pod-b", e.drv.publicSkillMountCalls)
	}
}

func TestPodOperationsAPI_SkillReloadUsesPerPodDeadlines(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	markPodSkillsPending(t, e.store, "pod-a")
	markPodSkillsPending(t, e.store, "pod-b")
	e.reconcile.runDeadlines = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a","pod-b"]}`)
	assertStatus(t, rr, http.StatusOK)
	if len(e.reconcile.runDeadlines) != 2 {
		t.Fatalf("run deadlines = %v, want one per pod", e.reconcile.runDeadlines)
	}
	for _, duration := range e.reconcile.runDeadlines {
		if duration <= 0 || duration > 70*time.Second {
			t.Fatalf("pod sync deadline = %s, want fresh per-pod deadline near 60s", duration)
		}
	}
}

func TestPodOperationsAPI_SkillReloadStopsBeforeApplyWhenPublicSkillSyncFails(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	createPublicSkillDir(t, e.skillsDir, "public-sync-failure")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "public-sync-failure", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath:   filepath.Join(e.skillsDir, "public-sync-failure"),
		ManifestHash: "sha256:public-sync-failure", PlatformsJSON: `["xdr"]`,
	})
	markPodSkillsPending(t, e.store, "pod-a")
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

func TestPodOperationsAPI_SkillReloadInstallsActivePrivateSkills(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script", "platform": "xdr"},
	))
	assertStatus(t, rr, http.StatusCreated)
	e.drv.execStdinCalls = nil
	e.reconcile.podIDs = nil

	rr = e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	if data.Results["pod-a"] != "queued" {
		t.Fatalf("result[pod-a] = %q", data.Results["pod-a"])
	}
	if len(e.drv.execStdinCalls) != 2 {
		t.Fatalf("private Skill install calls = %+v", e.drv.execStdinCalls)
	}
	call := e.drv.execStdinCalls[1]
	if call.userID != "pod-a" ||
		!strings.Contains(strings.Join(call.cmd, " "), "private-skill-installer.mjs install") ||
		!strings.Contains(strings.Join(call.cmd, " "), "--expected-name xdr-private") ||
		!strings.Contains(strings.Join(call.cmd, " "), "--state-dir /home/node/.openclaw") {
		t.Fatalf("private Skill install call = %+v", call)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodOperationsAPI_SkillReloadSkipsUnchangedPrivateSkill(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createPrivateSkillAsset(t, e, alice, "stable-private", repo.SkillStatusActive)
	e.drv.privateSkillHashes["alice"] = map[string]string{"stable-private": "sha256:stable-private"}
	markPodSkillsPending(t, e.store, "pod-a")
	e.drv.execStdinCalls = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)

	for _, call := range e.drv.execStdinCalls {
		if strings.Contains(strings.Join(call.cmd, " "), "private-skill-installer.mjs install") {
			t.Fatalf("unchanged private Skill should not reinstall: %+v", e.drv.execStdinCalls)
		}
	}
	if len(e.drv.execStdinCalls) != 1 ||
		!strings.Contains(strings.Join(e.drv.execStdinCalls[0].cmd, " "), "private-skill-installer.mjs list") {
		t.Fatalf("private Skill sync should only list installed hashes: %+v", e.drv.execStdinCalls)
	}
}

func TestPodOperationsAPI_SkillReloadDeletesSameNamePrivateSkillPerUser(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, e.store, "pod-a", "bob", repo.HumanUserStatusActive)
	createPrivateSkillAsset(t, e, alice, "shared-private", repo.SkillStatusActive)
	createPrivateSkillAsset(t, e, bob, "shared-private", repo.SkillStatusDeleted)
	markPodSkillsPending(t, e.store, "pod-a")
	e.drv.execStdinCalls = nil

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
	assertStatus(t, rr, http.StatusOK)

	installCount, deleteCount := 0, 0
	for _, call := range e.drv.execStdinCalls {
		joined := strings.Join(call.cmd, " ")
		if strings.Contains(joined, "private-skill-installer.mjs install") {
			installCount++
		}
		if strings.Contains(joined, "private-skill-installer.mjs delete") {
			deleteCount++
			if !strings.Contains(joined, "--agent-id bob") ||
				!strings.Contains(joined, "--skill-name shared-private") {
				t.Fatalf("unexpected delete call = %+v", call)
			}
		}
	}
	if installCount != 1 || deleteCount != 1 {
		t.Fatalf("private Skill sync calls install=%d delete=%d all=%+v",
			installCount, deleteCount, e.drv.execStdinCalls)
	}
}

func TestPodOperationsAPI_SkillReloadStopsBeforeApplyWhenPrivateSkillSyncFails(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	rr := e.privateSkillUpload(alice.HumanUserID, "xdr-private", makeSkillBundle(
		t, "xdr-private", map[string]any{"name": "xdr-private", "runtime": "script", "platform": "xdr"},
	))
	assertStatus(t, rr, http.StatusCreated)
	e.drv.execStdinCalls = nil
	e.reconcile.podIDs = nil
	e.drv.execStdinErr = errors.New("installer unavailable")

	rr = e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-a"]}`)
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
	if strings.Contains(rr.Body.String(), "installer unavailable") {
		t.Fatal("Skill reload response exposed private sync error details")
	}
}

func TestPodOperationsAPI_UpgradeAppliesTargetGeneration(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestPlatform(t, e.store, "xdr", "XDR")
	createPublicSkillDir(t, e.skillsDir, "upgrade-public")
	createSkillAsset(t, e.store, repo.SkillAsset{
		Name: "upgrade-public", Scope: repo.SkillScopePublic, Status: repo.SkillStatusActive,
		SourcePath:   filepath.Join(e.skillsDir, "upgrade-public"),
		ManifestHash: "sha256:upgrade-public", PlatformsJSON: `["xdr"]`,
	})
	alice := createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createPrivateSkillAsset(t, e, alice, "upgrade-private", repo.SkillStatusActive)
	markPodSkillsPending(t, e.store, "pod-a")
	e.drv.execStdinCalls = nil
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:v2"}`)
	assertStatus(t, rr, http.StatusOK)
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if pod.ImageTag != "img:v2" || pod.AppliedGeneration != pod.ConfigGeneration ||
		pod.State != repo.PodStateRunning || pod.SkillsPending {
		t.Fatalf("unexpected upgraded Pod: %+v", pod)
	}
	if e.drv.created["pod-a"].ImageTag != "img:v2" || len(e.drv.replaced) == 0 || e.drv.removed["pod-a"] {
		t.Fatalf("upgrade must replace runtime in place, not remove+create: created=%+v replaced=%d removed=%v",
			e.drv.created["pod-a"], len(e.drv.replaced), e.drv.removed["pod-a"])
	}
	if len(e.drv.syncPublicSkillCalls) == 0 {
		t.Fatal("upgrade should sync public Skills before applying runtime generation")
	}
	if len(e.drv.execStdinCalls) != 2 ||
		!strings.Contains(strings.Join(e.drv.execStdinCalls[1].cmd, " "), "--expected-name upgrade-private") {
		t.Fatalf("upgrade should sync private Skills before applying runtime generation: %+v", e.drv.execStdinCalls)
	}
}

func TestPodOperationsAPI_UpgradeFailureRestoresOldImage(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.drv.replaceErrors = []error{errors.New("simulated replace failure"), nil}
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
	// 回滚必须走 ReplaceRuntime 原地重建（失败的升级已消耗一次调用，这里记录到
	// 成功的那次），且 workload 绝不能经过 Remove（Remove→Create 竞态已废除）。
	if len(e.drv.replaced) == 0 || e.drv.removed["pod-a"] {
		t.Fatalf("rollback must replace runtime in place: replaced=%d removed=%v", len(e.drv.replaced), e.drv.removed["pod-a"])
	}
	assertErrorHidesDiagnostic(t, rr.Body.String(), "simulated replace failure")
}

func TestPodOperationsAPI_UpgradeRollbackFailureReports50215(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	// 升级失败后回滚也失败（两次 ReplaceRuntime 都失败）：不得谎报"已自动回滚"，
	// 必须上报 50215 且 Pod 进入 Error 状态。
	e.drv.replaceErrors = []error{errors.New("upgrade failed"), errors.New("rollback failed")}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:bad"}`)
	assertStatus(t, rr, http.StatusBadGateway)
	if !strings.Contains(rr.Body.String(), `"code":50215`) {
		t.Fatalf("rollback failure response = %s, want code 50215", rr.Body.String())
	}
	assertErrorHidesDiagnostic(t, rr.Body.String(), "rollback failed")
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if pod.State != repo.PodStateError {
		t.Fatalf("pod state = %s, want error after failed rollback", pod.State)
	}
}

func TestPodOperationsAPI_RestartRebuildsMissingWorkload(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	// Deployment 缺失（坏镜像升级清掉 workload 后回滚失败）：Restart 返回
	// ErrWorkloadMissing → 应 fallback 用 DB spec 重建。
	e.drv.restartErrors["pod-a"] = driver.ErrWorkloadMissing
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/restart", "")
	assertStatus(t, rr, http.StatusOK)
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if pod.State != repo.PodStateRunning {
		t.Fatalf("pod state = %s, want running", pod.State)
	}
	if e.drv.restarted["pod-a"] != 1 {
		t.Fatalf("Restart should be attempted once, got %d", e.drv.restarted["pod-a"])
	}
	// rebuild 的 Create 会带 AdoptState=true，用于证明重建确实发生（初始创建不带）。
	if !e.drv.created["pod-a"].AdoptState {
		t.Fatalf("restart did not rebuild workload with AdoptState: %+v", e.drv.created["pod-a"])
	}
}

func assertStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("status = %d, want %d", response.Code, want)
	}
}

// assertErrorHidesDiagnostic 断言错误响应把原始运行时错误放在 detail（用户可折叠
// 查看）而非 user-facing message，避免技术串直接展示。
func assertErrorHidesDiagnostic(t *testing.T, body, diagnostic string) {
	t.Helper()
	var envelope struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatalf("invalid error envelope %q: %v", body, err)
	}
	if strings.Contains(envelope.Message, diagnostic) {
		t.Fatalf("runtime error %q leaked into message %q", diagnostic, envelope.Message)
	}
	if !strings.Contains(envelope.Detail, diagnostic) {
		t.Fatalf("runtime error %q missing from detail %q", diagnostic, envelope.Detail)
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

func markPodSkillsPending(t *testing.T, store *repo.Store, podID string) {
	t.Helper()
	if _, err := store.MarkPodSkillsPending(podID); err != nil {
		t.Fatalf("MarkPodSkillsPending %s: %v", podID, err)
	}
}

func createPrivateSkillAsset(
	t *testing.T, e *testEnv, user repo.HumanUser, name, status string,
) repo.SkillAsset {
	t.Helper()
	root := filepath.Join(e.skillsDir, "_private", user.HumanUserID, name)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("mkdir private Skill %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("# "+name+"\n"), 0o600); err != nil {
		t.Fatalf("write private Skill %s: %v", name, err)
	}
	return createSkillAsset(t, e.store, repo.SkillAsset{
		Name: name, Scope: repo.SkillScopePrivate, HumanUserID: user.HumanUserID,
		Status: status, SourcePath: root, ManifestHash: "sha256:" + name,
		PlatformsJSON: `["xdr"]`,
	})
}

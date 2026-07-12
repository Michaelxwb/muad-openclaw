package test

import (
	"errors"
	"net/http"
	"net/http/httptest"
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
	e.drv.restartErrors["pod-b"] = errors.New("simulated restart failure")
	body := `{"podIds":["pod-a","pod-b","pod-missing"]}`
	rr := e.do(http.MethodPost, "/api/v1/skills/reload", body)
	assertStatus(t, rr, http.StatusOK)
	data := decodeAPIData[struct {
		Results map[string]string `json:"results"`
	}](t, rr.Body.Bytes())
	want := map[string]string{"pod-a": "reloaded", "pod-b": "failed", "pod-missing": "not_found"}
	for podID, status := range want {
		if data.Results[podID] != status {
			t.Errorf("result[%s] = %q, want %q", podID, data.Results[podID], status)
		}
	}
	if strings.Contains(rr.Body.String(), "simulated restart failure") {
		t.Fatal("reload response exposed a runtime error")
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

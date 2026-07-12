package test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
)

func TestLifecycleActions(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-actions")
	cases := []struct{ action, wantState string }{
		{"stop", "stopped"}, {"start", "running"}, {"restart", "running"},
	}
	for _, tc := range cases {
		if rr := e.do(http.MethodPost, "/api/v1/containers/pod-actions/actions/"+tc.action, ""); rr.Code != http.StatusOK {
			t.Fatalf("action %s = %d: %s", tc.action, rr.Code, rr.Body.String())
		}
		pod, err := e.store.GetPod("pod-actions")
		if err != nil || pod.State != tc.wantState {
			t.Errorf("after %s state = %q, want %q (error=%v)", tc.action, pod.State, tc.wantState, err)
		}
	}
	if rr := e.do(http.MethodPost, "/api/v1/containers/pod-actions/actions/bogus", ""); rr.Code != http.StatusBadRequest {
		t.Errorf("unknown action = %d, want 400", rr.Code)
	}
	if rr := e.do(http.MethodPost, "/api/v1/containers/ghost/actions/start", ""); rr.Code != http.StatusNotFound {
		t.Errorf("missing Pod = %d, want 404", rr.Code)
	}
}

func TestSkillsReload_RollingRestart(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-alice")
	createWeChatPod(t, e, "pod-bob")

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":["pod-alice"]}`)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "reloaded") {
		t.Fatalf("reload = %d: %s", rr.Code, rr.Body.String())
	}
	if e.drv.restarted["pod-alice"] != 1 {
		t.Errorf("expected pod-alice restarted once: %+v", e.drv.restarted)
	}
	if e.drv.restarted["pod-bob"] != 0 {
		t.Errorf("pod-bob should not restart when not selected: %+v", e.drv.restarted)
	}
	if rr := e.do(http.MethodPost, "/api/v1/skills/reload", `{"podIds":[]}`); rr.Code != http.StatusBadRequest {
		t.Errorf("empty podIds = %d, want 400", rr.Code)
	}
}

func TestApplyLLMQueuesPodReconcile(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-llm")
	e.reconcile.podIDs = nil
	rr := e.do(http.MethodPost, "/api/v1/llm/apply", `{"podIds":["pod-llm","ghost"]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("apply = %d: %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"pod-llm":"queued"`) || !strings.Contains(body, `"ghost":"not_found"`) {
		t.Errorf("apply results unexpected: %s", body)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-llm" {
		t.Fatalf("LLM reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestApplyLLMRejectsLegacyUserIDs(t *testing.T) {
	e := newTestEnv(t)
	rr := e.do(http.MethodPost, "/api/v1/llm/apply", `{"userIds":["alice"]}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("legacy userIds status = %d, want 400", rr.Code)
	}
}

func TestUpgrade_ChangesImageTag(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-upgrade")

	if rr := e.do(http.MethodPost, "/api/v1/containers/pod-upgrade/upgrade", `{}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("empty imageTag = %d, want 400", rr.Code)
	}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-upgrade/upgrade", `{"imageTag":"img:v2"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("upgrade = %d: %s", rr.Code, rr.Body.String())
	}
	pod, err := e.store.GetPod("pod-upgrade")
	if err != nil || pod.ImageTag != "img:v2" {
		t.Errorf("imageTag = %q, want img:v2 (error=%v)", pod.ImageTag, err)
	}
	if e.drv.created["pod-upgrade"].ImageTag != "img:v2" {
		t.Errorf("recreated with tag %q, want img:v2", e.drv.created["pod-upgrade"].ImageTag)
	}
}

func TestAuditQuery(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-audit-query")

	rr := e.do(http.MethodGet, "/api/v1/audit?actor=root", "")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "pod-audit-query") {
		t.Fatalf("audit query = %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAlerts(t *testing.T) {
	e := newTestEnv(t)
	createWeChatPod(t, e, "pod-alerts")
	if rr := e.do(http.MethodPut, "/api/v1/settings/resources", `{"memLimit":"1g"}`); rr.Code != http.StatusOK {
		t.Fatalf("configure alert resource limit = %d: %s", rr.Code, rr.Body.String())
	}

	e.cache.Replace(map[string]monitor.Snapshot{
		"pod-alerts": {
			Healthy: true, ChannelConnected: false, MemMiB: 2000,
			MemAlertThresholdMiB: 870, Updated: time.Now(),
		},
	})
	rr := e.do(http.MethodGet, "/api/v1/alerts", "")
	body := rr.Body.String()
	if !strings.Contains(body, "channel_disconnected") || !strings.Contains(body, "high_mem") {
		t.Fatalf("expected channel+mem alerts: %s", body)
	}
}

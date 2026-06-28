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
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)

	cases := map[string]string{"stop": "stopped", "start": "running", "restart": "running", "reap": "archived", "revive": "running"}
	for action, wantState := range cases {
		if rr := e.do(http.MethodPost, "/api/v1/containers/alice/actions/"+action, ""); rr.Code != http.StatusOK {
			t.Fatalf("action %s = %d: %s", action, rr.Code, rr.Body.String())
		}
		u, _ := e.store.GetUser("alice")
		if u.State != wantState {
			t.Errorf("after %s state = %q, want %q", action, u.State, wantState)
		}
	}

	if rr := e.do(http.MethodPost, "/api/v1/containers/alice/actions/bogus", ""); rr.Code != http.StatusBadRequest {
		t.Errorf("unknown action = %d, want 400", rr.Code)
	}
	if rr := e.do(http.MethodPost, "/api/v1/containers/ghost/actions/start", ""); rr.Code != http.StatusNotFound {
		t.Errorf("missing user = %d, want 404", rr.Code)
	}
}

func TestSkillsReload_RollingRestart(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"bob","botId":"b","secret":"s"}`)

	rr := e.do(http.MethodPost, "/api/v1/skills/reload", "")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "reloaded") {
		t.Fatalf("reload = %d: %s", rr.Code, rr.Body.String())
	}
	if e.drv.restarted["alice"] != 1 || e.drv.restarted["bob"] != 1 {
		t.Errorf("expected each running container restarted once: %+v", e.drv.restarted)
	}
}

func TestApplyLLM_Recreates(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)

	rr := e.do(http.MethodPost, "/api/v1/llm/apply", `{"userIds":["alice","ghost"]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("apply = %d: %s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, "applied") || !strings.Contains(body, "not found") {
		t.Errorf("apply results unexpected: %s", body)
	}
	// alice was removed (keepState) then recreated.
	if _, ok := e.drv.created["alice"]; !ok {
		t.Error("alice not recreated")
	}
}

func TestUpgrade_ChangesImageTag(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)

	if rr := e.do(http.MethodPost, "/api/v1/containers/alice/upgrade", `{}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("empty imageTag = %d, want 400", rr.Code)
	}
	rr := e.do(http.MethodPost, "/api/v1/containers/alice/upgrade", `{"imageTag":"img:v2"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("upgrade = %d: %s", rr.Code, rr.Body.String())
	}
	u, _ := e.store.GetUser("alice")
	if u.ImageTag != "img:v2" {
		t.Errorf("imageTag = %q, want img:v2", u.ImageTag)
	}
	if e.drv.created["alice"].ImageTag != "img:v2" {
		t.Errorf("recreated with tag %q, want img:v2", e.drv.created["alice"].ImageTag)
	}
}

func TestAuditQuery(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)

	rr := e.do(http.MethodGet, "/api/v1/audit?actor=root", "")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "/api/v1/containers") {
		t.Fatalf("audit query = %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAlerts(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","botId":"b","secret":"s"}`)

	// healthy but channel offline + high mem
	e.cache.Replace(map[string]monitor.Snapshot{
		"alice": {Healthy: true, ChannelConnected: false, MemMiB: 2000, Updated: time.Now()},
	})
	rr := e.do(http.MethodGet, "/api/v1/alerts", "")
	body := rr.Body.String()
	if !strings.Contains(body, "channel_disconnected") || !strings.Contains(body, "high_mem") {
		t.Fatalf("expected channel+mem alerts: %s", body)
	}
}

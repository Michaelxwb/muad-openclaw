package test

import (
	"net/http"
	"strings"
	"testing"
)

func TestResources_DefaultsWhenUnset(t *testing.T) {
	e := newTestEnv(t)
	rr := e.do(http.MethodGet, "/api/v1/settings/resources", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("get = %d: %s", rr.Code, rr.Body.String())
	}
	for _, want := range []string{`"configured":false`, `"memLimit":"2g"`, `"cpuLimit":"1.5"`, `"restartPolicy":"unless-stopped"`} {
		if !strings.Contains(rr.Body.String(), want) {
			t.Errorf("missing %s in %s", want, rr.Body.String())
		}
	}
}

func TestResources_SetAndGet(t *testing.T) {
	e := newTestEnv(t)
	if rr := e.do(http.MethodPut, "/api/v1/settings/resources",
		`{"memLimit":"3g","cpuLimit":"2","restartPolicy":"always"}`); rr.Code != http.StatusOK {
		t.Fatalf("set = %d: %s", rr.Code, rr.Body.String())
	}
	rr := e.do(http.MethodGet, "/api/v1/settings/resources", "")
	for _, want := range []string{`"configured":true`, `"memLimit":"3g"`, `"cpuLimit":"2"`, `"restartPolicy":"always"`} {
		if !strings.Contains(rr.Body.String(), want) {
			t.Errorf("missing %s in %s", want, rr.Body.String())
		}
	}
}

func TestResources_Validation(t *testing.T) {
	e := newTestEnv(t)
	for _, bad := range []string{`{"memLimit":"2gb"}`, `{"cpuLimit":"abc"}`, `{"restartPolicy":"sometimes"}`} {
		if rr := e.do(http.MethodPut, "/api/v1/settings/resources", bad); rr.Code != http.StatusBadRequest {
			t.Errorf("bad body %s = %d, want 400", bad, rr.Code)
		}
	}
}

func TestResources_CreateUsesDefaultsWhenUnset(t *testing.T) {
	e := newTestEnv(t)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","channels":["wechat"],"channelConfigs":{}}`)
	got := e.drv.created["alice"]
	if got.MemLimit != "2g" || got.CPULimit != "1.5" || got.RestartPolicy != "unless-stopped" {
		t.Errorf("create should use built-in defaults, got %+v", got)
	}
}

func TestResources_PerUserOverrideAppliedOnRecreate(t *testing.T) {
	e := newTestEnv(t)
	e.configureGlobalLLM(t, stubLLM(t))
	e.do(http.MethodPut, "/api/v1/settings/resources",
		`{"memLimit":"2g","cpuLimit":"1.5","restartPolicy":"unless-stopped"}`)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"alice","channels":["wechat"],"channelConfigs":{}}`)
	e.do(http.MethodPost, "/api/v1/containers", `{"userId":"bob","channels":["wechat"],"channelConfigs":{}}`)

	if rr := e.do(http.MethodPut, "/api/v1/containers/alice/resources",
		`{"memLimit":"4g","cpuLimit":"3","restartPolicy":"always"}`); rr.Code != http.StatusOK {
		t.Fatalf("set user resources = %d: %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(http.MethodPost, "/api/v1/llm/apply", `{"userIds":["alice","bob"]}`); rr.Code != http.StatusOK {
		t.Fatalf("apply = %d: %s", rr.Code, rr.Body.String())
	}

	if got := e.drv.created["alice"]; got.MemLimit != "4g" || got.CPULimit != "3" || got.RestartPolicy != "always" {
		t.Errorf("alice per-user override not applied: %+v", got)
	}
	if got := e.drv.created["bob"]; got.MemLimit != "2g" || got.CPULimit != "1.5" || got.RestartPolicy != "unless-stopped" {
		t.Errorf("bob should inherit global, got %+v", got)
	}
}

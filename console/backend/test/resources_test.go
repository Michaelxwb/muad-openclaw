package test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestResources_GlobalDefaultsSetAndGet(t *testing.T) {
	env := newTestEnv(t)
	response := env.do(http.MethodGet, "/api/v1/settings/resources", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"configured":false`, `"memLimit":"3g"`, `"cpuLimit":"2"`,
		`"maxSkillConcurrency":1`, `"maxLongTaskConcurrency":2`)

	response = env.do(http.MethodPut, "/api/v1/settings/resources",
		`{"memLimit":"3g","cpuLimit":"2","restartPolicy":"always","maxLongTaskConcurrency":3}`)
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK, `"configured":true`)
	response = env.do(http.MethodGet, "/api/v1/settings/resources", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"memLimit":"3g"`, `"cpuLimit":"2"`, `"restartPolicy":"always"`,
		`"maxLongTaskConcurrency":3`)
}

func TestResources_PodOverridesEffectiveValuesAndReconcileReason(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	if response := env.do(http.MethodPut, "/api/v1/settings/resources",
		`{"memLimit":"3g","cpuLimit":"2","restartPolicy":"always"}`); response.Code != http.StatusOK {
		t.Fatalf("set global = %d: %s", response.Code, response.Body.String())
	}
	env.reconcile.podIDs = nil

	response := env.do(http.MethodGet, "/api/v1/containers/pod-a/resources", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"globalDefaults":{"memLimit":"3g"`, `"effective":{"memLimit":"3g"`,
		`"maxBrowserConcurrency":1`, `"maxLongTaskConcurrency":2`, `"memoryAlertThresholdMiB":2611`)

	response = env.do(http.MethodPut, "/api/v1/containers/pod-a/resources",
		`{"maxSkillConcurrency":4,"maxBrowserConcurrency":2,"maxLongTaskConcurrency":5}`)
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"requiresPodRestart":false`, `"runtimeConfigChanged":true`,
		`"maxSkillConcurrency":4`, `"maxBrowserConcurrency":2`, `"maxLongTaskConcurrency":5`)
	assertQueuedPods(t, env, "pod-a")

	env.reconcile.podIDs = nil
	response = env.do(http.MethodPut, "/api/v1/containers/pod-a/resources", `{"memLimit":"4g"}`)
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"requiresPodRestart":true`, `"runtimeConfigChanged":false`, `"memLimit":"4g"`)
	assertQueuedPods(t, env, "pod-a")

	stored, err := env.store.GetPod("pod-a")
	if err != nil || stored.MemLimit != "4g" || stored.MaxSkillConcurrency != 4 ||
		stored.MaxLongTaskConcurrency != 5 || stored.LastApplyStatus != repo.ApplyStatusPending {
		t.Fatalf("stored Pod resources = %+v, %v", stored, err)
	}
}

func TestResources_GlobalChangeQueuesOnlyInheritingPods(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	createTestPod(t, env.store, "pod-b", 10)
	if _, err := env.store.UpdatePodResources("pod-a", repo.PodResourceUpdate{MemLimit: "4g"}); err != nil {
		t.Fatalf("set Pod override: %v", err)
	}
	env.reconcile.podIDs = nil

	response := env.do(http.MethodPut, "/api/v1/settings/resources", `{"memLimit":"3g"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("set global = %d: %s", response.Code, response.Body.String())
	}
	assertQueuedPods(t, env, "pod-b")
}

func TestResources_AcceptsBareMemLimitAsGiB(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)

	// Pod 覆盖：只填数字按 GiB 解释并归一化为 "Ng"
	response := env.do(http.MethodPut, "/api/v1/containers/pod-a/resources", `{"memLimit":"4"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("bare Pod memLimit = %d: %s", response.Code, response.Body.String())
	}
	stored, err := env.store.GetPod("pod-a")
	if err != nil || stored.MemLimit != "4g" {
		t.Fatalf("stored Pod MemLimit = %q, %v", stored.MemLimit, err)
	}

	// 全局：只填数字同样归一化
	response = env.do(http.MethodPut, "/api/v1/settings/resources", `{"memLimit":"6"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("bare global memLimit = %d: %s", response.Code, response.Body.String())
	}
	response = env.do(http.MethodGet, "/api/v1/settings/resources", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK, `"memLimit":"6g"`)

	// 新建 Pod：create 的 memLimit 只填数字
	response = env.do(http.MethodPost, "/api/v1/containers",
		`{"podId":"pod-b","displayName":"b","imageTag":"img:1","maxUsers":2,"channels":["wechat"],"memLimit":"8"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create with bare memLimit = %d: %s", response.Code, response.Body.String())
	}
	created, err := env.store.GetPod("pod-b")
	if err != nil || created.MemLimit != "8g" {
		t.Fatalf("created Pod MemLimit = %q, %v", created.MemLimit, err)
	}
}

func TestResources_RejectsInvalidLimitsAndConcurrency(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	badBodies := []string{
		`{"memLimit":"2gb"}`, `{"memLimit":"0g"}`, `{"cpuLimit":"0"}`,
		`{"restartPolicy":"sometimes"}`, `{"maxSkillConcurrency":-1}`,
		`{"maxBrowserConcurrency":1001}`, `{"maxLongTaskConcurrency":1001}`, `{"unknown":true}`,
	}
	for _, body := range badBodies {
		response := env.do(http.MethodPut, "/api/v1/containers/pod-a/resources", body)
		if response.Code != http.StatusBadRequest {
			t.Errorf("body %s = %d, want 400: %s", body, response.Code, response.Body.String())
		}
	}
}

func TestResources_InvalidInputIncludesFieldDetail(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)

	response := env.do(http.MethodPut, "/api/v1/settings/resources", `{"cpuLimit":"0"}`)
	assertAPIError(t, response, errcode.InvalidResourceLimits, "cpuLimit")

	response = env.do(http.MethodPut, "/api/v1/containers/pod-a/resources",
		`{"maxBrowserConcurrency":1001}`)
	assertAPIError(t, response, errcode.InvalidResourceLimits, "maxBrowserConcurrency")
}

func TestAlerts_UsePodEffectiveMemoryThreshold(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	if err := env.store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("mark running: %v", err)
	}
	env.cache.Replace(map[string]monitor.Snapshot{
		"pod-a": {
			PodID: "pod-a", Healthy: true, ChannelConnected: true,
			MemMiB: 900, EffectiveMemLimit: "1g", MemAlertThresholdMiB: 870,
		},
	})
	response := env.do(http.MethodGet, "/api/v1/alerts", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"podId":"pod-a"`, `"kind":"high_mem"`, `effective Pod limit`)
	if strings.Contains(response.Body.String(), "2GiB") {
		t.Fatalf("alert retained hard-coded single-user limit: %s", response.Body.String())
	}
}

func assertBodyContains(t *testing.T, status int, body string, wantStatus int, fragments ...string) {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("status = %d, want %d: %s", status, wantStatus, body)
	}
	for _, fragment := range fragments {
		if !strings.Contains(body, fragment) {
			t.Errorf("response missing %s: %s", fragment, body)
		}
	}
}

func assertQueuedPods(t *testing.T, env *testEnv, expected ...string) {
	t.Helper()
	if strings.Join(env.reconcile.podIDs, ",") != strings.Join(expected, ",") {
		t.Fatalf("queued Pods = %v, want %v", env.reconcile.podIDs, expected)
	}
}

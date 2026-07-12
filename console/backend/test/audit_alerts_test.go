package test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestAuditQueryFiltersTypedMetadataAndRedactsLegacyPayload(t *testing.T) {
	env := newTestEnv(t)
	recordAuditEvent(t, env, auditlog.Event{
		Actor: "root", Action: auditlog.ActionIdentityCreate, Target: "identity-a",
		Metadata: auditlog.Metadata{PodID: "pod-a", HumanUserID: "user-a", IdentityID: "identity-a"},
	})
	recordAuditEvent(t, env, auditlog.Event{
		Actor: "root", Action: auditlog.ActionIdentityCreate, Target: "identity-b",
		Metadata: auditlog.Metadata{PodID: "pod-b", HumanUserID: "user-b", IdentityID: "identity-b"},
	})
	if err := env.store.AddAudit(repo.AuditEntry{
		Actor: "root", Action: "legacy.update", Target: "legacy", Payload: `apiKey=sk-legacysecret`,
	}); err != nil {
		t.Fatalf("add legacy audit: %v", err)
	}

	response := env.do(http.MethodGet, "/api/v1/audit?action=identity.create&podId=pod-a&limit=1", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"total":1`, `"targetType":"identity"`, `"podId":"pod-a"`, `"identityId":"identity-a"`)

	response = env.do(http.MethodGet, "/api/v1/audit?actor=root&limit=2&offset=1", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK, `"total":3`)
	if strings.Contains(response.Body.String(), "sk-legacysecret") {
		t.Fatalf("audit response leaked legacy payload: %s", response.Body.String())
	}

	response = env.do(http.MethodGet, "/api/v1/audit?target=legacy", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK,
		`"payload":"[redacted]"`, `"targetType":"generic"`)
}

func TestAlertsExposeGenerationQueuesAndFailureThresholdsWithoutSecrets(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	if err := env.store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("mark Pod running: %v", err)
	}
	if err := env.store.StartPodConfigApply("pod-a", 1); err != nil {
		t.Fatalf("start apply: %v", err)
	}
	if err := env.store.FailPodConfigApply("pod-a", 1, "apiKey=sk-alertsecret validation failed"); err != nil {
		t.Fatalf("fail apply: %v", err)
	}
	env.cache.Replace(map[string]monitor.Snapshot{
		"pod-a": {
			PodID: "pod-a", Healthy: true, ChannelConnected: true,
			RuntimeGuardHealthy: false, SkillActive: 1, SkillQueued: 2,
			BrowserActive: 1, BrowserQueued: 1, MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1,
		},
	})
	recordRepeatedFailures(t, env, auditlog.ActionSessionResolveFail, 3)
	recordRepeatedFailures(t, env, auditlog.ActionBindingCodeFail, 5)
	recordRepeatedFailures(t, env, auditlog.ActionRuntimeGuardReject, 3)

	response := env.do(http.MethodGet, "/api/v1/alerts", "")
	body := response.Body.String()
	assertBodyContains(t, response.Code, body, http.StatusOK,
		`"kind":"config_apply_failed"`, `"kind":"generation_lag"`,
		`"kind":"skill_queue"`, `"kind":"browser_queue"`,
		`"kind":"resolver_failures"`, `"kind":"binding_failures"`,
		`"kind":"runtime_guard_rejections"`, `"kind":"runtime_guard_unhealthy"`)
	if strings.Contains(body, "sk-alertsecret") {
		t.Fatalf("alert response leaked apply secret: %s", body)
	}
}

func recordRepeatedFailures(t *testing.T, env *testEnv, action auditlog.Action, count int) {
	t.Helper()
	for range count {
		recordAuditEvent(t, env, auditlog.Event{
			Actor: auditlog.PodActor("pod-a"), Action: action, Target: "pod-a",
			Metadata: auditlog.Metadata{PodID: "pod-a", ErrorCode: "test_failure"},
		})
	}
}

func recordAuditEvent(t *testing.T, env *testEnv, event auditlog.Event) {
	t.Helper()
	if err := auditlog.Record(context.Background(), env.store, event); err != nil {
		t.Fatalf("record audit %s: %v", event.Action, err)
	}
}

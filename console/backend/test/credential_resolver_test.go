package test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const resolveBody = `{"agentId":"alice","skillName":"xdr-query","purpose":"session_get_state"}`

func TestCredentialResolver_ScopesActiveUserAndReturnsMinimalCredential(t *testing.T) {
	env := newTestEnv(t)
	tokenA := createPodWithToken(t, env, "pod-a")
	tokenB := createPodWithToken(t, env, "pod-b")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestHumanUser(t, env.store, "pod-a", "disabled", repo.HumanUserStatusDisabled)
	createTestHumanUser(t, env.store, "pod-a", "charlie", repo.HumanUserStatusActive)
	configureResolverPlatform(t, env, alice.HumanUserID, "xdr-secret-key")

	success := doInternalResolve(env, tokenA, resolveBody)
	if success.Code != http.StatusOK {
		t.Fatalf("resolve = %d: %s", success.Code, success.Body.String())
	}
	var response struct {
		Data struct {
			HumanUserID string                              `json:"humanUserId"`
			PodID       string                              `json:"podId"`
			AgentID     string                              `json:"agentId"`
			SkillName   string                              `json:"skillName"`
			Platforms   []resolvedPlatformCredentialFixture `json:"platforms"`
		} `json:"data"`
	}
	if err := json.Unmarshal(success.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode resolve response: %v", err)
	}
	if response.Data.HumanUserID != alice.HumanUserID || response.Data.PodID != "pod-a" ||
		response.Data.AgentID != "alice" || response.Data.SkillName != "xdr-query" ||
		len(response.Data.Platforms) != 1 {
		t.Fatalf("unexpected resolve response: %+v", response.Data)
	}
	platform := response.Data.Platforms[0]
	if platform.Platform != "xdr" || platform.Credentials["apiKey"] != "xdr-secret-key" ||
		platform.Credentials["baseUrl"] != "https://xdr.internal" {
		t.Fatalf("unexpected platform credential: %+v", platform)
	}
	if !strings.HasPrefix(platform.CredentialFingerprint, "sha256:") {
		t.Fatalf("missing fingerprint: %+v", platform)
	}

	assertResolveError(t, env, tokenB, resolveBody, http.StatusNotFound, 40901)
	assertResolveError(t, env, tokenA,
		`{"agentId":"disabled","skillName":"xdr-query","purpose":"session_get_state"}`,
		http.StatusNotFound, 40901)
	assertResolveError(t, env, tokenA,
		`{"agentId":"charlie","skillName":"xdr-query","purpose":"session_get_state"}`,
		http.StatusNotFound, 40606)

	if err := env.store.UpdatePlatformConfig("xdr", "XDR", false); err != nil {
		t.Fatalf("disable platform: %v", err)
	}
	assertResolveError(t, env, tokenA, resolveBody, http.StatusConflict, 40605)
	assertResolveAuditIsRedacted(t, env, "xdr-secret-key", tokenA)
}

func TestCredentialResolver_MultiPlatformSkillReturnsAllConfiguredCredentials(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestPlatform(t, env.store, "xdr", "XDR")
	createTestPlatform(t, env.store, "mssw", "MSSW")
	createSkillAsset(t, env.store, repo.SkillAsset{
		Name: "multi-report", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/multi-report", ManifestHash: "sha256:multi",
		PlatformsJSON: `["xdr","mssw"]`,
	})
	for platform, apiKey := range map[string]string{"xdr": "xdr-key", "mssw": "mssw-key"} {
		if _, err := env.store.UpsertUserPlatformCredential(alice.HumanUserID, platform, map[string]any{
			"apiKey": apiKey, "baseUrl": "https://" + platform + ".internal",
		}); err != nil {
			t.Fatalf("configure credential %s: %v", platform, err)
		}
	}

	response := doInternalResolve(env, token,
		`{"agentId":"alice","skillName":"multi-report","purpose":"session_get_state"}`)
	assertStatus(t, response, http.StatusOK)
	var payload struct {
		Data struct {
			Platforms []resolvedPlatformCredentialFixture `json:"platforms"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Data.Platforms) != 2 {
		t.Fatalf("expected 2 platforms, got %d: %+v", len(payload.Data.Platforms), payload.Data.Platforms)
	}
	byKey := map[string]string{}
	for _, p := range payload.Data.Platforms {
		byKey[p.Platform] = p.Credentials["apiKey"].(string)
	}
	if byKey["xdr"] != "xdr-key" || byKey["mssw"] != "mssw-key" {
		t.Fatalf("unexpected multi-platform credentials: %+v", byKey)
	}
}

func TestCredentialResolver_MultiPlatformSkillFailsWhenAnyPlatformMissingCredential(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestPlatform(t, env.store, "xdr", "XDR")
	createTestPlatform(t, env.store, "mssw", "MSSW")
	createSkillAsset(t, env.store, repo.SkillAsset{
		Name: "multi-report", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/multi-report", ManifestHash: "sha256:multi",
		PlatformsJSON: `["xdr","mssw"]`,
	})
	if _, err := env.store.UpsertUserPlatformCredential(alice.HumanUserID, "xdr", map[string]any{
		"apiKey": "xdr-key", "baseUrl": "https://xdr.internal",
	}); err != nil {
		t.Fatalf("configure xdr credential: %v", err)
	}
	// mssw 凭证未配置，整个请求应该失败（Option A）
	assertResolveError(t, env, token,
		`{"agentId":"alice","skillName":"multi-report","purpose":"session_get_state"}`,
		http.StatusNotFound, 40606)
	assertResolveAuditPlatform(t, env, "mssw")
}

func TestCredentialResolver_DisabledSkillFailsWithInvalidSkill(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	skill := createSkillAsset(t, env.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:xdr-query",
		PlatformsJSON: `["xdr"]`,
	})
	if err := env.store.UpdateSkillAssetStatus(skill.SkillID, repo.SkillStatusDisabled); err != nil {
		t.Fatalf("disable skill: %v", err)
	}
	assertResolveError(t, env, token, resolveBody, http.StatusBadRequest, 40527)
}

func TestCredentialResolver_PlatformlessSkillHasNoSessionCredential(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillAsset(t, env.store, repo.SkillAsset{
		Name: "web-tools-guide", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/web-tools-guide", ManifestHash: "sha256:web",
		PlatformsJSON: `[]`,
	})
	assertResolveError(t, env, token,
		`{"agentId":"alice","skillName":"web-tools-guide","purpose":"session_get_state"}`,
		http.StatusBadRequest, 40514)
}

func TestServiceTokenRotation_InvalidatesOldTokenAndAuditsFingerprint(t *testing.T) {
	env := newTestEnv(t)
	oldToken := createPodWithToken(t, env, "pod-a")
	if err := env.store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("mark Pod running: %v", err)
	}
	env.drv.serviceTokens["pod-a"] = tokenSpecForTest(oldToken)

	response := env.do(http.MethodPost, "/api/v1/containers/pod-a/service-token/rotate", "")
	if response.Code != http.StatusOK {
		t.Fatalf("rotate = %d: %s", response.Code, response.Body.String())
	}
	newToken := env.drv.serviceTokens["pod-a"].Value
	if newToken == "" || newToken == oldToken || strings.Contains(response.Body.String(), newToken) {
		t.Fatalf("rotation response or secret is invalid: %s", response.Body.String())
	}
	assertResolveError(t, env, oldToken, resolveBody, http.StatusUnauthorized, 40103)
	assertResolveError(t, env, newToken, resolveBody, http.StatusNotFound, 40901)
	if env.drv.stopCalls != 1 || env.drv.startCalls != 1 {
		t.Fatalf("maintenance stop/start = %d/%d, want 1/1", env.drv.stopCalls, env.drv.startCalls)
	}
	entries, _, err := env.store.QueryAudit("root", timeZero(), timeZero(), 0, 0)
	if err != nil || !hasAuditAction(entries, "pod_service_token.rotate") {
		t.Fatalf("rotation audit = %+v, %v", entries, err)
	}
}

func TestServiceTokenRotation_StartFailureRestoresOldTokenAndSecret(t *testing.T) {
	env := newTestEnv(t)
	oldToken := createPodWithToken(t, env, "pod-a")
	if err := env.store.UpdatePodState("pod-a", repo.PodStateRunning); err != nil {
		t.Fatalf("mark Pod running: %v", err)
	}
	env.drv.serviceTokens["pod-a"] = tokenSpecForTest(oldToken)
	env.drv.startErrors = []error{errors.New("start failed"), nil}

	response := env.do(http.MethodPost, "/api/v1/containers/pod-a/service-token/rotate", "")
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), oldToken) {
		t.Fatalf("failed rotation = %d: %s", response.Code, response.Body.String())
	}
	if got := env.drv.serviceTokens["pod-a"].Value; got != oldToken {
		t.Fatalf("Driver token = %q, want restored old token", got)
	}
	assertResolveError(t, env, oldToken, resolveBody, http.StatusNotFound, 40901)
	if env.drv.startCalls != 2 || env.drv.stopCalls != 2 {
		t.Fatalf("rollback stop/start = %d/%d, want 2/2", env.drv.stopCalls, env.drv.startCalls)
	}
}

type resolvedPlatformCredentialFixture struct {
	Platform              string         `json:"platform"`
	CredentialFingerprint string         `json:"credentialFingerprint"`
	Credentials           map[string]any `json:"credentials"`
}

func configureResolverPlatform(t *testing.T, env *testEnv, humanUserID, apiKey string) {
	t.Helper()
	createTestPlatform(t, env.store, "xdr", "XDR")
	createSkillAsset(t, env.store, repo.SkillAsset{
		Name: "xdr-query", Scope: repo.SkillScopePublic,
		SourcePath: "/opt/openclaw-skills/xdr-query", ManifestHash: "sha256:xdr-query",
		PlatformsJSON: `["xdr"]`,
	})
	if _, err := env.store.UpsertUserPlatformCredential(humanUserID, "xdr", map[string]any{
		"apiKey": apiKey, "baseUrl": "https://xdr.internal", "sessionMode": "storage_state",
	}); err != nil {
		t.Fatalf("configure credential: %v", err)
	}
}

func doInternalResolve(env *testEnv, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/session-credentials/resolve", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	env.h.ServeHTTP(recorder, req)
	return recorder
}

func assertResolveError(
	t *testing.T, env *testEnv, token, body string, status, code int,
) {
	t.Helper()
	response := doInternalResolve(env, token, body)
	if response.Code != status {
		t.Fatalf("resolve status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Code != code {
		t.Fatalf("resolve code = %d, %v; want %d", envelope.Code, err, code)
	}
}

func assertResolveAuditPlatform(t *testing.T, env *testEnv, platform string) {
	t.Helper()
	entries, _, err := env.store.QueryAudit("pod:pod-a", timeZero(), timeZero(), 0, 0)
	if err != nil {
		t.Fatalf("resolve audit query = %v", err)
	}
	for _, entry := range entries {
		if entry.Action != "session_credential.resolve_fail" {
			continue
		}
		var payload struct {
			Platform string `json:"platform"`
		}
		if err := json.Unmarshal([]byte(entry.Payload), &payload); err != nil {
			t.Fatalf("resolve audit payload = %v", err)
		}
		if payload.Platform == platform {
			return
		}
	}
	t.Fatalf("resolve_fail audit did not record platform %q in %+v", platform, entries)
}

func assertResolveAuditIsRedacted(t *testing.T, env *testEnv, secrets ...string) {
	t.Helper()
	entries, _, err := env.store.QueryAudit("pod:pod-a", timeZero(), timeZero(), 0, 0)
	if err != nil || len(entries) == 0 {
		t.Fatalf("resolver audits = %+v, %v", entries, err)
	}
	encoded, _ := json.Marshal(entries)
	for _, secret := range secrets {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("resolver audit leaked secret %q: %s", secret, encoded)
		}
	}
}

func tokenSpecForTest(value string) driver.SecretFileSpec {
	return driver.SecretFileSpec{ContainerPath: driver.PodServiceTokenPath, Value: value, Mode: 0o400}
}

func timeZero() time.Time { return time.Time{} }

func hasAuditAction(entries []repo.AuditEntry, action string) bool {
	for _, entry := range entries {
		if entry.Action == action {
			return true
		}
	}
	return false
}

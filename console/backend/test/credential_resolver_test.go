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

const resolveBody = `{"agentId":"alice","platform":"xdr","purpose":"session_get_state"}`

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
			HumanUserID               string         `json:"humanUserId"`
			PodID                     string         `json:"podId"`
			AgentID                   string         `json:"agentId"`
			APIKey                    string         `json:"apiKey"`
			CredentialFingerprint     string         `json:"credentialFingerprint"`
			PlatformConfigFingerprint string         `json:"platformConfigFingerprint"`
			SessionMode               string         `json:"sessionMode"`
			Adapter                   string         `json:"adapter"`
			PlatformConfig            map[string]any `json:"platformConfig"`
		} `json:"data"`
	}
	if err := json.Unmarshal(success.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode resolve response: %v", err)
	}
	if response.Data.HumanUserID != alice.HumanUserID || response.Data.PodID != "pod-a" ||
		response.Data.AgentID != "alice" ||
		response.Data.APIKey != "xdr-secret-key" || response.Data.SessionMode != "storage_state" ||
		response.Data.Adapter != "xdr" || response.Data.PlatformConfig["baseUrl"] != "https://xdr.internal" {
		t.Fatalf("unexpected resolve response: %+v", response.Data)
	}
	if !strings.HasPrefix(response.Data.CredentialFingerprint, "sha256:") ||
		!strings.HasPrefix(response.Data.PlatformConfigFingerprint, "sha256:") {
		t.Fatalf("missing fingerprints: %+v", response.Data)
	}

	assertResolveError(t, env, tokenB, resolveBody, http.StatusNotFound, 40401)
	assertResolveError(t, env, tokenA,
		`{"agentId":"disabled","platform":"xdr","purpose":"session_get_state"}`,
		http.StatusNotFound, 40401)
	assertResolveError(t, env, tokenA,
		`{"agentId":"charlie","platform":"xdr","purpose":"session_get_state"}`,
		http.StatusNotFound, 40402)
	assertResolveError(t, env, tokenA,
		`{"agentId":"alice","platform":"xdr","purpose":"session_get_state","podId":"pod-b"}`,
		http.StatusBadRequest, 40001)

	if err := env.store.UpdatePlatformConfig("xdr", "XDR", "", false); err != nil {
		t.Fatalf("disable platform: %v", err)
	}
	assertResolveError(t, env, tokenA, resolveBody, http.StatusConflict, 40905)
	assertResolveAuditIsRedacted(t, env, "xdr-secret-key", tokenA)
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
	assertResolveError(t, env, oldToken, resolveBody, http.StatusUnauthorized, 40102)
	assertResolveError(t, env, newToken, resolveBody, http.StatusNotFound, 40401)
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
	assertResolveError(t, env, oldToken, resolveBody, http.StatusNotFound, 40401)
	if env.drv.startCalls != 2 || env.drv.stopCalls != 2 {
		t.Fatalf("rollback stop/start = %d/%d, want 2/2", env.drv.stopCalls, env.drv.startCalls)
	}
}

func configureResolverPlatform(t *testing.T, env *testEnv, humanUserID, apiKey string) {
	t.Helper()
	cipher := envCipher(t)
	config, err := cipher.Encrypt(`{"baseUrl":"https://xdr.internal","sessionMode":"storage_state"}`)
	if err != nil {
		t.Fatalf("encrypt platform config: %v", err)
	}
	if err := env.store.UpdatePlatformConfig("xdr", "XDR", config, true); err != nil {
		t.Fatalf("configure platform: %v", err)
	}
	if _, err := env.store.UpsertUserPlatformCredential(cipher, humanUserID, "xdr", apiKey); err != nil {
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

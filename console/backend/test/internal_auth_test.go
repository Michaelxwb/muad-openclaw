package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestInternalAuth_RequiresValidPodServiceToken(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")

	assertInternalStatus(t, env, "", http.StatusUnauthorized, 40102)
	assertInternalStatus(t, env, "wrong-token", http.StatusUnauthorized, 40102)
	assertInternalStatus(t, env, token, http.StatusBadRequest, 40001)
}

func TestInternalAuth_RotationImmediatelyInvalidatesOldToken(t *testing.T) {
	env := newTestEnv(t)
	oldToken := createPodWithToken(t, env, "pod-a")
	newToken, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken: %v", err)
	}
	newEncrypted, err := envCipher(t).Encrypt(newToken)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if err := env.store.RotatePodServiceToken(
		"pod-a", newEncrypted, crypto.Fingerprint(newToken), time.Now().UTC(),
	); err != nil {
		t.Fatalf("RotatePodServiceToken: %v", err)
	}

	assertInternalStatus(t, env, oldToken, http.StatusUnauthorized, 40102)
	assertInternalStatus(t, env, newToken, http.StatusBadRequest, 40001)
}

func createPodWithToken(t *testing.T, env *testEnv, podID string) string {
	t.Helper()
	token, err := crypto.GenerateServiceToken()
	if err != nil {
		t.Fatalf("GenerateServiceToken: %v", err)
	}
	encrypted, err := envCipher(t).Encrypt(token)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if err := env.store.CreatePod(repo.Pod{
		PodID: podID, DisplayName: podID, ServiceTokenEnc: encrypted,
		ServiceTokenFingerprint: crypto.Fingerprint(token),
	}); err != nil {
		t.Fatalf("CreatePod: %v", err)
	}
	return token
}

func envCipher(t *testing.T) *crypto.Cipher {
	t.Helper()
	cipher, err := crypto.New("mk")
	if err != nil {
		t.Fatalf("New cipher: %v", err)
	}
	return cipher
}

func assertInternalStatus(t *testing.T, env *testEnv, token string, wantStatus, wantCode int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/session-credentials/resolve", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	env.h.ServeHTTP(rr, req)
	if rr.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rr.Code, wantStatus, rr.Body.String())
	}
	var response struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != wantCode {
		t.Fatalf("code = %d, want %d", response.Code, wantCode)
	}
}

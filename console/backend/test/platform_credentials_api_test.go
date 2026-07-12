package test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type platformCredentialAPIView struct {
	HumanUserID    string `json:"humanUserId"`
	Platform       string `json:"platform"`
	KeyFingerprint string `json:"keyFingerprint"`
}

func TestPlatformCredentialAPI_ReplaceAndDeleteDoNotReconcilePod(t *testing.T) {
	e, user := createDirectHumanUser(t)
	podBefore, _ := e.store.GetPod("pod-a")
	e.reconcile.podIDs = nil
	first := putCredential(t, e, user.HumanUserID, "xdr", "xdr-key-one")
	second := putCredential(t, e, user.HumanUserID, "xdr", "xdr-key-two")
	if first.KeyFingerprint == second.KeyFingerprint {
		t.Fatal("credential replacement did not change fingerprint")
	}
	assertCredentialControlPlaneUnchanged(t, e, podBefore.ConfigGeneration)
	path := "/api/v1/human-users/" + user.HumanUserID + "/platform-credentials"
	rr := e.do(http.MethodGet, path, "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), "xdr-key-two") {
		t.Fatal("credential list exposed API key")
	}
	resolved, err := e.store.ResolveUserPlatformCredential(eCipher(t), user.HumanUserID, "xdr")
	if err != nil || resolved.APIKey != "xdr-key-two" {
		t.Fatalf("resolved replaced credential = %+v, %v", resolved, err)
	}
	rr = e.do(http.MethodDelete, path+"/xdr", "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"cacheInvalidation":"on_next_resolve"`) {
		t.Fatalf("delete response = %s", rr.Body.String())
	}
	assertCredentialControlPlaneUnchanged(t, e, podBefore.ConfigGeneration)
	for _, action := range []string{
		"platform_credential.create", "platform_credential.update", "platform_credential.delete",
	} {
		_, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{
			Action: action, HumanUserID: user.HumanUserID, Limit: 10,
		})
		if err != nil || total != 1 {
			t.Errorf("audit %s total = %d, %v", action, total, err)
		}
	}
}

func TestPlatformCredentialAPI_DisabledPlatformAndAuditAreSafe(t *testing.T) {
	e, user := createDirectHumanUser(t)
	putCredential(t, e, user.HumanUserID, "xdr", "audit-secret-key")
	path := "/api/v1/human-users/" + user.HumanUserID + "/platform-credentials/xdr"
	assertStatus(t, e.do(http.MethodDelete, path, ""), http.StatusOK)
	rr := e.do(http.MethodPatch, "/api/v1/platforms/xdr", `{"enabled":false}`)
	assertStatus(t, rr, http.StatusOK)
	rr = e.do(http.MethodPut, path, `{"apiKey":"new-secret-key"}`)
	assertStatus(t, rr, http.StatusConflict)
	entries, _, err := e.store.QueryAuditFiltered(repo.AuditFilter{HumanUserID: user.HumanUserID, Limit: 100})
	if err != nil {
		t.Fatalf("QueryAudit: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Payload, "audit-secret-key") || strings.Contains(entry.Payload, "new-secret-key") {
			t.Fatalf("credential audit exposed key: %+v", entry)
		}
	}
}

func putCredential(
	t *testing.T, e *testEnv, humanUserID, platform, apiKey string,
) platformCredentialAPIView {
	t.Helper()
	path := "/api/v1/human-users/" + humanUserID + "/platform-credentials/" + platform
	rr := e.do(http.MethodPut, path, `{"apiKey":"`+apiKey+`"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("put credential status = %d", rr.Code)
	}
	if strings.Contains(rr.Body.String(), apiKey) {
		t.Fatal("credential response exposed API key")
	}
	data := decodeAPIData[struct {
		Credential platformCredentialAPIView `json:"credential"`
	}](t, rr.Body.Bytes())
	return data.Credential
}

func assertCredentialControlPlaneUnchanged(t *testing.T, e *testEnv, generation int64) {
	t.Helper()
	pod, _ := e.store.GetPod("pod-a")
	if pod.ConfigGeneration != generation || len(e.reconcile.podIDs) != 0 {
		t.Fatalf("credential mutation changed Pod control plane: gen=%d queue=%v",
			pod.ConfigGeneration, e.reconcile.podIDs)
	}
}

func eCipher(t *testing.T) *crypto.Cipher {
	t.Helper()
	cipher, err := crypto.New("mk")
	if err != nil {
		t.Fatalf("crypto.New: %v", err)
	}
	return cipher
}

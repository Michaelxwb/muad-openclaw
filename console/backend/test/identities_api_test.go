package test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type identityAPIView struct {
	IdentityID      string `json:"identityId"`
	Channel         string `json:"channel"`
	OpenClawChannel string `json:"openclawChannel"`
	ExternalID      string `json:"externalId"`
	Status          string `json:"status"`
}

func TestIdentityAPI_CreatesIdentityAndActivatesPendingUser(t *testing.T) {
	e, user := createPendingHumanUser(t)
	podBefore, _ := e.store.GetPod("pod-a")
	e.reconcile.podIDs = nil
	body := `{"channel":"wecom","externalId":"CaseSensitiveID","externalIdType":"corp_userid"}`
	rr := e.do(http.MethodPost, "/api/v1/human-users/"+user.HumanUserID+"/identities", body)
	assertStatus(t, rr, http.StatusCreated)
	identity := decodeAPIData[identityAPIView](t, rr.Body.Bytes())
	if identity.IdentityID == "" || identity.OpenClawChannel != "wecom" ||
		identity.ExternalID != "CaseSensitiveID" || identity.Status != repo.IdentityStatusActive {
		t.Fatalf("unexpected Identity: %+v", identity)
	}
	stored, _ := e.store.GetHumanUser(user.HumanUserID)
	podAfter, _ := e.store.GetPod("pod-a")
	if stored.Status != repo.HumanUserStatusActive || podAfter.ConfigGeneration != podBefore.ConfigGeneration+1 ||
		len(e.reconcile.podIDs) != 1 {
		t.Fatalf("activation result user=%+v pod=%+v queue=%v", stored, podAfter, e.reconcile.podIDs)
	}
	path := "/api/v1/human-users/wrong-user/identities/" + identity.IdentityID
	assertStatus(t, e.do(http.MethodPatch, path, `{"status":"disabled"}`), http.StatusNotFound)
}

func TestIdentityAPI_StatusAndLastIdentityDeletionUpdateUser(t *testing.T) {
	e, user := createDirectHumanUser(t)
	identities, _ := e.store.ListIdentitiesByHumanUser(user.HumanUserID)
	identityID := identities[0].IdentityID
	path := "/api/v1/human-users/" + user.HumanUserID + "/identities/" + identityID
	assertStatus(t, e.do(http.MethodPatch, path, `{"status":"disabled"}`), http.StatusOK)
	stored, _ := e.store.GetHumanUser(user.HumanUserID)
	if stored.Status != repo.HumanUserStatusPending {
		t.Fatalf("user status after disabling last Identity = %q", stored.Status)
	}
	assertStatus(t, e.do(http.MethodPatch, path, `{"status":"active"}`), http.StatusOK)
	stored, _ = e.store.GetHumanUser(user.HumanUserID)
	if stored.Status != repo.HumanUserStatusActive {
		t.Fatalf("user status after re-enable = %q", stored.Status)
	}
	assertStatus(t, e.do(http.MethodDelete, path, ""), http.StatusOK)
	stored, _ = e.store.GetHumanUser(user.HumanUserID)
	if stored.Status != repo.HumanUserStatusPending {
		t.Fatalf("user status after deleting last Identity = %q", stored.Status)
	}
}

func TestIdentityAPI_ScopedConflictRollsBack(t *testing.T) {
	e, alice := createDirectHumanUser(t)
	modelID := createLLMModelForAPI(t, e, "bob-model")
	body := `{"displayName":"Bob","agentId":"bob","modelConfigId":"` + modelID + `",` +
		`"activation":{"channel":"wecom"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	assertStatus(t, rr, http.StatusCreated)
	bob := decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes()).HumanUser
	podBefore, _ := e.store.GetPod("pod-a")
	body = `{"channel":"wecom","externalId":"alice-external","externalIdType":"corp_userid"}`
	rr = e.do(http.MethodPost, "/api/v1/human-users/"+bob.HumanUserID+"/identities", body)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"code":40903`) {
		t.Fatalf("identity conflict response = %s", rr.Body.String())
	}
	storedBob, _ := e.store.GetHumanUser(bob.HumanUserID)
	podAfter, _ := e.store.GetPod("pod-a")
	if storedBob.Status != repo.HumanUserStatusPending || podAfter.ConfigGeneration != podBefore.ConfigGeneration {
		t.Fatalf("conflict changed state: alice=%s bob=%+v pod=%+v", alice.HumanUserID, storedBob, podAfter)
	}
}

func createPendingHumanUser(t *testing.T) (*testEnv, humanUserAPIView) {
	t.Helper()
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "charlie-model")
	body := `{"displayName":"Charlie","agentId":"charlie","modelConfigId":"` + modelID + `",` +
		`"activation":{"channel":"wecom"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create pending Human User status = %d", rr.Code)
	}
	return e, decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes()).HumanUser
}

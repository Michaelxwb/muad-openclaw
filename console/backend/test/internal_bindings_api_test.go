package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestInternalBindingAPI_UnboundSenderActivatesAndQueuesConfig(t *testing.T) {
	e, user, code := createBindingTarget(t)
	token := e.drv.created["pod-a"].ServiceToken.Value
	e.reconcile.podIDs = nil
	rr := doInternalBind(e, token, bindingBody(code, "default", "new-sender", "direct"))
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"identityBound":true`) ||
		!strings.Contains(rr.Body.String(), `"configStatus":"applying"`) {
		t.Fatalf("unexpected bind response: %s", rr.Body.String())
	}
	stored, _ := e.store.GetHumanUser(user.HumanUserID)
	identity, err := e.store.FindIdentityByExternalID("pod-a", "wecom", "default", "direct", "new-sender")
	if err != nil || stored.Status != repo.HumanUserStatusActive || identity.HumanUserID != user.HumanUserID {
		t.Fatalf("binding result user=%+v identity=%+v error=%v", stored, identity, err)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("binding reconcile queue = %v", e.reconcile.podIDs)
	}
	assertStatus(t, doInternalBind(e, token, bindingBody(code, "default", "new-sender", "direct")), http.StatusConflict)
	assertBindingAuditHasNoCode(t, e, code)
}

func TestInternalBindingAPI_RejectsGroupWithoutConsumingCode(t *testing.T) {
	e, _, code := createBindingTarget(t)
	token := e.drv.created["pod-a"].ServiceToken.Value
	rr := doInternalBind(e, token, bindingBody(code, "default", "group-sender", "group"))
	assertStatus(t, rr, http.StatusBadRequest)
	records, _ := e.store.ListBindingCodesByHumanUser(bindingTargetUserID(t, e))
	if len(records) != 1 || records[0].FailedAttempts != 0 || records[0].Status != repo.BindingCodeStatusPending {
		t.Fatalf("group request mutated code: %+v", records)
	}
	assertStatus(t, doInternalBind(e, token, bindingBody(code, "default", "group-sender", "direct")), http.StatusOK)
}

func TestInternalBindingAPI_WrongPodCountsPersistentFailures(t *testing.T) {
	e, user, code := createBindingTarget(t)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	tokenB := e.drv.created["pod-b"].ServiceToken.Value
	rr := doInternalBind(e, tokenB, bindingBody(code, "default", "sender-b", "direct"))
	assertStatus(t, rr, http.StatusBadRequest)
	records, _ := e.store.ListBindingCodesByHumanUser(user.HumanUserID)
	if len(records) != 1 || records[0].FailedAttempts != 1 {
		t.Fatalf("wrong-Pod failure count = %+v", records)
	}
}

func TestInternalBindingAPI_RateLimitsSenderWindow(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	token := e.drv.created["pod-a"].ServiceToken.Value
	body := bindingBody("MUAD-01234567", "default", "rate-sender", "direct")
	for attempt := 1; attempt <= 10; attempt++ {
		rr := doInternalBind(e, token, body)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d status = %d", attempt, rr.Code)
		}
	}
	rr := doInternalBind(e, token, body)
	assertStatus(t, rr, http.StatusTooManyRequests)
	if rr.Header().Get("Retry-After") == "" || !strings.Contains(rr.Body.String(), `"code":42901`) {
		t.Fatalf("rate-limit response = %s headers=%v", rr.Body.String(), rr.Header())
	}
	other := bindingBody("MUAD-01234567", "default", "other-sender", "direct")
	assertStatus(t, doInternalBind(e, token, other), http.StatusBadRequest)
}

func TestInternalBindingAPI_RevokesCodeAfterFiveScopeFailures(t *testing.T) {
	e, user, code := createBindingTarget(t)
	token := e.drv.created["pod-a"].ServiceToken.Value
	body := bindingBody(code, "wrong-account", "scope-sender", "direct")
	for attempt := 1; attempt <= 5; attempt++ {
		assertStatus(t, doInternalBind(e, token, body), http.StatusBadRequest)
	}
	records, _ := e.store.ListBindingCodesByHumanUser(user.HumanUserID)
	if len(records) != 1 || records[0].FailedAttempts != 5 || records[0].Status != repo.BindingCodeStatusRevoked {
		t.Fatalf("persistent binding limit = %+v", records)
	}
	assertStatus(t, doInternalBind(e, token, body), http.StatusConflict)
}

func createBindingTarget(t *testing.T) (*testEnv, humanUserAPIView, string) {
	t.Helper()
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "charlie-model")
	body := `{"displayName":"Charlie","agentId":"charlie","modelConfigId":"` + modelID + `",` +
		`"activation":{"channel":"wecom"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create binding target status = %d", rr.Code)
	}
	created := decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes())
	return e, created.HumanUser, created.Activation.Code
}

func bindingTargetUserID(t *testing.T, e *testEnv) string {
	t.Helper()
	users, _, err := e.store.ListHumanUsersByPod("pod-a", repo.HumanUserListFilter{})
	if err != nil || len(users) != 1 {
		t.Fatalf("binding target users = %+v, %v", users, err)
	}
	return users[0].HumanUserID
}

func bindingBody(code, accountID, sender, peerKind string) string {
	body, _ := json.Marshal(map[string]string{
		"code": code, "channel": "wecom", "openclawChannel": "wecom",
		"accountId": accountID, "externalId": sender,
		"externalIdType": "corp_userid", "peerKind": peerKind,
	})
	return string(body)
}

func doInternalBind(e *testEnv, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/bindings/activate", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	return rr
}

func assertBindingAuditHasNoCode(t *testing.T, e *testEnv, code string) {
	t.Helper()
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{
		PodID: "pod-a", Limit: 100,
	})
	if err != nil || total == 0 {
		t.Fatalf("binding audit query = %d, %v", total, err)
	}
	for index, entry := range entries {
		if strings.Contains(entry.Payload, code) || strings.Contains(entry.Target, code) {
			t.Fatalf("audit %s exposed binding code at %s", strconv.Itoa(index), entry.Payload)
		}
	}
}

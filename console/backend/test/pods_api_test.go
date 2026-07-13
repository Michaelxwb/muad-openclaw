package test

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	testWeComSecret = "test-wecom-secret"
	testPodBody     = `{"podId":"pod-a","displayName":"Pod A","maxUsers":2,` +
		`"channels":["wecom"],"channelConfigs":{"wecom":{"botId":"bot-a","secret":"` +
		testWeComSecret + `"}}}`
)

type podAPIView struct {
	PodID          string `json:"podId"`
	DisplayName    string `json:"displayName"`
	State          string `json:"state"`
	MaxUsers       int    `json:"maxUsers"`
	UserCount      int    `json:"userCount"`
	AvailableSlots int    `json:"availableSlots"`
	ChannelConfigs map[string]struct {
		BotID            string `json:"botId"`
		SecretConfigured bool   `json:"secretConfigured"`
	} `json:"channelConfigs"`
}

type podAPIList struct {
	Items    []podAPIView `json:"items"`
	Total    int          `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"pageSize"`
}

func TestPodAPI_CreateListAndDetail(t *testing.T) {
	e := newTestEnv(t)
	created := createPodThroughAPI(t, e, testPodBody)
	if created.PodID != "pod-a" || created.State != "running" || created.AvailableSlots != 2 {
		t.Fatalf("unexpected created Pod: %+v", created)
	}
	assertPodSecretHandling(t, e, "pod-a")
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))

	rr := e.do(http.MethodGet, "/api/v1/containers?page=2&pageSize=1", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("list status = %d", rr.Code)
	}
	list := decodeAPIData[podAPIList](t, rr.Body.Bytes())
	if list.Total != 2 || list.Page != 2 || list.PageSize != 1 || len(list.Items) != 1 || list.Items[0].PodID != "pod-b" {
		t.Fatalf("unexpected page: %+v", list)
	}
}

func TestPodAPI_RejectsCapacityReduction(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createTestHumanUser(t, e.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestHumanUser(t, e.store, "pod-a", "bob", repo.HumanUserStatusPending)

	rr := e.do(http.MethodPatch, "/api/v1/containers/pod-a", `{"maxUsers":1}`)
	if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), `"code":40902`) {
		t.Fatalf("capacity response = %d", rr.Code)
	}
	rr = e.do(http.MethodPatch, "/api/v1/containers/pod-a", `{"displayName":"Pod Updated","maxUsers":2}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("valid patch status = %d", rr.Code)
	}
	view := decodeAPIData[podAPIView](t, rr.Body.Bytes())
	if view.DisplayName != "Pod Updated" || view.UserCount != 2 || view.AvailableSlots != 0 {
		t.Fatalf("unexpected patched Pod: %+v", view)
	}
}

func TestPodAPI_ChannelUpdatePreservesSecret(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.reconcile.podIDs = nil
	body := `{"channels":["wechat","wecom"],"channelConfigs":{"wecom":{"botId":"bot-new"}}}`
	rr := e.do(http.MethodPut, "/api/v1/containers/pod-a/channels", body)
	if rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), testWeComSecret) {
		t.Fatalf("channel update status = %d", rr.Code)
	}
	view := decodeAPIData[podAPIView](t, rr.Body.Bytes())
	if !view.ChannelConfigs["wecom"].SecretConfigured || view.ChannelConfigs["wecom"].BotID != "bot-new" {
		t.Fatalf("unexpected channel view: %+v", view.ChannelConfigs)
	}
	assertEncryptedChannelConfig(t, e, "pod-a", "bot-new", testWeComSecret)
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("reconcile queue = %v", e.reconcile.podIDs)
	}
}

func TestPodAPI_DeleteRequiresStatePolicyAndReportsRetainedConflict(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	if rr := e.do(http.MethodDelete, "/api/v1/containers/pod-a", ""); rr.Code != http.StatusBadRequest {
		t.Fatalf("delete without policy = %d", rr.Code)
	}
	if rr := e.do(http.MethodDelete, "/api/v1/containers/pod-a?deleteState=false", ""); rr.Code != http.StatusOK {
		t.Fatalf("retain delete status = %d", rr.Code)
	}
	if !e.drv.keepState["pod-a"] {
		t.Fatal("driver did not retain Pod state")
	}
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{
		Action: "pod.delete", Target: "pod-a", Limit: 10,
	})
	if err != nil || total != 1 || len(entries) != 1 || !strings.Contains(entries[0].Payload, "state_retained") {
		t.Fatalf("retained delete audit = %+v/%d, %v", entries, total, err)
	}
	e.drv.createErr = driver.ErrRetainedState
	rr := e.do(http.MethodPost, "/api/v1/containers", testPodBody)
	if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), `"code":40906`) {
		t.Fatalf("retained create response = %d", rr.Code)
	}
	if _, err := e.store.GetPod("pod-a"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("failed create left Pod row: %v", err)
	}
}

func TestPodAPI_RejectsUnsupportedChannel(t *testing.T) {
	e := newTestEnv(t)
	body := `{"podId":"pod-a","channels":["feishu"],"channelConfigs":{}}`
	rr := e.do(http.MethodPost, "/api/v1/containers", body)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unsupported channel status = %d", rr.Code)
	}
}

func createPodThroughAPI(t *testing.T, e *testEnv, body string) podAPIView {
	t.Helper()
	rr := e.do(http.MethodPost, "/api/v1/containers", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create Pod status = %d", rr.Code)
	}
	if strings.Contains(rr.Body.String(), testWeComSecret) {
		t.Fatal("create response exposed a channel secret")
	}
	return decodeAPIData[podAPIView](t, rr.Body.Bytes())
}

func assertPodSecretHandling(t *testing.T, e *testEnv, podID string) {
	t.Helper()
	spec := e.drv.created[podID]
	if spec.ServiceToken.Value == "" || spec.GatewayToken == "" || spec.ServiceToken.Value == spec.GatewayToken {
		t.Fatal("Pod service and gateway token separation is invalid")
	}
	assertEncryptedChannelConfig(t, e, podID, "bot-a", testWeComSecret)
}

func assertEncryptedChannelConfig(t *testing.T, e *testEnv, podID, botID, secret string) {
	t.Helper()
	pod, err := e.store.GetPod(podID)
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	if strings.Contains(pod.ChannelConfigsEnc, secret) {
		t.Fatal("channel secret stored as plaintext")
	}
	cipher, err := crypto.New("mk")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	plain, err := cipher.Decrypt(pod.ChannelConfigsEnc)
	if err != nil || !strings.Contains(plain, botID) || !strings.Contains(plain, secret) {
		t.Fatalf("encrypted channel config cannot be recovered: %v", err)
	}
}

func decodeAPIData[T any](t *testing.T, body []byte) T {
	t.Helper()
	var envelope struct {
		Code int `json:"code"`
		Data T   `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Code != 0 {
		t.Fatalf("decode API response: code=%d error=%v", envelope.Code, err)
	}
	return envelope.Data
}

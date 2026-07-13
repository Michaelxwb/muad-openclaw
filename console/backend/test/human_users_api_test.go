package test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type humanUserAPIView struct {
	HumanUserID    string `json:"humanUserId"`
	PodID          string `json:"podId"`
	ModelConfigID  string `json:"modelConfigId"`
	DisplayName    string `json:"displayName"`
	AgentID        string `json:"agentId"`
	BrowserProfile string `json:"browserProfile"`
	BrowserCDPPort int    `json:"browserCdpPort"`
	Status         string `json:"status"`
	IdentityCount  int    `json:"identityCount"`
	ModelConfig    struct {
		Provider       string `json:"provider"`
		Model          string `json:"model"`
		KeyConfigured  bool   `json:"keyConfigured"`
		KeyFingerprint string `json:"keyFingerprint"`
	} `json:"modelConfig"`
}

type humanUserCreateResponse struct {
	HumanUser humanUserAPIView `json:"humanUser"`
	Identity  struct {
		IdentityID string `json:"identityId"`
	} `json:"identity"`
	Activation struct {
		BindingCodeID string `json:"bindingCodeId"`
		Code          string `json:"code"`
	} `json:"activation"`
}

func TestHumanUserAPI_CreateDirectIdentityAndList(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "alice-model")
	body := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + modelID + `","identity":{` +
		`"channel":"wecom","accountId":"default","externalId":"XuWenBin",` +
		`"externalIdType":"corp_userid"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes())
	user := created.HumanUser
	if user.Status != repo.HumanUserStatusActive || user.AgentID != "alice" ||
		user.BrowserProfile != "alice" || user.BrowserCDPPort != 18802 || user.IdentityCount != 1 {
		t.Fatalf("unexpected created user: %+v", user)
	}
	if created.Identity.IdentityID == "" {
		t.Fatal("direct Identity was not returned")
	}
	rr = e.do(http.MethodGet, "/api/v1/containers/pod-a/human-users?q=Alice", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []humanUserAPIView `json:"items"`
		Total int                `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].HumanUserID != user.HumanUserID {
		t.Fatalf("unexpected Human User list: %+v", list)
	}
}

func TestHumanUserAPI_ListAllAcrossPodsIncludesModel(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	aliceModel := createLLMModelForAPI(t, e, "alice-model")
	bobModel := createLLMModelForAPI(t, e, "bob-model")
	aliceBody := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + aliceModel + `","identity":{` +
		`"channel":"wecom","accountId":"default","externalId":"alice",` +
		`"externalIdType":"corp_userid"}}`
	bobBody := `{"displayName":"Bob","agentId":"bob","modelConfigId":"` + bobModel + `","activation":{` +
		`"channel":"wecom","expiresInMinutes":30}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", aliceBody), http.StatusCreated)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-b/human-users", bobBody), http.StatusCreated)

	rr := e.do(http.MethodGet, "/api/v1/human-users?q=pod-b", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []humanUserAPIView `json:"items"`
		Total int                `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 {
		t.Fatalf("unexpected filtered global list: %+v", list)
	}
	if list.Items[0].PodID != "pod-b" || list.Items[0].DisplayName != "Bob" ||
		list.Items[0].ModelConfig.Model != "deepseek-chat" || !list.Items[0].ModelConfig.KeyConfigured {
		t.Fatalf("global list did not include Pod/model data: %+v", list.Items[0])
	}

	rr = e.do(http.MethodGet, "/api/v1/human-users?page=1&pageSize=20", "")
	assertStatus(t, rr, http.StatusOK)
	all := decodeAPIData[struct {
		Items []humanUserAPIView `json:"items"`
		Total int                `json:"total"`
	}](t, rr.Body.Bytes())
	if all.Total != 2 || len(all.Items) != 2 || all.Items[0].IdentityCount != 1 {
		t.Fatalf("unexpected global list counts: %+v", all)
	}
}

func TestHumanUserAPI_ActivationCodeIsReturnedOnlyAtCreation(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "charlie-model")
	body := `{"displayName":"Charlie","modelConfigId":"` + modelID + `",` +
		`"activation":{"channel":"wecom","expiresInMinutes":30}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes())
	if !strings.HasPrefix(created.Activation.Code, "MUAD-") || created.Activation.BindingCodeID == "" {
		t.Fatalf("activation response = %+v", created.Activation)
	}
	if created.HumanUser.Status != repo.HumanUserStatusPending ||
		created.HumanUser.AgentID == "" || created.HumanUser.AgentID != created.HumanUser.BrowserProfile {
		t.Fatalf("unexpected pending user: %+v", created.HumanUser)
	}
	rr = e.do(http.MethodGet, "/api/v1/human-users/"+created.HumanUser.HumanUserID, "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), created.Activation.Code) {
		t.Fatal("Human User detail replayed the plaintext binding code")
	}
	rr = e.do(http.MethodPatch, "/api/v1/human-users/"+created.HumanUser.HumanUserID, `{"status":"active"}`)
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestHumanUserAPI_CreateEnforcesPodCapacity(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, strings.Replace(testPodBody, `"maxUsers":2`, `"maxUsers":1`, 1))
	aliceModel := createLLMModelForAPI(t, e, "alice-model")
	bobModel := createLLMModelForAPI(t, e, "bob-model")
	body := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + aliceModel + `","identity":{` +
		`"channel":"wecom","externalId":"alice","externalIdType":"corp_userid"}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body), http.StatusCreated)
	body = `{"displayName":"Bob","agentId":"bob","modelConfigId":"` + bobModel + `",` +
		`"activation":{"channel":"wecom"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"code":40902`) {
		t.Fatalf("capacity error = %s", rr.Body.String())
	}
}

func TestHumanUserAPI_PatchProtectsRuntimeIdentityAndGeneration(t *testing.T) {
	e, user := createDirectHumanUser(t)
	rr := e.do(http.MethodPatch, "/api/v1/human-users/"+user.HumanUserID, `{"agentId":"other"}`)
	assertStatus(t, rr, http.StatusBadRequest)
	podBefore, _ := e.store.GetPod("pod-a")
	e.reconcile.podIDs = nil
	rr = e.do(http.MethodPatch, "/api/v1/human-users/"+user.HumanUserID, `{"notes":"owner note"}`)
	assertStatus(t, rr, http.StatusOK)
	podAfter, _ := e.store.GetPod("pod-a")
	if podAfter.ConfigGeneration != podBefore.ConfigGeneration || len(e.reconcile.podIDs) != 0 {
		t.Fatalf("notes update triggered runtime apply: %d -> %d, queue=%v",
			podBefore.ConfigGeneration, podAfter.ConfigGeneration, e.reconcile.podIDs)
	}
	rr = e.do(http.MethodPatch, "/api/v1/human-users/"+user.HumanUserID, `{"status":"disabled"}`)
	assertStatus(t, rr, http.StatusOK)
	podAfterDisable, _ := e.store.GetPod("pod-a")
	if podAfterDisable.ConfigGeneration != podAfter.ConfigGeneration+1 || len(e.reconcile.podIDs) != 1 {
		t.Fatalf("disable did not trigger one generation: %+v queue=%v", podAfterDisable, e.reconcile.podIDs)
	}
}

func TestHumanUserAPI_DeleteRemainsDeletingUntilCleanerRuns(t *testing.T) {
	e, user := createDirectHumanUser(t)
	e.reconcile.podIDs = nil
	rr := e.do(http.MethodDelete, "/api/v1/human-users/"+user.HumanUserID, "")
	assertStatus(t, rr, http.StatusAccepted)
	stored, err := e.store.GetHumanUser(user.HumanUserID)
	if err != nil || stored.Status != repo.HumanUserStatusDeleting {
		t.Fatalf("deleting Human User = %+v, %v", stored, err)
	}
	if len(e.reconcile.podIDs) != 1 || e.reconcile.podIDs[0] != "pod-a" {
		t.Fatalf("delete reconcile queue = %v", e.reconcile.podIDs)
	}
}

func createDirectHumanUser(t *testing.T) (*testEnv, humanUserAPIView) {
	t.Helper()
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "alice-model")
	body := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + modelID + `","identity":{` +
		`"channel":"wecom","externalId":"alice-external","externalIdType":"corp_userid"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create Human User status = %d", rr.Code)
	}
	return e, decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes()).HumanUser
}

func createLLMModelForAPI(t *testing.T, e *testEnv, name string) string {
	t.Helper()
	cipher, err := crypto.New("mk")
	if err != nil {
		t.Fatalf("create cipher: %v", err)
	}
	encrypted, err := cipher.Encrypt("sk-" + name)
	if err != nil {
		t.Fatalf("encrypt model key: %v", err)
	}
	models, err := e.store.CreateLLMModelConfigs([]repo.LLMModelConfigCreate{{
		DisplayName: name, Provider: "deepseek", BaseURL: "https://api.deepseek.com",
		APIKeyEnc: encrypted, APIKeyFingerprint: crypto.Fingerprint("sk-" + name),
		Model: "deepseek-chat",
	}})
	if err != nil {
		t.Fatalf("create LLM model: %v", err)
	}
	return models[0].ModelConfigID
}

package test

import (
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestLLMModels_BatchCreateTestAndBindOnce(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	baseURL, authorizations := recordingLLM(t)
	body := `{"models":[` +
		`{"displayName":"Alice Model","provider":"deepseek","baseUrl":"` + baseURL + `","apiKey":"sk-alice","model":"deepseek-chat"},` +
		`{"displayName":"Bob Model","provider":"deepseek","baseUrl":"` + baseURL + `","apiKey":"sk-bob","model":"deepseek-chat"}` +
		`]}`
	rr := e.do(http.MethodPost, "/api/v1/llm/models/batch", body)
	assertStatus(t, rr, http.StatusCreated)
	if !strings.Contains(rr.Body.String(), `"apiKey":"sk-alice"`) ||
		!strings.Contains(rr.Body.String(), `"apiKey":"sk-bob"`) {
		t.Fatalf("created model response should expose plaintext API key: %s", rr.Body.String())
	}
	created := decodeAPIData[struct {
		Items []struct {
			ModelConfigID string `json:"modelConfigId"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	if len(created.Items) != 2 || created.Items[0].ModelConfigID == "" {
		t.Fatalf("created model response = %+v", created)
	}

	testBody := `{"modelConfigIds":["` + created.Items[0].ModelConfigID + `","` +
		created.Items[1].ModelConfigID + `"]}`
	rr = e.do(http.MethodPost, "/api/v1/llm/models/test", testBody)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"ok":true`) ||
		!slices.Contains(*authorizations, "Bearer sk-alice") ||
		!slices.Contains(*authorizations, "Bearer sk-bob") {
		t.Fatalf("batch test did not probe both models: body=%s auth=%v", rr.Body.String(), *authorizations)
	}

	createBody := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` +
		created.Items[0].ModelConfigID + `","identity":{"channel":"wecom",` +
		`"externalId":"alice-id","externalIdType":"corp_userid"}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", createBody), http.StatusCreated)
	rr = e.do(http.MethodGet, "/api/v1/llm/models", "")
	assertStatus(t, rr, http.StatusOK)
	modelList := decodeAPIData[struct {
		Items []struct {
			ModelConfigID      string `json:"modelConfigId"`
			BoundHumanUserID   string `json:"boundHumanUserId"`
			BoundHumanUserName string `json:"boundHumanUserName"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	if !modelListIncludesBinding(modelList.Items, created.Items[0].ModelConfigID, "Alice") {
		t.Fatalf("bound user name missing from model list: %+v", modelList.Items)
	}
	rr = e.do(http.MethodGet, "/api/v1/llm/models?available=true", "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), created.Items[0].ModelConfigID) ||
		!strings.Contains(rr.Body.String(), created.Items[1].ModelConfigID) {
		t.Fatalf("available models did not exclude bound model: %s", rr.Body.String())
	}

	duplicateBody := strings.ReplaceAll(createBody, `"Alice"`, `"Other"`)
	duplicateBody = strings.ReplaceAll(duplicateBody, `"alice"`, `"other"`)
	duplicateBody = strings.ReplaceAll(duplicateBody, `"alice-id"`, `"other-id"`)
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", duplicateBody), http.StatusConflict)
}

func TestLLMModels_UpdateFieldsAndRejectInvalidThinking(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	baseURL, _ := recordingLLM(t)
	body := `{"models":[` +
		`{"displayName":"Alice Model","provider":"deepseek","baseUrl":"` + baseURL + `","apiKey":"sk-alice","model":"deepseek-chat"}` +
		`]}`
	rr := e.do(http.MethodPost, "/api/v1/llm/models/batch", body)
	assertStatus(t, rr, http.StatusCreated)
	created := decodeAPIData[struct {
		Items []struct {
			ModelConfigID string `json:"modelConfigId"`
			Thinking      string `json:"thinking"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	modelID := created.Items[0].ModelConfigID
	if created.Items[0].Thinking != "off" {
		t.Fatalf("default thinking should be off, got %q", created.Items[0].Thinking)
	}

	// 更新 apiKey / supportsTools / thinking。
	patch := `{"apiKey":"sk-updated","supportsTools":false,"thinking":"high"}`
	rr = e.do(http.MethodPatch, "/api/v1/llm/models/"+modelID, patch)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"apiKey":"sk-updated"`) ||
		!strings.Contains(rr.Body.String(), `"supportsTools":false`) ||
		!strings.Contains(rr.Body.String(), `"thinking":"high"`) {
		t.Fatalf("updated model should reflect new fields: %s", rr.Body.String())
	}
	// 更新已绑定用户（本测试中 human-user 尚未绑定该模型，绑定在
	// TestLLMModels_BatchCreateTestAndBindOnce 里做；此处模型未绑定，故不递增
	// pod generation）。为验证 generation 递增，先绑定一个用户再更新。
	createBody := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + modelID + `","identity":{"channel":"wecom","externalId":"alice-id","externalIdType":"corp_userid"}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", createBody), http.StatusCreated)
	before, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("get pod before update: %v", err)
	}
	rr = e.do(http.MethodPatch, "/api/v1/llm/models/"+modelID, `{"thinking":"max"}`)
	assertStatus(t, rr, http.StatusOK)
	after, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("get pod after update: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration+1 {
		t.Fatalf("model update should bump pod generation: before=%d after=%d", before.ConfigGeneration, after.ConfigGeneration)
	}

	// 非法 thinking 档位被拒绝。
	rr = e.do(http.MethodPatch, "/api/v1/llm/models/"+modelID, `{"thinking":"not-a-level"}`)
	assertStatus(t, rr, http.StatusBadRequest)
}

func modelListIncludesBinding(
	items []struct {
		ModelConfigID      string `json:"modelConfigId"`
		BoundHumanUserID   string `json:"boundHumanUserId"`
		BoundHumanUserName string `json:"boundHumanUserName"`
	},
	modelConfigID, userName string,
) bool {
	for _, item := range items {
		if item.ModelConfigID == modelConfigID &&
			item.BoundHumanUserID != "" &&
			item.BoundHumanUserName == userName {
			return true
		}
	}
	return false
}

func recordingLLM(t *testing.T) (string, *[]string) {
	t.Helper()
	authorizations := []string{}
	var mu sync.Mutex
	previous := http.DefaultTransport
	http.DefaultTransport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		mu.Unlock()
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"data":[]}`)),
			Header:     make(http.Header),
			Request:    r,
		}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
	return "https://llm.test", &authorizations
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

package test

import (
	"io"
	"net/http"
	"slices"
	"strings"
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
	assertNoSecret(t, rr.Body.String(), "sk-alice", "sk-bob")
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
	previous := http.DefaultTransport
	http.DefaultTransport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		authorizations = append(authorizations, r.Header.Get("Authorization"))
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

func assertNoSecret(t *testing.T, body string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if strings.Contains(body, secret) || strings.Contains(body, `"apiKey":`) {
			t.Fatalf("response exposed model key material: %s", body)
		}
	}
}

package test

import (
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

func TestGlobalLLM_PreservesKeyAndMarksEveryPod(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	baseURL, authorizations := recordingLLM(t)
	e.reconcile.podIDs = nil

	setGlobalModel(t, e, baseURL, "global-old-key", "deepseek-chat")
	before := podGenerations(t, e, "pod-a", "pod-b")
	e.reconcile.podIDs = nil
	rr := e.do(http.MethodPut, "/api/v1/llm", `{"model":"deepseek-reasoner"}`)
	assertStatus(t, rr, http.StatusOK)

	assertNoSecret(t, rr.Body.String(), "global-old-key")
	assertGlobalStoredKey(t, e, "global-old-key")
	after := podGenerations(t, e, "pod-a", "pod-b")
	if after[0] != before[0]+1 || after[1] != before[1]+1 {
		t.Fatalf("global model generations = %v -> %v", before, after)
	}
	if got := append([]string(nil), e.reconcile.podIDs...); !sameStrings(got, []string{"pod-a", "pod-b"}) {
		t.Fatalf("global model reconcile queue = %v", got)
	}
	if !slices.Contains(*authorizations, "Bearer global-old-key") {
		t.Fatalf("preserved key was not used by connectivity probe: %v", *authorizations)
	}
}

func TestGlobalLLM_NoOpDoesNotAdvanceGeneration(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	baseURL, _ := recordingLLM(t)
	setGlobalModel(t, e, baseURL, "global-key", "deepseek-chat")
	before := podGenerations(t, e, "pod-a")[0]
	e.reconcile.podIDs = nil

	rr := e.do(http.MethodPut, "/api/v1/llm", `{"model":"deepseek-chat"}`)
	assertStatus(t, rr, http.StatusOK)
	after := podGenerations(t, e, "pod-a")[0]
	if after != before || len(e.reconcile.podIDs) != 0 {
		t.Fatalf("no-op model update changed runtime: %d -> %d, queue=%v", before, after, e.reconcile.podIDs)
	}
}

func TestPodLLM_PreservesKeyAndReturnsRedactedViews(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	path := "/api/v1/containers/pod-a/llm"
	body := `{"provider":"deepseek","baseUrl":"https://api.deepseek.com",` +
		`"apiKey":"pod-private-key","model":"deepseek-chat"}`
	e.reconcile.podIDs = nil
	before := podGenerations(t, e, "pod-a")[0]

	rr := e.do(http.MethodPut, path, body)
	assertStatus(t, rr, http.StatusOK)
	assertNoSecret(t, rr.Body.String(), "pod-private-key")
	after := podGenerations(t, e, "pod-a")[0]
	if after != before+1 || !slices.Equal(e.reconcile.podIDs, []string{"pod-a"}) {
		t.Fatalf("Pod model update runtime = %d -> %d, queue=%v", before, after, e.reconcile.podIDs)
	}

	rr = e.do(http.MethodPut, path, `{"model":"deepseek-reasoner"}`)
	assertStatus(t, rr, http.StatusOK)
	assertPodStoredKey(t, e, "pod-a", "pod-private-key")
	for _, queryPath := range []string{path, "/api/v1/containers/pod-a", "/api/v1/containers"} {
		rr = e.do(http.MethodGet, queryPath, "")
		assertStatus(t, rr, http.StatusOK)
		assertNoSecret(t, rr.Body.String(), "pod-private-key")
	}
}

func TestHumanUserModels_KeepDifferentDeepSeekKeys(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	alice := createNamedHumanUser(t, e, "Alice", "alice", "alice-id")
	charlie := createNamedHumanUser(t, e, "Charlie", "charlie", "charlie-id")

	setHumanUserModel(t, e, alice.HumanUserID, "alice-old-key")
	setHumanUserModel(t, e, charlie.HumanUserID, "charlie-new-key")
	assertHumanUserStoredKey(t, e, alice.HumanUserID, "alice-old-key")
	assertHumanUserStoredKey(t, e, charlie.HumanUserID, "charlie-new-key")

	for _, user := range []humanUserAPIView{alice, charlie} {
		rr := e.do(http.MethodGet, "/api/v1/human-users/"+user.HumanUserID, "")
		assertStatus(t, rr, http.StatusOK)
		assertNoSecret(t, rr.Body.String(), "alice-old-key")
		assertNoSecret(t, rr.Body.String(), "charlie-new-key")
	}
}

func TestApplyLLM_AcceptsOnlyPodIDs(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	e.reconcile.podIDs = nil
	assertStatus(t, e.do(http.MethodPost, "/api/v1/llm/apply", `{"userIds":["alice"]}`), http.StatusBadRequest)

	rr := e.do(http.MethodPost, "/api/v1/llm/apply", `{"podIds":["pod-a","pod-missing"]}`)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"pod-a":"queued"`) ||
		!strings.Contains(rr.Body.String(), `"pod-missing":"not_found"`) {
		t.Fatalf("apply LLM response = %s", rr.Body.String())
	}
	if !slices.Equal(e.reconcile.podIDs, []string{"pod-a"}) {
		t.Fatalf("apply LLM reconcile queue = %v", e.reconcile.podIDs)
	}
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

func setGlobalModel(t *testing.T, e *testEnv, baseURL, key, model string) {
	t.Helper()
	body := `{"provider":"deepseek","baseUrl":"` + baseURL + `","apiKey":"` + key +
		`","model":"` + model + `"}`
	rr := e.do(http.MethodPut, "/api/v1/llm", body)
	assertStatus(t, rr, http.StatusOK)
	assertNoSecret(t, rr.Body.String(), key)
}

func createNamedHumanUser(t *testing.T, e *testEnv, display, agentID, externalID string) humanUserAPIView {
	t.Helper()
	body := `{"displayName":"` + display + `","agentId":"` + agentID + `","identity":{` +
		`"channel":"wecom","externalId":"` + externalID + `","externalIdType":"corp_userid"}}`
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body)
	assertStatus(t, rr, http.StatusCreated)
	return decodeAPIData[humanUserCreateResponse](t, rr.Body.Bytes()).HumanUser
}

func setHumanUserModel(t *testing.T, e *testEnv, humanUserID, key string) {
	t.Helper()
	body := `{"provider":"deepseek","baseUrl":"https://api.deepseek.com",` +
		`"apiKey":"` + key + `","model":"deepseek-chat"}`
	rr := e.do(http.MethodPut, "/api/v1/human-users/"+humanUserID+"/model", body)
	assertStatus(t, rr, http.StatusOK)
	assertNoSecret(t, rr.Body.String(), key)
}

func podGenerations(t *testing.T, e *testEnv, podIDs ...string) []int64 {
	t.Helper()
	result := make([]int64, 0, len(podIDs))
	for _, podID := range podIDs {
		pod, err := e.store.GetPod(podID)
		if err != nil {
			t.Fatalf("GetPod(%s): %v", podID, err)
		}
		result = append(result, pod.ConfigGeneration)
	}
	return result
}

func assertGlobalStoredKey(t *testing.T, e *testEnv, expected string) {
	t.Helper()
	global, err := e.store.GetLLMGlobal()
	if err != nil {
		t.Fatalf("GetLLMGlobal: %v", err)
	}
	assertEncryptedValue(t, global.APIKeyEnc, expected)
}

func assertPodStoredKey(t *testing.T, e *testEnv, podID, expected string) {
	t.Helper()
	pod, err := e.store.GetPod(podID)
	if err != nil {
		t.Fatalf("GetPod: %v", err)
	}
	assertEncryptedDocumentKey(t, pod.LLMOverrideEnc, expected)
}

func assertHumanUserStoredKey(t *testing.T, e *testEnv, humanUserID, expected string) {
	t.Helper()
	user, err := e.store.GetHumanUser(humanUserID)
	if err != nil {
		t.Fatalf("GetHumanUser: %v", err)
	}
	assertEncryptedDocumentKey(t, user.ModelOverrideEnc, expected)
}

func assertEncryptedValue(t *testing.T, encrypted, expected string) {
	t.Helper()
	if strings.Contains(encrypted, expected) {
		t.Fatal("secret stored as plaintext")
	}
	cipher, err := secretcrypto.New("mk")
	if err != nil {
		t.Fatalf("crypto.New: %v", err)
	}
	plain, err := cipher.Decrypt(encrypted)
	if err != nil || plain != expected {
		t.Fatalf("decrypt stored secret: value=%q error=%v", plain, err)
	}
}

func assertEncryptedDocumentKey(t *testing.T, encrypted, expected string) {
	t.Helper()
	if strings.Contains(encrypted, expected) {
		t.Fatal("model document stored as plaintext")
	}
	cipher, _ := secretcrypto.New("mk")
	plain, err := cipher.Decrypt(encrypted)
	if err != nil || !strings.Contains(plain, `"apiKey":"`+expected+`"`) {
		t.Fatalf("stored model key mismatch: %v", err)
	}
}

func assertNoSecret(t *testing.T, body string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if strings.Contains(body, secret) || strings.Contains(body, `"apiKey":`) {
			t.Fatalf("response exposed model key material: %s", body)
		}
	}
}

func sameStrings(left, right []string) bool {
	slices.Sort(left)
	slices.Sort(right)
	return slices.Equal(left, right)
}

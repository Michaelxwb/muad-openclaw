package test

import (
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type platformAPIView struct {
	Platform          string         `json:"platform"`
	DisplayName       string         `json:"displayName"`
	Config            map[string]any `json:"config"`
	ConfigFingerprint string         `json:"configFingerprint"`
	Enabled           bool           `json:"enabled"`
	AdapterInstalled  bool           `json:"adapterInstalled"`
}

func TestPlatformAPI_ListAndPatchReconcilesAllPods(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	createPodThroughAPI(t, e, strings.ReplaceAll(testPodBody, "pod-a", "pod-b"))
	e.reconcile.podIDs = nil
	body := `{"displayName":"XDR Platform","config":{` +
		`"baseUrl":"https://xdr.internal","sessionMode":"storage_state"}}`
	rr := e.do(http.MethodPatch, "/api/v1/platforms/xdr", body)
	assertStatus(t, rr, http.StatusOK)
	view := decodeAPIData[platformAPIView](t, rr.Body.Bytes())
	if view.DisplayName != "XDR Platform" || view.Config["baseUrl"] != "https://xdr.internal" ||
		view.ConfigFingerprint == "" || !view.AdapterInstalled {
		t.Fatalf("unexpected platform view: %+v", view)
	}
	sort.Strings(e.reconcile.podIDs)
	if strings.Join(e.reconcile.podIDs, ",") != "pod-a,pod-b" {
		t.Fatalf("platform reconcile queue = %v", e.reconcile.podIDs)
	}
	for _, podID := range []string{"pod-a", "pod-b"} {
		pod, _ := e.store.GetPod(podID)
		if pod.ConfigGeneration != 2 {
			t.Fatalf("Pod %s generation = %d", podID, pod.ConfigGeneration)
		}
	}
	assertIdempotentPlatformPatch(t, e, body)
}

func TestPlatformAPI_RejectsSecretsInConfig(t *testing.T) {
	e := newTestEnv(t)
	rr := e.do(http.MethodPatch, "/api/v1/platforms/xdr", `{"config":{"apiKey":"forbidden"}}`)
	assertStatus(t, rr, http.StatusBadRequest)
	rr = e.do(http.MethodPost, "/api/v1/platforms", `{"platform":"xdr","displayName":"Duplicate"}`)
	assertStatus(t, rr, http.StatusConflict)
	rr = e.do(http.MethodGet, "/api/v1/platforms", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []platformAPIView `json:"items"`
		Total int               `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 5 || len(list.Items) != 5 {
		t.Fatalf("platform list = %+v", list)
	}
}

func assertIdempotentPlatformPatch(t *testing.T, e *testEnv, body string) {
	t.Helper()
	e.reconcile.podIDs = nil
	before, _ := e.store.GetPod("pod-a")
	rr := e.do(http.MethodPatch, "/api/v1/platforms/xdr", body)
	assertStatus(t, rr, http.StatusOK)
	after, _ := e.store.GetPod("pod-a")
	if after.ConfigGeneration != before.ConfigGeneration || len(e.reconcile.podIDs) != 0 {
		t.Fatalf("idempotent patch changed generation: %d -> %d queue=%v",
			before.ConfigGeneration, after.ConfigGeneration, e.reconcile.podIDs)
	}
}

func TestPlatformAPI_DisableIsAuditedAndInvalidatesResolver(t *testing.T) {
	e, user := createDirectHumanUser(t)
	putCredential(t, e, user.HumanUserID, "xdr", "xdr-key")
	rr := e.do(http.MethodPatch, "/api/v1/platforms/xdr", `{"enabled":false}`)
	assertStatus(t, rr, http.StatusOK)
	_, err := e.store.ResolveUserPlatformCredential(eCipher(t), user.HumanUserID, "xdr")
	if err != repo.ErrPlatformDisabled {
		t.Fatalf("disabled resolver error = %v", err)
	}
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{
		Action: "platform_config.disable", Target: "xdr", Limit: 10,
	})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("platform disable audit = %+v/%d, %v", entries, total, err)
	}
}

func TestPlatformAPI_DeleteRemovesConfigAndReconcilesPods(t *testing.T) {
	e, user := createDirectHumanUser(t)
	putCredential(t, e, user.HumanUserID, "xdr", "xdr-key")
	e.reconcile.podIDs = nil

	rr := e.do(http.MethodDelete, "/api/v1/platforms/xdr", "")
	assertStatus(t, rr, http.StatusOK)
	response := decodeAPIData[struct {
		Platform       string   `json:"platform"`
		Deleted        bool     `json:"deleted"`
		AffectedPodIDs []string `json:"affectedPodIds"`
	}](t, rr.Body.Bytes())
	if response.Platform != "xdr" || !response.Deleted || len(response.AffectedPodIDs) != 1 {
		t.Fatalf("delete response = %+v", response)
	}
	if _, err := e.store.GetPlatformConfig("xdr"); err != repo.ErrNotFound {
		t.Fatalf("deleted platform error = %v, want ErrNotFound", err)
	}
	summaries, err := e.store.ListUserPlatformCredentials(eCipher(t), user.HumanUserID)
	if err != nil || len(summaries) != 0 {
		t.Fatalf("credentials after platform delete = %+v, %v", summaries, err)
	}
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{
		Action: "platform_config.delete", Target: "xdr", Limit: 10,
	})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("platform delete audit = %+v/%d, %v", entries, total, err)
	}
}

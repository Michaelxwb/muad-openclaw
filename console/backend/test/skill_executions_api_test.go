package test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSkillExecutionInternalAPI_InsertsAndListsMinimalRecords(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)

	body := fmt.Sprintf(`{"executionId":"exec-1","agentId":"alice",`+
		`"skillName":"xdr-query","skillScope":"public","startedAt":"%s"}`,
		started.Format(time.RFC3339))
	rr := doInternalSkillExecution(env, token, body)
	assertStatus(t, rr, http.StatusOK)
	if response := rr.Body.String(); strings.Contains(response, "status") ||
		strings.Contains(response, "progress") || strings.Contains(response, "durationMs") {
		t.Fatalf("minimal response leaked removed fields: %s", response)
	}

	duplicate := strings.Replace(body, `"xdr-query"`, `"other-skill"`, 1)
	rr = doInternalSkillExecution(env, token, duplicate)
	assertStatus(t, rr, http.StatusOK)
	stored := decodeAPIData[repoExecutionView](t, rr.Body.Bytes())
	if stored.SkillName != "xdr-query" {
		t.Fatalf("duplicate execution_id was not idempotent: %+v", stored)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions?humanUserId="+alice.HumanUserID, "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[executionPage](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ExecutionID != "exec-1" ||
		list.Items[0].HumanUserID != alice.HumanUserID || !list.Items[0].StartedAt.Equal(started) {
		t.Fatalf("Skill execution list = %+v", list)
	}
}

func TestSkillExecutionInternalAPI_RejectsCrossPodAgent(t *testing.T) {
	env := newTestEnv(t)
	tokenA := createPodWithToken(t, env, "pod-a")
	createPodWithToken(t, env, "pod-b")
	createTestHumanUser(t, env.store, "pod-b", "alice", repo.HumanUserStatusActive)

	rr := doInternalSkillExecution(env, tokenA,
		`{"executionId":"exec-1","agentId":"alice","skillName":"xdr-query","skillScope":"public"}`)
	assertStatus(t, rr, http.StatusNotFound)
}

func TestSkillExecutionInternalAPI_RejectsCrossPodExecutionIDReuse(t *testing.T) {
	env := newTestEnv(t)
	tokenA := createPodWithToken(t, env, "pod-a")
	tokenB := createPodWithToken(t, env, "pod-b")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestHumanUser(t, env.store, "pod-b", "bob", repo.HumanUserStatusActive)

	// pod-a claims exec-shared first.
	rr := doInternalSkillExecution(env, tokenA,
		`{"executionId":"exec-shared","agentId":"alice","skillName":"xdr-query","skillScope":"public"}`)
	assertStatus(t, rr, http.StatusOK)

	// pod-b reuses the same executionId: the pre-existing row is owned by
	// pod-a's user, so the upsert must be rejected instead of returning the
	// foreign record (INSERT OR IGNORE would leak it).
	rr = doInternalSkillExecution(env, tokenB,
		`{"executionId":"exec-shared","agentId":"bob","skillName":"mss-report","skillScope":"private"}`)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"code":40902`) {
		t.Fatalf("cross-Pod reuse response = %s", rr.Body.String())
	}
	stored, err := env.store.GetSkillExecutionRecord("exec-shared")
	if err != nil || stored.HumanUserID != alice.HumanUserID || stored.PodID != "pod-a" {
		t.Fatalf("cross-Pod reuse mutated the record: %+v, %v", stored, err)
	}

	// The same Pod/user replaying its own executionId stays idempotent.
	rr = doInternalSkillExecution(env, tokenA,
		`{"executionId":"exec-shared","agentId":"alice","skillName":"xdr-query","skillScope":"public"}`)
	assertStatus(t, rr, http.StatusOK)
}

func TestSkillExecutionRuntimeFailureDoesNotWriteOperationAudit(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := doInternalSkillExecution(env, token,
		`{"executionId":"exec-audit","agentId":"alice","skillName":"xdr-query","skillScope":"public"}`)
	assertStatus(t, rr, http.StatusOK)
	entries, total, err := env.store.QueryAuditFiltered(repo.AuditFilter{Action: "skill.execution"})
	if err != nil || total != 0 || len(entries) != 0 {
		t.Fatalf("Skill execution leaked into operation audit = %+v/%d, %v", entries, total, err)
	}
}

func TestSkillExecutionAPIListsFiltersAndDetails(t *testing.T) {
	env := newTestEnv(t)
	createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	seedSkillExecution(t, env, alice, "exec-detail", "web-tools-guide", repo.SkillScopePublic, started)

	query := url.Values{
		"humanUserId": {alice.HumanUserID}, "skillName": {"web-tools"},
		"scope":       {repo.SkillScopePublic},
		"startedFrom": {started.Add(-time.Second).Format(time.RFC3339)},
		"startedTo":   {started.Add(time.Second).Format(time.RFC3339)},
	}
	rr := env.do(http.MethodGet, "/api/v1/skill-executions?"+query.Encode(), "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[executionPage](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].SkillName != "web-tools-guide" {
		t.Fatalf("filtered executions = %+v", list)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/exec-detail", "")
	assertStatus(t, rr, http.StatusOK)
	detail := decodeAPIData[repoExecutionView](t, rr.Body.Bytes())
	if detail.ExecutionID != "exec-detail" || detail.SkillScope != repo.SkillScopePublic {
		t.Fatalf("execution detail = %+v", detail)
	}

	for _, path := range []string{
		"/api/v1/skill-executions?startedFrom=not-a-time",
		"/api/v1/skill-executions?scope=unknown",
	} {
		rr = env.do(http.MethodGet, path, "")
		assertStatus(t, rr, http.StatusBadRequest)
	}
}

func TestSkillExecutionAPIFuzzySearchesIdentityFields(t *testing.T) {
	env := newTestEnv(t)
	createPodWithToken(t, env, "pod-a")
	createPodWithToken(t, env, "pod-b")
	user := createTestHumanUser(t, env.store, "pod-a", "alice-agent", repo.HumanUserStatusActive)
	other := createTestHumanUser(t, env.store, "pod-b", "bob-agent", repo.HumanUserStatusActive)
	seedSkillExecution(t, env, user, "exec-search", "web-tools-guide", repo.SkillScopePublic, time.Now().UTC())
	seedSkillExecution(t, env, other, "exec-other", "mss-report", repo.SkillScopePrivate, time.Now().UTC())

	for _, query := range []string{"web-tools", "pod-a", user.HumanUserID, "alice-agent"} {
		rr := env.do(http.MethodGet, "/api/v1/skill-executions?q="+url.QueryEscape(query), "")
		assertStatus(t, rr, http.StatusOK)
		list := decodeAPIData[executionPage](t, rr.Body.Bytes())
		if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ExecutionID != "exec-search" {
			t.Fatalf("query %q returned %+v", query, list)
		}
	}
	rr := env.do(http.MethodGet, "/api/v1/skill-executions?q=does-not-exist", "")
	assertStatus(t, rr, http.StatusOK)
	empty := decodeAPIData[struct {
		Total int `json:"total"`
	}](t, rr.Body.Bytes())
	if empty.Total != 0 {
		t.Fatalf("unmatched fuzzy query returned %d rows", empty.Total)
	}
}

func TestSkillExecutionAPIPaginatesStablePageSizes(t *testing.T) {
	env := newTestEnv(t)
	createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	seedSkillExecutions(t, env, alice, 11)

	first := listExecutionPage(t, env, 1, 10)
	second := listExecutionPage(t, env, 2, 10)
	if first.Total != 11 || len(first.Items) != 10 || len(second.Items) != 1 ||
		first.Items[9].ExecutionID == second.Items[0].ExecutionID {
		t.Fatalf("unstable execution pages: first=%+v second=%+v", first, second)
	}
	for _, size := range []int{10, 20, 50, 100} {
		page := listExecutionPage(t, env, 1, size)
		if page.PageSize != size || page.Total != 11 {
			t.Fatalf("page size %d response = %+v", size, page)
		}
	}
}

type repoExecutionView struct {
	ExecutionID string    `json:"executionId"`
	PodID       string    `json:"podId"`
	HumanUserID string    `json:"humanUserId"`
	AgentID     string    `json:"agentId"`
	SkillName   string    `json:"skillName"`
	SkillScope  string    `json:"skillScope"`
	StartedAt   time.Time `json:"startedAt"`
	CreatedAt   time.Time `json:"createdAt"`
}

type executionPage struct {
	Items    []repoExecutionView `json:"items"`
	Total    int                 `json:"total"`
	PageSize int                 `json:"pageSize"`
}

func seedSkillExecution(
	t *testing.T, env *testEnv, user repo.HumanUser, executionID, skillName, scope string, started time.Time,
) {
	t.Helper()
	_, err := env.store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: executionID, PodID: user.PodID, HumanUserID: user.HumanUserID,
		AgentID: user.AgentID, SkillName: skillName, SkillScope: scope, StartedAt: started,
	})
	if err != nil {
		t.Fatalf("seed execution %s: %v", executionID, err)
	}
}

func seedSkillExecutions(t *testing.T, env *testEnv, user repo.HumanUser, count int) {
	t.Helper()
	started := time.Now().UTC().Add(-time.Hour)
	for index := 0; index < count; index++ {
		seedSkillExecution(t, env, user, fmt.Sprintf("exec-%02d", index),
			"xdr-query", repo.SkillScopePublic, started.Add(time.Duration(index)*time.Second))
	}
}

func listExecutionPage(t *testing.T, env *testEnv, page, pageSize int) executionPage {
	t.Helper()
	path := fmt.Sprintf("/api/v1/skill-executions?page=%d&pageSize=%d", page, pageSize)
	rr := env.do(http.MethodGet, path, "")
	assertStatus(t, rr, http.StatusOK)
	return decodeAPIData[executionPage](t, rr.Body.Bytes())
}

func doInternalSkillExecution(env *testEnv, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/skill-executions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	env.h.ServeHTTP(recorder, req)
	return recorder
}

// --- Skill execution trace API (TASK-002) ---

type skillTraceInterfaceView struct {
	Host   string `json:"host"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Count  int    `json:"count"`
}

type skillTraceMetricsView struct {
	RequestCount    int                       `json:"requestCount"`
	ErrorCount      int                       `json:"errorCount"`
	DistinctHosts   int                       `json:"distinctHosts"`
	MaxBurstPer10s  int                       `json:"maxBurstPer10s"`
	TopInterfaces   []skillTraceInterfaceView `json:"topInterfaces"`
	DetailTruncated bool                      `json:"detailTruncated"`
	Aborted         bool                      `json:"aborted"`
	AbortReason     string                    `json:"abortReason"`
	AbortInterface  string                    `json:"abortInterface"`
	AbortCount      *int                      `json:"abortCount"`
}

type skillTraceEventView struct {
	EventID    string    `json:"eventId"`
	Seq        int       `json:"seq"`
	OccurredAt time.Time `json:"occurredAt"`
	Kind       string    `json:"kind"`
	Status     string    `json:"status"`
	DurationMS *int      `json:"durationMs"`
	Summary    string    `json:"summary"`
	Detail     string    `json:"detail"`
}

type skillExecutionTraceView struct {
	Metrics *skillTraceMetricsView `json:"metrics"`
	Events  []skillTraceEventView  `json:"events"`
}

type skillExecutionStatView struct {
	SkillName       string                    `json:"skillName"`
	SkillScope      string                    `json:"skillScope"`
	HumanUserID     string                    `json:"humanUserId"`
	HumanUserName   string                    `json:"humanUserName"`
	Executions      int                       `json:"executions"`
	AbortedCount    int                       `json:"abortedCount"`
	FlaggedCount    int                       `json:"flaggedCount"`
	MaxRequests     int                       `json:"maxRequests"`
	ErrorRate       float64                   `json:"errorRate"`
	TopInterfaces   []skillTraceInterfaceView `json:"topInterfaces"`
	LastExecutionAt time.Time                 `json:"lastExecutionAt"`
}

type skillExecutionStatsView struct {
	Items []skillExecutionStatView `json:"items"`
}

func TestSkillExecutionTraceWritesReadsAndIsIdempotent(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillTraceExecution(t, env, token, "exec-trace", "alice", "xdr-query", repo.SkillScopePrivate)

	body := `{"agentId":"alice","metrics":{"requestCount":3,"errorCount":1,` +
		`"distinctHosts":1,"maxBurstPer10s":2,` +
		`"topInterfaces":[{"host":"mssw","method":"GET","path":"/api/v1/targets/{id}","count":3}],` +
		`"detailTruncated":true,"aborted":true,"abortReason":"request_limit",` +
		`"abortInterface":"GET mssw /api/v1/targets/{id}","abortCount":1001},` +
		`"events":[` +
		`{"eventId":"ev-2","seq":2,"occurredAt":"2026-10-17T06:02:03Z","kind":"http",` +
		`"status":"error","durationMs":310,"summary":"GET mssw /targets","detail":"status=500"},` +
		`{"eventId":"ev-1","seq":1,"occurredAt":"2026-10-17T06:02:01Z","kind":"exec",` +
		`"status":"ok","durationMs":12400,"summary":"python3 run.py"}]}`

	rr := doInternalSkillTrace(env, token, "exec-trace", body)
	assertStatus(t, rr, http.StatusOK)
	write := decodeAPIData[struct {
		StoredEvents int  `json:"storedEvents"`
		Aborted      bool `json:"aborted"`
	}](t, rr.Body.Bytes())
	if write.StoredEvents != 2 || !write.Aborted {
		t.Fatalf("trace write response = %+v", write)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/exec-trace/trace", "")
	assertStatus(t, rr, http.StatusOK)
	trace := decodeAPIData[skillExecutionTraceView](t, rr.Body.Bytes())
	if trace.Metrics == nil {
		t.Fatal("trace response missing metrics")
	}
	if trace.Metrics.RequestCount != 3 || trace.Metrics.ErrorCount != 1 ||
		trace.Metrics.DistinctHosts != 1 || trace.Metrics.MaxBurstPer10s != 2 ||
		!trace.Metrics.Aborted ||
		trace.Metrics.AbortReason != "request_limit" ||
		trace.Metrics.AbortInterface != "GET mssw /api/v1/targets/{id}" ||
		trace.Metrics.AbortCount == nil || *trace.Metrics.AbortCount != 1001 ||
		!trace.Metrics.DetailTruncated {
		t.Fatalf("trace metrics = %+v", trace.Metrics)
	}
	if len(trace.Metrics.TopInterfaces) != 1 || trace.Metrics.TopInterfaces[0].Host != "mssw" ||
		trace.Metrics.TopInterfaces[0].Path != "/api/v1/targets/{id}" {
		t.Fatalf("trace top interfaces = %+v", trace.Metrics.TopInterfaces)
	}
	if len(trace.Events) != 2 || trace.Events[0].Seq != 1 || trace.Events[1].Seq != 2 ||
		trace.Events[0].Kind != repo.SkillTraceKindExec || trace.Events[0].Summary != "python3 run.py" ||
		trace.Events[0].DurationMS == nil || *trace.Events[0].DurationMS != 12400 ||
		trace.Events[1].Status != repo.SkillTraceStatusError || trace.Events[1].Detail != "status=500" {
		t.Fatalf("trace events = %+v", trace.Events)
	}

	// A retried upload stores only new events; the non-aborted replay snapshot
	// must not clear the earlier abort flag.
	replay := `{"agentId":"alice","metrics":{"requestCount":3,"errorCount":0},` +
		`"events":[{"eventId":"ev-1","seq":1,"kind":"exec","status":"ok","summary":"python3 run.py"}]}`
	rr = doInternalSkillTrace(env, token, "exec-trace", replay)
	assertStatus(t, rr, http.StatusOK)
	write = decodeAPIData[struct {
		StoredEvents int  `json:"storedEvents"`
		Aborted      bool `json:"aborted"`
	}](t, rr.Body.Bytes())
	if write.StoredEvents != 0 || !write.Aborted {
		t.Fatalf("trace replay response = %+v", write)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/exec-trace/trace", "")
	assertStatus(t, rr, http.StatusOK)
	replayed := decodeAPIData[skillExecutionTraceView](t, rr.Body.Bytes())
	if replayed.Metrics == nil || !replayed.Metrics.Aborted || len(replayed.Events) != 2 {
		t.Fatalf("replayed trace lost events or abort flag: %+v", replayed)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/missing/trace", "")
	assertStatus(t, rr, http.StatusNotFound)
	if !strings.Contains(rr.Body.String(), `"code":40901`) {
		t.Fatalf("missing execution trace response = %s", rr.Body.String())
	}
}

func TestSkillExecutionTraceRejectsCrossPodOwner(t *testing.T) {
	env := newTestEnv(t)
	tokenA := createPodWithToken(t, env, "pod-a")
	tokenB := createPodWithToken(t, env, "pod-b")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createTestHumanUser(t, env.store, "pod-b", "bob", repo.HumanUserStatusActive)
	createSkillTraceExecution(t, env, tokenA, "exec-owned", "alice", "xdr-query", repo.SkillScopePrivate)

	crossPod := `{"agentId":"bob","metrics":{"requestCount":1},"events":[]}`
	rr := doInternalSkillTrace(env, tokenB, "exec-owned", crossPod)
	assertStatus(t, rr, http.StatusConflict)
	if !strings.Contains(rr.Body.String(), `"code":40535`) {
		t.Fatalf("cross-Pod trace response = %s", rr.Body.String())
	}

	wrongAgent := `{"agentId":"bob","metrics":{"requestCount":1},"events":[]}`
	rr = doInternalSkillTrace(env, tokenA, "exec-owned", wrongAgent)
	assertStatus(t, rr, http.StatusConflict)

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/exec-owned/trace", "")
	assertStatus(t, rr, http.StatusOK)
	trace := decodeAPIData[skillExecutionTraceView](t, rr.Body.Bytes())
	if trace.Metrics != nil || len(trace.Events) != 0 {
		t.Fatalf("rejected cross-Pod write leaked data: %+v", trace)
	}

	unknown := `{"agentId":"` + alice.AgentID + `","metrics":{"requestCount":1},"events":[]}`
	rr = doInternalSkillTrace(env, tokenA, "exec-unknown", unknown)
	assertStatus(t, rr, http.StatusNotFound)
}

func TestSkillExecutionTraceRejectsInvalidPayloads(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	createSkillTraceExecution(t, env, token, "exec-invalid", "alice", "xdr-query", repo.SkillScopePrivate)

	cases := []struct {
		name string
		body string
	}{
		{"missing metrics", `{"agentId":"alice"}`},
		{"negative metrics", `{"agentId":"alice","metrics":{"requestCount":-1}}`},
		{"negative duration", `{"agentId":"alice","metrics":{"requestCount":1},` +
			`"events":[{"eventId":"ev-1","seq":1,"kind":"exec","status":"ok",` +
			`"durationMs":-5,"summary":"x"}]}`},
		{"bad event kind", `{"agentId":"alice","metrics":{"requestCount":1},` +
			`"events":[{"eventId":"ev-1","seq":1,"kind":"request","status":"ok","summary":"x"}]}`},
		{"oversized detail", `{"agentId":"alice","metrics":{"requestCount":1},` +
			`"events":[{"eventId":"ev-1","seq":1,"kind":"exec","status":"ok",` +
			`"summary":"x","detail":"` + strings.Repeat("a", 2049) + `"}]}`},
		{"too many events", tooManyTraceEventsBody(2001)},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			rr := doInternalSkillTrace(env, token, "exec-invalid", tt.body)
			assertStatus(t, rr, http.StatusBadRequest)
			if !strings.Contains(rr.Body.String(), `"code":40534`) {
				t.Fatalf("invalid trace response = %s", rr.Body.String())
			}
		})
	}

	rr := env.do(http.MethodGet, "/api/v1/skill-executions/exec-invalid/trace", "")
	assertStatus(t, rr, http.StatusOK)
	trace := decodeAPIData[skillExecutionTraceView](t, rr.Body.Bytes())
	if trace.Metrics != nil || len(trace.Events) != 0 {
		t.Fatalf("rejected payload persisted partial trace: %+v", trace)
	}
}

func TestSkillExecutionTraceStatsGroupsPrivateSkillPerUser(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, env.store, "pod-a", "bob", repo.HumanUserStatusActive)
	createSkillTraceExecution(t, env, token, "exec-a", "alice", "xdr-query", repo.SkillScopePrivate)
	createSkillTraceExecution(t, env, token, "exec-b", "bob", "xdr-query", repo.SkillScopePrivate)

	postTraceMetrics(t, env, token, "exec-a", "alice",
		`{"requestCount":1001,"errorCount":37,"aborted":true,"abortReason":"request_limit",`+
			`"topInterfaces":[{"host":"mssw","method":"GET","path":"/api/v1/targets/{id}","count":1001}]}`)
	postTraceMetrics(t, env, token, "exec-b", "bob", `{"requestCount":20,"errorCount":1}`)

	rr := env.do(http.MethodGet, "/api/v1/skill-executions/stats?window=7d&scope=private", "")
	assertStatus(t, rr, http.StatusOK)
	stats := decodeAPIData[skillExecutionStatsView](t, rr.Body.Bytes())
	if len(stats.Items) != 2 {
		t.Fatalf("stats rows = %d, want 2 (same private Skill split per user): %+v",
			len(stats.Items), stats.Items)
	}
	byUser := map[string]skillExecutionStatView{}
	for _, item := range stats.Items {
		if item.SkillName != "xdr-query" || item.SkillScope != repo.SkillScopePrivate ||
			item.Executions != 1 || item.LastExecutionAt.IsZero() {
			t.Fatalf("unexpected stats row: %+v", item)
		}
		byUser[item.HumanUserID] = item
	}
	aliceRow, ok := byUser[alice.HumanUserID]
	if !ok || aliceRow.HumanUserName != "alice" || aliceRow.MaxRequests != 1001 ||
		aliceRow.AbortedCount != 1 || aliceRow.FlaggedCount != 1 {
		t.Fatalf("alice stats = %+v", aliceRow)
	}
	if len(aliceRow.TopInterfaces) != 1 || aliceRow.TopInterfaces[0].Host != "mssw" ||
		aliceRow.TopInterfaces[0].Count != 1001 {
		t.Fatalf("alice top interfaces = %+v", aliceRow.TopInterfaces)
	}
	if rate := aliceRow.ErrorRate; rate < 0.0369 || rate > 0.037 {
		t.Fatalf("alice error rate = %f, want ~0.037", rate)
	}
	bobRow, ok := byUser[bob.HumanUserID]
	if !ok || bobRow.HumanUserName != "bob" || bobRow.MaxRequests != 20 ||
		bobRow.AbortedCount != 0 || bobRow.FlaggedCount != 0 {
		t.Fatalf("bob stats = %+v", bobRow)
	}
	if rate := bobRow.ErrorRate; rate != 0.05 {
		t.Fatalf("bob error rate = %f, want 0.05", rate)
	}

	rr = env.do(http.MethodGet,
		"/api/v1/skill-executions/stats?window=7d&humanUserId="+bob.HumanUserID, "")
	assertStatus(t, rr, http.StatusOK)
	filtered := decodeAPIData[skillExecutionStatsView](t, rr.Body.Bytes())
	if len(filtered.Items) != 1 || filtered.Items[0].HumanUserID != bob.HumanUserID {
		t.Fatalf("humanUserId filtered stats = %+v", filtered.Items)
	}

	for _, query := range []string{
		"window=2d", "limit=0", "limit=201", "scope=unknown",
	} {
		rr = env.do(http.MethodGet, "/api/v1/skill-executions/stats?"+query, "")
		assertStatus(t, rr, http.StatusBadRequest)
		if !strings.Contains(rr.Body.String(), `"code":40509`) {
			t.Fatalf("invalid stats query %q response = %s", query, rr.Body.String())
		}
	}
}

func createSkillTraceExecution(
	t *testing.T, env *testEnv, token, executionID, agentID, skillName, scope string,
) {
	t.Helper()
	body := fmt.Sprintf(`{"executionId":%q,"agentId":%q,"skillName":%q,"skillScope":%q,"startedAt":%q}`,
		executionID, agentID, skillName, scope, time.Now().UTC().Format(time.RFC3339))
	rr := doInternalSkillExecution(env, token, body)
	assertStatus(t, rr, http.StatusOK)
}

func doInternalSkillTrace(
	env *testEnv, token, executionID, body string,
) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost,
		"/internal/v1/skill-executions/"+executionID+"/trace", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	env.h.ServeHTTP(recorder, req)
	return recorder
}

func postTraceMetrics(t *testing.T, env *testEnv, token, executionID, agentID, metrics string) {
	t.Helper()
	body := fmt.Sprintf(`{"agentId":%q,"metrics":%s,"events":[]}`, agentID, metrics)
	rr := doInternalSkillTrace(env, token, executionID, body)
	assertStatus(t, rr, http.StatusOK)
}

func tooManyTraceEventsBody(count int) string {
	var builder strings.Builder
	builder.WriteString(`{"agentId":"alice","metrics":{"requestCount":1},"events":[`)
	for index := 0; index < count; index++ {
		if index > 0 {
			builder.WriteString(",")
		}
		fmt.Fprintf(&builder,
			`{"eventId":"ev-%d","seq":%d,"kind":"exec","status":"ok","summary":"x"}`,
			index+1, index+1)
	}
	builder.WriteString(`]}`)
	return builder.String()
}

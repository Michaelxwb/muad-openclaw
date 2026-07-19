package test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSkillExecutionInternalAPI_UpsertsAndListsRedactedRecords(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)

	body := `{"executionId":"exec-1","agentId":"alice","skillName":"xdr-query",` +
		`"skillScope":"public","skillVersion":"1.0.0","status":"running",` +
		`"progress":[{"type":"progress","stage":"query","text":"` + strings.Repeat("a", 300) + `"}],` +
		`"inputSummary":"` + strings.Repeat("b", 700) + `"}`
	rr := doInternalSkillExecution(env, token, body)
	assertStatus(t, rr, http.StatusOK)

	body = `{"executionId":"exec-1","agentId":"alice","skillName":"xdr-query",` +
		`"skillScope":"public","skillVersion":"1.0.0","status":"succeeded",` +
		`"durationMs":123,"outputSummary":"done"}`
	rr = doInternalSkillExecution(env, token, body)
	assertStatus(t, rr, http.StatusOK)

	rr = env.do(http.MethodGet,
		"/api/v1/skill-executions?humanUserId="+alice.HumanUserID+"&status=succeeded", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []struct {
			ExecutionID   string `json:"executionId"`
			Status        string `json:"status"`
			HumanUserID   string `json:"humanUserId"`
			InputSummary  string `json:"inputSummary"`
			OutputSummary string `json:"outputSummary"`
			DurationMS    int64  `json:"durationMs"`
		} `json:"items"`
		Total int `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ExecutionID != "exec-1" ||
		list.Items[0].Status != repo.SkillExecutionSucceeded ||
		list.Items[0].HumanUserID != alice.HumanUserID || list.Items[0].DurationMS != 123 {
		t.Fatalf("Skill execution list = %+v", list)
	}
	if len(list.Items[0].InputSummary) > 512 || list.Items[0].OutputSummary != "done" {
		t.Fatalf("Skill execution summaries were not sanitized: %+v", list.Items[0])
	}
}

func TestSkillExecutionInternalAPI_RejectsCrossPodAgent(t *testing.T) {
	env := newTestEnv(t)
	tokenA := createPodWithToken(t, env, "pod-a")
	createPodWithToken(t, env, "pod-b")
	createTestHumanUser(t, env.store, "pod-b", "alice", repo.HumanUserStatusActive)

	rr := doInternalSkillExecution(env, tokenA,
		`{"executionId":"exec-1","agentId":"alice","skillName":"xdr-query",`+
			`"skillScope":"public","status":"running"}`)
	assertStatus(t, rr, http.StatusNotFound)
}

func TestSkillExecutionRuntimeFailureDoesNotWriteOperationAudit(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := doInternalSkillExecution(env, token,
		`{"executionId":"exec-fail","agentId":"alice","skillName":"xdr-query",`+
			`"skillScope":"public","status":"failed","errorCode":"runtime","errorMessage":"boom"}`)
	assertStatus(t, rr, http.StatusOK)
	entries, total, err := env.store.QueryAuditFiltered(repo.AuditFilter{Action: "skill.execution.fail"})
	if err != nil || total != 0 || len(entries) != 0 {
		t.Fatalf("Skill execution leaked into operation audit = %+v/%d, %v", entries, total, err)
	}
}

func TestSkillExecutionAPIListsFiltersDetailsAndRedacts(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	started := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	postExecutionLifecycle(t, env, token, started)

	query := url.Values{
		"humanUserId": {alice.HumanUserID}, "skillName": {"web-tools"},
		"scope": {repo.SkillScopePublic}, "entryType": {repo.SkillEntryTraditionalPrompt},
		"status":      {repo.SkillExecutionSucceeded},
		"startedFrom": {started.Add(-time.Second).Format(time.RFC3339)},
		"startedTo":   {started.Add(time.Second).Format(time.RFC3339)},
	}
	rr := env.do(http.MethodGet, "/api/v1/skill-executions?"+query.Encode(), "")
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), "progressJson") || strings.Contains(rr.Body.String(), "secret-token") {
		t.Fatalf("list leaked progress or secret: %s", rr.Body.String())
	}
	list := decodeAPIData[struct {
		Items []repoExecutionView `json:"items"`
		Total int                 `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].EntryType != repo.SkillEntryTraditionalPrompt {
		t.Fatalf("filtered executions = %+v", list)
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions/exec-detail", "")
	assertStatus(t, rr, http.StatusOK)
	detail := decodeAPIData[repoExecutionView](t, rr.Body.Bytes())
	if detail.EventSeq != 2 || detail.LastToolName != "browser" || detail.TerminalReason != "agent_end" ||
		!strings.Contains(detail.ProgressJSON, "fetched") || strings.Contains(rr.Body.String(), "secret-token") {
		t.Fatalf("execution detail = %+v, body=%s", detail, rr.Body.String())
	}

	rr = env.do(http.MethodGet, "/api/v1/skill-executions?startedFrom=not-a-time", "")
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestSkillExecutionAPIFuzzySearchesIdentityFields(t *testing.T) {
	env := newTestEnv(t)
	createPodWithToken(t, env, "pod-a")
	createPodWithToken(t, env, "pod-b")
	user := createTestHumanUser(t, env.store, "pod-a", "alice-agent", repo.HumanUserStatusActive)
	other := createTestHumanUser(t, env.store, "pod-b", "bob-agent", repo.HumanUserStatusActive)
	_, err := env.store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-search", PodID: "pod-a", HumanUserID: user.HumanUserID,
		AgentID: user.AgentID, SkillName: "web-tools-guide", SkillScope: repo.SkillScopePublic,
		Status: repo.SkillExecutionSucceeded, EventSeq: 1, StartedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("seed searchable execution: %v", err)
	}
	_, err = env.store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
		ExecutionID: "exec-other", PodID: "pod-b", HumanUserID: other.HumanUserID,
		AgentID: other.AgentID, SkillName: "mss-report", SkillScope: repo.SkillScopePrivate,
		Status: repo.SkillExecutionSucceeded, EventSeq: 1, StartedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("seed comparison execution: %v", err)
	}

	for _, query := range []string{"web-tools", "pod-a", user.HumanUserID, "alice-agent"} {
		rr := env.do(http.MethodGet, "/api/v1/skill-executions?q="+url.QueryEscape(query), "")
		assertStatus(t, rr, http.StatusOK)
		list := decodeAPIData[struct {
			Items []repoExecutionView `json:"items"`
			Total int                 `json:"total"`
		}](t, rr.Body.Bytes())
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
	ExecutionID    string `json:"executionId"`
	EntryType      string `json:"entryType"`
	EventSeq       int64  `json:"eventSeq"`
	LastToolName   string `json:"lastToolName"`
	TerminalReason string `json:"terminalReason"`
	ProgressJSON   string `json:"progressJson"`
}

type executionPage struct {
	Items    []repoExecutionView `json:"items"`
	Total    int                 `json:"total"`
	PageSize int                 `json:"pageSize"`
}

func postExecutionLifecycle(t *testing.T, env *testEnv, token string, started time.Time) {
	t.Helper()
	base := `"executionId":"exec-detail","eventSeq":%d,"agentId":"alice",` +
		`"skillName":"web-tools-guide","skillScope":"public","skillVersion":"1.0.0",` +
		`"entryType":"traditional-prompt","activationMode":"tool","status":"%s",` +
		`"startedAt":"%s","progress":[{"stage":"fetch","text":"token=secret-token %s"}],` +
		`"inputSummary":"authorization: Bearer secret-token","lastToolName":"browser",` +
		`"terminalReason":"%s"`
	running := fmt.Sprintf("{"+base+"}", 1, repo.SkillExecutionRunning, started.Format(time.RFC3339), "started", "")
	assertStatus(t, doInternalSkillExecution(env, token, running), http.StatusOK)
	done := fmt.Sprintf("{"+base+"}", 2, repo.SkillExecutionSucceeded, started.Format(time.RFC3339), "fetched", "agent_end")
	assertStatus(t, doInternalSkillExecution(env, token, done), http.StatusOK)
}

func seedSkillExecutions(t *testing.T, env *testEnv, user repo.HumanUser, count int) {
	t.Helper()
	started := time.Now().UTC().Add(-time.Hour)
	for index := 0; index < count; index++ {
		_, err := env.store.UpsertSkillExecutionRecord(repo.SkillExecutionRecord{
			ExecutionID: fmt.Sprintf("exec-%02d", index), PodID: "pod-a", HumanUserID: user.HumanUserID,
			AgentID: user.AgentID, SkillName: "xdr-query", SkillScope: repo.SkillScopePublic,
			Status: repo.SkillExecutionSucceeded, EventSeq: 1, StartedAt: started.Add(time.Duration(index) * time.Second),
		})
		if err != nil {
			t.Fatalf("seed execution %d: %v", index, err)
		}
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

func TestSkillExecutionInternalAPI_RejectsInvalidStatusFilter(t *testing.T) {
	env := newTestEnv(t)
	rr := env.do(http.MethodGet, "/api/v1/skill-executions?status=unknown", "")
	assertStatus(t, rr, http.StatusBadRequest)
	var envelope struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &envelope); err != nil || envelope.Code == 0 {
		t.Fatalf("invalid status response = %s, %v", rr.Body.String(), err)
	}
}

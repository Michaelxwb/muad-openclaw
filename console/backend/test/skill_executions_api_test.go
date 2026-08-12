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

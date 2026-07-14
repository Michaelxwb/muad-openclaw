package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func TestSkillExecutionInternalAPI_FailedRecordWritesAudit(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)

	rr := doInternalSkillExecution(env, token,
		`{"executionId":"exec-fail","agentId":"alice","skillName":"xdr-query",`+
			`"skillScope":"public","status":"failed","errorCode":"runtime","errorMessage":"boom"}`)
	assertStatus(t, rr, http.StatusOK)
	entries, total, err := env.store.QueryAuditFiltered(repo.AuditFilter{Action: "skill.execution.fail"})
	if err != nil || total != 1 || len(entries) != 1 {
		t.Fatalf("Skill execution fail audit = %+v/%d, %v", entries, total, err)
	}
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

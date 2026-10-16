package test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// LongTaskControlE03 [integration] 真实边界：httptest → 真实 Store → fake Driver：
// 未登录、伪造 Pod/Agent、越界 taskId、畸形请求均被拒绝且零运行调用；错误包络和
// 审计脱敏正确。

func seedE03LongTask(t *testing.T, e *testEnv, podID, humanUserID, taskID, status string) {
	t.Helper()
	now := time.Now().UTC()
	err := e.store.UpsertLongTaskTasks([]repo.LongTaskTask{{
		TaskID: taskID, PodID: podID, HumanUserID: humanUserID,
		PoolKey: "agent:alice:wecom:direct:wx-1", AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", SkillRoot: "/skills/xdr-query",
		PoolQueued: 0, PoolRunning: 1, PoolLimit: 2,
		Status: status, StateRevision: 1,
		SubmittedAt: now, UpdatedAt: now, LastSeenAt: now,
	}})
	if err != nil {
		t.Fatalf("seed long task %s: %v", taskID, err)
	}
}

func cancelExecCalls(e *testEnv) [][]string {
	e.drv.mu.Lock()
	defer e.drv.mu.Unlock()
	calls := [][]string{}
	for _, call := range e.drv.execCalls {
		if strings.Contains(strings.Join(call.cmd, " "), "muad.long-task.cancel") {
			calls = append(calls, call.cmd)
		}
	}
	return calls
}

func decodeErrorEnvelope(t *testing.T, body []byte) struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	Detail    string `json:"detail"`
	RequestID string `json:"requestId"`
} {
	t.Helper()
	var envelope struct {
		Code      int    `json:"code"`
		Message   string `json:"message"`
		Detail    string `json:"detail"`
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode error envelope: %v body=%s", err, body)
	}
	return envelope
}

func decodeCancelEnvelope(t *testing.T, body []byte) struct {
	Code int `json:"code"`
	Data struct {
		TaskID        string `json:"taskId"`
		Outcome       string `json:"outcome"`
		Status        string `json:"status"`
		StateRevision int64  `json:"stateRevision"`
	} `json:"data"`
} {
	t.Helper()
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			TaskID        string `json:"taskId"`
			Outcome       string `json:"outcome"`
			Status        string `json:"status"`
			StateRevision int64  `json:"stateRevision"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode cancel envelope: %v body=%s", err, body)
	}
	return envelope
}

func TestLongTaskControlE03CancelRouteRejectsUntrustedRequestsWithoutRunCalls(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, testPodBody)
	user := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	seedE03LongTask(t, e, pod.PodID, user.HumanUserID, "task-live", repo.LongTaskRunning)
	seedE03LongTask(t, e, pod.PodID, user.HumanUserID, "task-done", repo.LongTaskSucceeded)
	e.srv.LongTaskCapabilities().Update(pod.PodID, gateway.LongTaskCancelCapability{Available: true, Version: 1})

	// 未登录：401，零运行调用。
	anon := httptest.NewRequest(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", nil)
	anonRR := httptest.NewRecorder()
	e.h.ServeHTTP(anonRR, anon)
	if anonRR.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated cancel status = %d, want 401", anonRR.Code)
	}

	// 伪造 Pod/Agent 或畸形请求体：400，零运行调用。
	for _, body := range []string{`{"podId":"other-pod","agentId":"bob"}`, `["x"]`, `{"x":1}`, `not-json`} {
		rr := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", body)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("malformed body %q status = %d, want 400", body, rr.Code)
		}
		if envelope := decodeErrorEnvelope(t, rr.Body.Bytes()); envelope.Code != errcode.InvalidRequestBody {
			t.Fatalf("malformed body %q code = %d, want %d", body, envelope.Code, errcode.InvalidRequestBody)
		}
	}
	// 越界 taskId：404，零运行调用。
	rr := e.do(http.MethodPost, "/api/v1/long-tasks/task-unknown/cancel", "")
	if rr.Code != http.StatusNotFound {
		t.Fatalf("unknown task status = %d, want 404", rr.Code)
	}
	if envelope := decodeErrorEnvelope(t, rr.Body.Bytes()); envelope.Code != errcode.NotFoundLongTask {
		t.Fatalf("unknown task code = %d, want %d", envelope.Code, errcode.NotFoundLongTask)
	}
	if len(cancelExecCalls(e)) != 0 {
		t.Fatalf("rejected requests must not call the runtime")
	}

	// 终态任务：200 already_terminal + 实际终态，由可信 Store 判定，零运行调用。
	doneRR := e.do(http.MethodPost, "/api/v1/long-tasks/task-done/cancel", "")
	if doneRR.Code != http.StatusOK {
		t.Fatalf("terminal cancel status = %d, want 200", doneRR.Code)
	}
	doneEnvelope := decodeCancelEnvelope(t, doneRR.Body.Bytes())
	if doneEnvelope.Code != 0 || doneEnvelope.Data.Outcome != "already_terminal" || doneEnvelope.Data.Status != "succeeded" {
		t.Fatalf("terminal cancel envelope = %+v", doneEnvelope)
	}
	if len(cancelExecCalls(e)) != 0 {
		t.Fatalf("terminal cancel must not call the runtime")
	}

	// 能力未知：503 明确不支持，零运行调用，且不得把 Store 改成已取消。
	e.srv.LongTaskCapabilities().Invalidate(pod.PodID)
	unknownCap := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", "")
	if unknownCap.Code != http.StatusServiceUnavailable {
		t.Fatalf("unknown capability status = %d, want 503", unknownCap.Code)
	}
	if envelope := decodeErrorEnvelope(t, unknownCap.Body.Bytes()); envelope.Code != errcode.LongTaskCancelUnsupported {
		t.Fatalf("unknown capability code = %d, want %d", envelope.Code, errcode.LongTaskCancelUnsupported)
	}
	task, err := e.store.GetLongTaskTask("task-live")
	if err != nil || task.Status != repo.LongTaskRunning {
		t.Fatalf("store row must stay untouched: %+v err=%v", task, err)
	}
	if len(cancelExecCalls(e)) != 0 {
		t.Fatalf("capability-gated request must not call the runtime")
	}

	// 正常取消：202 仅表达已接受；argv 单载荷 JSON 且归属字段来自 Store。
	e.srv.LongTaskCapabilities().Update(pod.PodID, gateway.LongTaskCancelCapability{Available: true, Version: 1})
	e.drv.cancelExecOut = `{"ok":true,"outcome":"cancel_requested","status":"cancelling","stateRevision":3}`
	accepted := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", "")
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("accepted cancel status = %d, want 202", accepted.Code)
	}
	acceptedEnvelope := decodeCancelEnvelope(t, accepted.Body.Bytes())
	if acceptedEnvelope.Code != 0 || acceptedEnvelope.Data.TaskID != "task-live" ||
		acceptedEnvelope.Data.Outcome != "cancel_requested" || acceptedEnvelope.Data.Status != "cancelling" ||
		acceptedEnvelope.Data.StateRevision != 3 {
		t.Fatalf("accepted cancel envelope = %+v", acceptedEnvelope)
	}
	calls := cancelExecCalls(e)
	if len(calls) != 1 {
		t.Fatalf("expected exactly one runtime call, got %d", len(calls))
	}
	argv := calls[0]
	if len(argv) == 0 || argv[0] != "openclaw" || !strings.Contains(strings.Join(argv, " "), "muad.long-task.cancel") {
		t.Fatalf("unexpected cancel argv: %#v", argv)
	}
	params := argValue(argv, "--params")
	var payload map[string]string
	if err := json.Unmarshal([]byte(params), &payload); err != nil {
		t.Fatalf("params must be JSON: %v", err)
	}
	if payload["taskId"] != "task-live" || payload["requestedBy"] != "root" {
		t.Fatalf("payload = %+v, want task from store and actor from login", payload)
	}
	if strings.Contains(params, "other-pod") || strings.Contains(params, "bob") {
		t.Fatalf("forged body fields must not leak into the runtime call: %s", params)
	}

	// 旧 Worker / 状态写入失败 / RPC 失败分别映射稳定错误，且诊断经脱敏。
	e.drv.cancelExecOut = `{"ok":false,"reason":"cancel_unavailable"}`
	unsupported := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", "")
	if envelope := decodeErrorEnvelope(t, unsupported.Body.Bytes()); unsupported.Code != http.StatusServiceUnavailable || envelope.Code != errcode.LongTaskCancelUnsupported {
		t.Fatalf("unsupported mapping = status %d code %d", unsupported.Code, envelope.Code)
	}
	e.drv.cancelExecOut = `{"ok":false,"reason":"state_unavailable"}`
	stateFailed := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", "")
	if envelope := decodeErrorEnvelope(t, stateFailed.Body.Bytes()); stateFailed.Code != http.StatusInternalServerError || envelope.Code != errcode.LongTaskCancelStateFailed {
		t.Fatalf("state failure mapping = status %d code %d", stateFailed.Code, envelope.Code)
	}
	e.drv.cancelExecOut = ""
	e.drv.cancelExecErr = errors.New("exec failed: token=super-secret-xyz")
	rpcFailed := e.do(http.MethodPost, "/api/v1/long-tasks/task-live/cancel", "")
	if envelope := decodeErrorEnvelope(t, rpcFailed.Body.Bytes()); rpcFailed.Code != http.StatusServiceUnavailable || envelope.Code != errcode.LongTaskCancelUnavailable {
		t.Fatalf("rpc failure mapping = status %d code %d", rpcFailed.Code, envelope.Code)
	}
	if strings.Contains(rpcFailed.Body.String(), "super-secret-xyz") {
		t.Fatalf("secret leaked into response: %s", rpcFailed.Body.String())
	}
	if !strings.Contains(rpcFailed.Body.String(), "token=[redacted]") {
		t.Fatalf("diagnostic detail must be redacted: %s", rpcFailed.Body.String())
	}

	// 失败不得把 Store 改成已取消（镜像只由 Worker 快照前进）。
	live, err := e.store.GetLongTaskTask("task-live")
	if err != nil || live.Status != repo.LongTaskRunning {
		t.Fatalf("store row must not be rewritten by failures: %+v err=%v", live, err)
	}

	// 审计：与 Skill telemetry 分离，actor/target 正确、无伪造字段与凭证。
	entries, total, err := e.store.QueryAuditFiltered(repo.AuditFilter{Action: "long_task.cancel"})
	if err != nil || total < 6 || len(entries) != total {
		t.Fatalf("audit entries = %d/%d err=%v (expected every outcome audited)", len(entries), total, err)
	}
	statuses := map[string]bool{}
	for _, entry := range entries {
		if entry.Actor != "root" {
			t.Fatalf("audit actor = %q, want login actor", entry.Actor)
		}
		if entry.Target != "task-live" && entry.Target != "task-done" {
			t.Fatalf("audit target = %q", entry.Target)
		}
		if strings.Contains(entry.Payload, "super-secret-xyz") || strings.Contains(entry.Payload, "other-pod") {
			t.Fatalf("audit payload leaked sensitive or forged data: %s", entry.Payload)
		}
		var metadata struct {
			Status    string `json:"status"`
			ErrorCode string `json:"errorCode"`
		}
		if err := json.Unmarshal([]byte(entry.Payload), &metadata); err != nil {
			t.Fatalf("audit payload is not metadata JSON: %v", err)
		}
		statuses[metadata.Status] = true
		if metadata.ErrorCode != "" {
			statuses[metadata.ErrorCode] = true
		}
	}
	for _, want := range []string{"cancel_requested", "cancel_unavailable", "failed", "already_terminal"} {
		if !statuses[want] {
			t.Fatalf("missing audit status %q in %v", want, statuses)
		}
	}
}

package test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// LongTaskControlS24 [integration] 真实边界：真实内网快照端点的严格解码、真实
// Store、真实列表 DTO 与按 Pod 能力缓存；旧四状态快照与旧 Worker 兼容。

type s24LongTaskView struct {
	Items []struct {
		TaskID                  string `json:"taskId"`
		HumanUserID             string `json:"humanUserId"`
		HumanUserName           string `json:"humanUserName"`
		Status                  string `json:"status"`
		StateRevision           int64  `json:"stateRevision"`
		CancelRequestedBy       string `json:"cancelRequestedBy"`
		CancelledAt             string `json:"cancelledAt"`
		CanCancel               bool   `json:"canCancel"`
		CancelUnavailableReason string `json:"cancelUnavailableReason"`
	} `json:"items"`
	Pools []struct {
		PoolKey     string `json:"poolKey"`
		PoolRunning int    `json:"poolRunning"`
	} `json:"pools"`
	Total int `json:"total"`
}

func pushLongTaskSnapshot(t *testing.T, e *testEnv, podID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/long-tasks", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.drv.created[podID].ServiceToken.Value)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	return rr
}

func listLongTasksS24(t *testing.T, e *testEnv, query string) s24LongTaskView {
	t.Helper()
	path := "/api/v1/long-tasks"
	if query != "" {
		path += "?" + query
	}
	rr := e.do(http.MethodGet, path, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("list long tasks status = %d body=%s", rr.Code, rr.Body.String())
	}
	var envelope struct {
		Code int             `json:"code"`
		Data s24LongTaskView `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if envelope.Code != 0 {
		t.Fatalf("list envelope code = %d", envelope.Code)
	}
	return envelope.Data
}

func newFormatSnapshot() string {
	return fmt.Sprintf(`{"active":2,"queued":1,"limit":2,"pools":[
	  {"poolKey":"agent:alice:wecom:direct:u1","sessionKey":"agent:alice:wecom:direct:u1","agentId":"alice","peerId":"u1","queued":1,"active":2,"limit":2,"tasks":[
	    {"taskId":"task-cancel","poolKey":"agent:alice:wecom:direct:u1","sessionKey":"agent:alice:longtask:task-cancel","agentId":"alice","peerId":"u1","skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"cancelling","stateRevision":3,"cancelRequestedAt":"2026-10-15T08:02:00.000Z","cancelRequestedBy":"admin","cancelledAt":"","sourceSessionKey":"agent:alice:wecom:direct:u1","submittedAt":"2026-10-15T08:00:00.000Z","startedAt":"2026-10-15T08:00:01.000Z","endedAt":"","terminalReason":"","errorCode":"","updatedAt":"2026-10-15T08:02:00.000Z"},
	    {"taskId":"task-done","poolKey":"agent:alice:wecom:direct:u1","sessionKey":"agent:alice:longtask:task-done","agentId":"alice","peerId":"u1","skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"cancelled","stateRevision":4,"cancelRequestedAt":"2026-10-15T08:02:30.000Z","cancelRequestedBy":"admin","cancelledAt":"2026-10-15T08:03:00.000Z","sourceSessionKey":"agent:alice:wecom:direct:u1","submittedAt":"2026-10-15T08:00:00.000Z","startedAt":"2026-10-15T08:00:01.000Z","endedAt":"2026-10-15T08:03:00.000Z","terminalReason":"manual_cancel","errorCode":"","updatedAt":"2026-10-15T08:03:00.000Z"},
	    {"taskId":"task-run","poolKey":"agent:alice:wecom:direct:u1","sessionKey":"agent:alice:longtask:task-run","agentId":"alice","peerId":"u1","skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"running","stateRevision":1,"cancelRequestedAt":"","cancelRequestedBy":"","cancelledAt":"","sourceSessionKey":"agent:alice:wecom:direct:u1","submittedAt":"2026-10-15T08:04:00.000Z","startedAt":"2026-10-15T08:04:01.000Z","endedAt":"","terminalReason":"","errorCode":"","updatedAt":"2026-10-15T08:04:01.000Z"}
	  ]}
	]}`)
}

func legacySnapshot() string {
	return `{"active":0,"queued":0,"limit":2,"pools":[
	  {"poolKey":"agent:bob:wecom:direct:u2","sessionKey":"agent:bob:wecom:direct:u2","agentId":"bob","peerId":"u2","queued":0,"active":0,"limit":2,"tasks":[
	    {"taskId":"task-legacy","poolKey":"agent:bob:wecom:direct:u2","sessionKey":"agent:bob:longtask:task-legacy","agentId":"bob","peerId":"u2","skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"succeeded","sourceSessionKey":"agent:bob:wecom:direct:u2","submittedAt":"2026-10-15T07:00:00.000Z","startedAt":"2026-10-15T07:00:01.000Z","endedAt":"2026-10-15T07:01:00.000Z","terminalReason":"finished","errorCode":"","updatedAt":"2026-10-15T07:01:00.000Z"}
	  ]}
	]}`
}

func TestLongTaskControlS24SnapshotListAndCapabilityGating(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, strings.Replace(testPodBody, `"maxUsers":2`, `"maxUsers":3`, 1))
	alice := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)
	bob := createTestHumanUser(t, e.store, pod.PodID, "bob", repo.HumanUserStatusActive)
	aliceModel := alice.ModelConfigID
	bobModel := bob.ModelConfigID

	// 兼容旧四状态快照与新增取消字段：两者都经真实内网端点严格解码入库。
	if rr := pushLongTaskSnapshot(t, e, pod.PodID, newFormatSnapshot()); rr.Code != http.StatusOK {
		t.Fatalf("new-format snapshot status = %d body=%s", rr.Code, rr.Body.String())
	}
	if rr := pushLongTaskSnapshot(t, e, pod.PodID, legacySnapshot()); rr.Code != http.StatusOK {
		t.Fatalf("legacy snapshot status = %d body=%s", rr.Code, rr.Body.String())
	}

	execBefore := len(e.drv.execCalls)
	view := listLongTasksS24(t, e, "")
	if view.Total != 4 || len(view.Items) != 4 {
		t.Fatalf("list total = %d items=%d, want 4", view.Total, len(view.Items))
	}
	byID := map[string]int{}
	for index, item := range view.Items {
		byID[item.TaskID] = index
	}
	cancelItem := view.Items[byID["task-cancel"]]
	if cancelItem.Status != "cancelling" || cancelItem.StateRevision != 3 || cancelItem.CancelRequestedBy != "admin" {
		t.Fatalf("cancelling row = %+v", cancelItem)
	}
	if cancelItem.CanCancel || cancelItem.CancelUnavailableReason != "task_not_cancellable" {
		t.Fatalf("cancelling row must not be actionable: %+v", cancelItem)
	}
	doneItem := view.Items[byID["task-done"]]
	if doneItem.Status != "cancelled" || doneItem.CancelledAt == "" || doneItem.CanCancel {
		t.Fatalf("cancelled row = %+v", doneItem)
	}
	runItem := view.Items[byID["task-run"]]
	if runItem.CanCancel || runItem.CancelUnavailableReason != "capability_unknown" {
		t.Fatalf("unknown capability must not be cancellable: %+v", runItem)
	}
	// 列表在读取时解析人类用户名：前端只渲染返回值。
	if runItem.HumanUserName != "alice" {
		t.Fatalf("running row humanUserName = %q, want %q", runItem.HumanUserName, "alice")
	}
	legacyItem := view.Items[byID["task-legacy"]]
	if legacyItem.Status != "succeeded" || legacyItem.CanCancel {
		t.Fatalf("legacy row = %+v", legacyItem)
	}
	if legacyItem.HumanUserName != "bob" {
		t.Fatalf("legacy row humanUserName = %q, want %q", legacyItem.HumanUserName, "bob")
	}
	// cancelling 占槽：池运行数与快照 active 一致（包含取消中的任务）。
	poolRunning := map[string]int{}
	for _, pool := range view.Pools {
		poolRunning[pool.PoolKey] = pool.PoolRunning
	}
	if poolRunning["agent:alice:wecom:direct:u1"] != 2 {
		t.Fatalf("cancelling task must keep occupying the pool slot: %+v", poolRunning)
	}
	// 列表不产生逐行运行调用。
	if len(e.drv.execCalls) != execBefore {
		t.Fatalf("list must not call the runtime")
	}

	// 状态筛选：cancelling / cancelled / 旧状态都可用。
	for _, tc := range []struct{ status, want string }{
		{"cancelling", "task-cancel"}, {"cancelled", "task-done"},
		{"running", "task-run"}, {"succeeded", "task-legacy"},
	} {
		filtered := listLongTasksS24(t, e, "status="+tc.status)
		if filtered.Total != 1 || len(filtered.Items) != 1 || filtered.Items[0].TaskID != tc.want {
			t.Fatalf("status=%s list = %+v", tc.status, filtered.Items)
		}
	}

	// 能力可用后：queued/running 可操作，cancelling/终态依旧不可。
	e.srv.LongTaskCapabilities().Update(pod.PodID, gateway.LongTaskCancelCapability{Available: true, Version: 1})
	view = listLongTasksS24(t, e, "")
	for index, item := range view.Items {
		byID[item.TaskID] = index
	}
	if !view.Items[byID["task-run"]].CanCancel || view.Items[byID["task-run"]].CancelUnavailableReason != "" {
		t.Fatalf("running row should be cancellable with a known capable worker: %+v", view.Items[byID["task-run"]])
	}
	if view.Items[byID["task-cancel"]].CanCancel || view.Items[byID["task-legacy"]].CanCancel {
		t.Fatalf("cancelling/terminal rows must stay non-actionable")
	}

	// 归属隔离：按用户筛选只返回该用户的任务。
	aliceView := listLongTasksS24(t, e, "humanUserId="+alice.HumanUserID)
	if aliceView.Total != 3 {
		t.Fatalf("alice list total = %d, want 3", aliceView.Total)
	}
	for _, item := range aliceView.Items {
		if item.HumanUserID != alice.HumanUserID {
			t.Fatalf("cross-user leak: %+v", item)
		}
	}
	bobView := listLongTasksS24(t, e, "humanUserId="+bob.HumanUserID)
	if bobView.Total != 1 || bobView.Items[0].TaskID != "task-legacy" {
		t.Fatalf("bob list = %+v", bobView.Items)
	}

	// 模型独占绑定与配置路径保留：不创建/改绑用户，已绑定模型冲突仍被拒绝。
	assertExclusiveModelBindings(t, e, alice.HumanUserID, bob.HumanUserID, aliceModel, bobModel)
	_, err := e.store.CreateHumanUser(repo.HumanUser{
		PodID: pod.PodID, ModelConfigID: aliceModel, DisplayName: "third", AgentID: "third",
		BrowserProfile: "third", Status: repo.HumanUserStatusActive,
	}, 18802, 18810)
	if !errors.Is(err, repo.ErrLLMModelAlreadyBound) {
		t.Fatalf("already-bound model must stay rejected, got %v", err)
	}
}

func assertExclusiveModelBindings(t *testing.T, e *testEnv, aliceID, bobID, aliceModel, bobModel string) {
	t.Helper()
	alice, err := e.store.GetHumanUser(aliceID)
	if err != nil {
		t.Fatalf("get alice: %v", err)
	}
	bob, err := e.store.GetHumanUser(bobID)
	if err != nil {
		t.Fatalf("get bob: %v", err)
	}
	if alice.ModelConfigID != aliceModel || bob.ModelConfigID != bobModel || aliceModel == bobModel {
		t.Fatalf("exclusive model bindings changed: alice=%s/%s bob=%s/%s",
			alice.ModelConfigID, aliceModel, bob.ModelConfigID, bobModel)
	}
}

// LongTaskControlS24 [integration] 列表 humanUserName 由后端按当页 user 解析：
// 已知用户返回 displayName；无对应用户/已删除用户返回空串，前端据此回退显示 id。
func TestLongTaskControlS24ListResolvesHumanUserName(t *testing.T) {
	e := newTestEnv(t)
	pod := createPodThroughAPI(t, e, strings.Replace(testPodBody, `"maxUsers":2`, `"maxUsers":3`, 1))
	alice := createTestHumanUser(t, e.store, pod.PodID, "alice", repo.HumanUserStatusActive)

	snapshot := `{"active":2,"queued":0,"limit":2,"pools":[
	  {"poolKey":"agent:alice:wecom:direct:u1","sessionKey":"agent:alice:wecom:direct:u1","agentId":"alice","peerId":"u1","queued":0,"active":1,"limit":2,"tasks":[
	    {"taskId":"task-alice","poolKey":"agent:alice:wecom:direct:u1","agentId":"alice","peerId":"u1","skillName":"xdr-query","status":"running","submittedAt":"2026-10-16T08:00:00.000Z","startedAt":"2026-10-16T08:00:01.000Z","updatedAt":"2026-10-16T08:00:01.000Z"}
	  ]},
	  {"poolKey":"agent:carol:wecom:direct:u9","sessionKey":"agent:carol:wecom:direct:u9","agentId":"carol","peerId":"u9","queued":0,"active":1,"limit":2,"tasks":[
	    {"taskId":"task-carol","poolKey":"agent:carol:wecom:direct:u9","agentId":"carol","peerId":"u9","skillName":"xdr-query","status":"failed","endedAt":"2026-10-16T08:01:00.000Z","terminalReason":"errored","updatedAt":"2026-10-16T08:01:00.000Z"}
	  ]}
	]}`
	if rr := pushLongTaskSnapshot(t, e, pod.PodID, snapshot); rr.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d body=%s", rr.Code, rr.Body.String())
	}
	view := listLongTasksS24(t, e, "")
	names := map[string]string{}
	for _, item := range view.Items {
		names[item.TaskID] = item.HumanUserName
	}
	// 已知用户：名称随列表返回（createTestHumanUser 的 DisplayName = agentID）。
	if names["task-alice"] != "alice" {
		t.Fatalf("alice task humanUserName = %q, want %q", names["task-alice"], "alice")
	}
	// 无对应用户的任务：空串，前端回退显示 id。
	if names["task-carol"] != "" {
		t.Fatalf("task without a Human User must resolve to an empty name, got %q", names["task-carol"])
	}

	// 用户被清理（物理删除）后：历史任务仍保留，名称解析为空 → 回退 id。
	if err := e.store.MarkHumanUserDeleting(alice.HumanUserID); err != nil {
		t.Fatalf("mark alice deleting: %v", err)
	}
	if err := e.store.DeleteHumanUser(alice.HumanUserID); err != nil {
		t.Fatalf("physically delete alice: %v", err)
	}
	view = listLongTasksS24(t, e, "")
	for _, item := range view.Items {
		if item.TaskID == "task-alice" && item.HumanUserName != "" {
			t.Fatalf("deleted user must fall back to an empty name, got %q", item.HumanUserName)
		}
	}
}

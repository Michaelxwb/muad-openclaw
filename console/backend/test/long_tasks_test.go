package test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestLongTaskTasks_UpsertListAndMonotonicStatus(t *testing.T) {
	store := newStore(t)
	submitted := time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC)
	task := repo.LongTaskTask{
		TaskID: "task-a", PodID: "pod-a", HumanUserID: "user-a",
		PoolKey: "agent:alice:wecom:direct:wx-1", PoolQueued: 1, PoolRunning: 0, PoolLimit: 2,
		AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", SkillRoot: "/skills/xdr", Status: repo.LongTaskQueued,
		SubmittedAt: submitted, UpdatedAt: submitted, LastSeenAt: submitted,
	}
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("insert Long Task: %v", err)
	}
	task.Status = repo.LongTaskRunning
	task.PoolQueued = 0
	task.PoolRunning = 1
	task.StartedAt = submitted.Add(time.Minute)
	task.UpdatedAt = submitted.Add(time.Minute)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("advance Long Task: %v", err)
	}

	// A status regression (running -> queued) is not silently dropped: the
	// record is kept and converged to a terminal failed state with the reason
	// recorded, preserving the incoming pool counters and last_seen.
	regressed := task
	regressed.Status = repo.LongTaskQueued
	regressed.PoolQueued = 1
	regressed.PoolRunning = 0
	regressed.UpdatedAt = submitted.Add(90 * time.Second)
	regressed.LastSeenAt = submitted.Add(90 * time.Second)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{regressed}); err != nil {
		t.Fatalf("regress running Long Task: %v", err)
	}
	listed, _, err := store.ListLongTaskTasks(repo.LongTaskListFilter{Query: "task-a", Limit: 1})
	if err != nil || len(listed) != 1 {
		t.Fatalf("list regressed Long Task = %+v, %v", listed, err)
	}
	got := listed[0]
	if got.Status != repo.LongTaskFailed {
		t.Fatalf("regressed Long Task status = %q, want failed: %+v", got.Status, got)
	}
	if !strings.Contains(got.TerminalReason, "running") || !strings.Contains(got.TerminalReason, "queued") {
		t.Fatalf("regressed Long Task terminal_reason = %q", got.TerminalReason)
	}
	if got.PoolQueued != 1 || got.PoolRunning != 0 || got.EndedAt.IsZero() ||
		!got.LastSeenAt.Equal(submitted.Add(90*time.Second)) {
		t.Fatalf("regression dropped incoming snapshot fields: %+v", got)
	}

	// A later terminal snapshot on the failed row stays failed (terminal rows
	// never regress), but counters/last_seen still converge.
	succeeded := regressed
	succeeded.Status = repo.LongTaskSucceeded
	succeeded.PoolQueued = 0
	succeeded.PoolRunning = 0
	succeeded.EndedAt = submitted.Add(2 * time.Minute)
	succeeded.UpdatedAt = submitted.Add(2 * time.Minute)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{succeeded}); err != nil {
		t.Fatalf("finish Long Task: %v", err)
	}
	items, total, err := store.ListLongTaskTasks(repo.LongTaskListFilter{
		Query: "xdr", Status: repo.LongTaskFailed, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListLongTaskTasks: %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].Status != repo.LongTaskFailed ||
		items[0].PoolQueued != 0 || items[0].PoolRunning != 0 || items[0].PoolLimit != 2 ||
		items[0].StartedAt.IsZero() || items[0].EndedAt.IsZero() ||
		items[0].TerminalReason == "" {
		t.Fatalf("listed Long Tasks = total %d items %+v", total, items)
	}
}

func TestLongTaskTasks_ListPoolsUsesUnpaginatedSummary(t *testing.T) {
	store := newStore(t)
	now := time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC)
	tasks := []repo.LongTaskTask{
		{
			TaskID: "task-a", PodID: "pod-a", HumanUserID: "user-a",
			PoolKey: "agent:alice:wecom:direct:wx-1", PoolQueued: 4, PoolRunning: 2, PoolLimit: 2,
			AgentID: "alice", PeerID: "wx-1", SkillName: "xdr-query", Status: repo.LongTaskRunning,
			SubmittedAt: now, StartedAt: now, UpdatedAt: now, LastSeenAt: now,
		},
		{
			TaskID: "task-b", PodID: "pod-a", HumanUserID: "user-b",
			PoolKey: "agent:bob:wecom:direct:wx-2", PoolQueued: 3, PoolRunning: 1, PoolLimit: 2,
			AgentID: "bob", PeerID: "wx-2", SkillName: "report-customer", Status: repo.LongTaskQueued,
			SubmittedAt: now.Add(time.Minute), UpdatedAt: now.Add(time.Minute), LastSeenAt: now.Add(time.Minute),
		},
	}
	if err := store.UpsertLongTaskTasks(tasks); err != nil {
		t.Fatalf("seed Long Tasks: %v", err)
	}
	items, total, err := store.ListLongTaskTasks(repo.LongTaskListFilter{PodID: "pod-a", Limit: 1})
	if err != nil {
		t.Fatalf("ListLongTaskTasks: %v", err)
	}
	if total != 2 || len(items) != 1 {
		t.Fatalf("paginated Long Tasks = total %d items %+v", total, items)
	}
	pools, err := store.ListLongTaskPools(repo.LongTaskListFilter{PodID: "pod-a", Limit: 1})
	if err != nil {
		t.Fatalf("ListLongTaskPools: %v", err)
	}
	if len(pools) != 2 || pools[0].PoolQueued != 3 || pools[0].PoolRunning != 1 ||
		pools[1].PoolQueued != 4 || pools[1].PoolRunning != 2 {
		t.Fatalf("Long Task pools should not be sliced by task pagination: %+v", pools)
	}
}

func TestLongTaskAPI_ListAndRejectInvalidStatus(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)
	now := time.Date(2026, 8, 9, 11, 0, 0, 0, time.UTC)
	if err := env.store.UpsertLongTaskTasks([]repo.LongTaskTask{{
		TaskID: "task-api", PodID: "pod-a", HumanUserID: alice.HumanUserID,
		PoolKey: "agent:alice:wecom:direct:wx-1", PoolQueued: 4, PoolRunning: 2, PoolLimit: 2,
		AgentID: alice.AgentID, PeerID: "wx-1",
		SkillName: "xdr-query", Status: repo.LongTaskRunning,
		SubmittedAt: now, StartedAt: now, UpdatedAt: now, LastSeenAt: now,
	}}); err != nil {
		t.Fatalf("seed Long Task: %v", err)
	}

	response := env.do(http.MethodGet, "/api/v1/long-tasks?status=running&pageSize=10", "")
	assertStatus(t, response, http.StatusOK)
	data := decodeAPIData[struct {
		Items []struct {
			TaskID      string `json:"taskId"`
			PodID       string `json:"podId"`
			HumanUserID string `json:"humanUserId"`
			PoolQueued  int    `json:"poolQueued"`
			PoolRunning int    `json:"poolRunning"`
			PoolLimit   int    `json:"poolLimit"`
			AgentID     string `json:"agentId"`
			SkillName   string `json:"skillName"`
			Status      string `json:"status"`
		} `json:"items"`
		Pools []struct {
			PoolKey     string `json:"poolKey"`
			PoolQueued  int    `json:"poolQueued"`
			PoolRunning int    `json:"poolRunning"`
			PoolLimit   int    `json:"poolLimit"`
		} `json:"pools"`
		Total int `json:"total"`
	}](t, response.Body.Bytes())
	if data.Total != 1 || len(data.Items) != 1 || data.Items[0].TaskID != "task-api" ||
		data.Items[0].HumanUserID != alice.HumanUserID || data.Items[0].PoolQueued != 4 ||
		data.Items[0].PoolRunning != 2 || data.Items[0].PoolLimit != 2 ||
		data.Items[0].Status != repo.LongTaskRunning {
		t.Fatalf("Long Task API response = %+v", data)
	}
	if len(data.Pools) != 1 || data.Pools[0].PoolQueued != 4 ||
		data.Pools[0].PoolRunning != 2 || data.Pools[0].PoolLimit != 2 {
		t.Fatalf("Long Task API pools = %+v", data.Pools)
	}

	response = env.do(http.MethodGet, "/api/v1/long-tasks?status=blocked", "")
	assertStatus(t, response, http.StatusBadRequest)
}

func TestLongTaskInternalAPI_UpsertsGuardSnapshot(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")
	alice := createTestHumanUser(t, env.store, "pod-a", "alice", repo.HumanUserStatusActive)

	// The body mirrors the guard snapshot payload exactly, including the
	// top-level active/queued/limit and per-task sourceSessionKey fields that
	// decodeJSONBody (DisallowUnknownFields) would otherwise reject.
	body := `{"active":1,"queued":0,"limit":2,"pools":[{"poolKey":"agent:alice:wecom:direct:wx-1",` +
		`"sessionKey":"agent:alice:wecom:direct:wx-1","agentId":"alice","peerId":"wx-1",` +
		`"queued":0,"active":1,"limit":2,"tasks":[{"taskId":"task-push-1",` +
		`"poolKey":"agent:alice:wecom:direct:wx-1","sessionKey":"agent:alice:longtask:task-push-1",` +
		`"sourceSessionKey":"agent:alice:wecom:direct:wx-1","agentId":"alice","peerId":"wx-1",` +
		`"skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"running",` +
		`"submittedAt":"2026-08-09T10:00:00.000Z","startedAt":"2026-08-09T10:00:01.000Z","endedAt":"",` +
		`"terminalReason":"","errorCode":"","updatedAt":"2026-08-09T10:00:01.000Z"}]}]}`

	rr := doInternalLongTasks(env, token, body)
	assertStatus(t, rr, http.StatusOK)
	if updated := decodeAPIData[struct {
		Updated int `json:"updated"`
	}](t, rr.Body.Bytes()).Updated; updated != 1 {
		t.Fatalf("push updated count = %d, want 1", updated)
	}

	rr = env.do(http.MethodGet, "/api/v1/long-tasks?status=running&pageSize=10", "")
	assertStatus(t, rr, http.StatusOK)
	list := decodeAPIData[struct {
		Items []struct {
			TaskID      string `json:"taskId"`
			HumanUserID string `json:"humanUserId"`
			AgentID     string `json:"agentId"`
			PoolQueued  int    `json:"poolQueued"`
			PoolRunning int    `json:"poolRunning"`
			PoolLimit   int    `json:"poolLimit"`
			Status      string `json:"status"`
		} `json:"items"`
		Total int `json:"total"`
	}](t, rr.Body.Bytes())
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].TaskID != "task-push-1" ||
		list.Items[0].HumanUserID != alice.HumanUserID || list.Items[0].AgentID != "alice" ||
		list.Items[0].PoolQueued != 0 || list.Items[0].PoolRunning != 1 ||
		list.Items[0].PoolLimit != 2 || list.Items[0].Status != repo.LongTaskRunning {
		t.Fatalf("Long Task after push = %+v", list)
	}
}

func TestLongTaskInternalAPI_UnknownAgentUpsertsLeniently(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")

	body := `{"active":0,"queued":1,"limit":2,"pools":[{"poolKey":"agent:ghost:wecom:direct:wx-9",` +
		`"sessionKey":"agent:ghost:wecom:direct:wx-9","agentId":"ghost","peerId":"wx-9",` +
		`"queued":1,"active":0,"limit":2,"tasks":[{"taskId":"task-ghost",` +
		`"poolKey":"agent:ghost:wecom:direct:wx-9","sessionKey":"agent:ghost:longtask:task-ghost",` +
		`"sourceSessionKey":"agent:ghost:wecom:direct:wx-9","agentId":"ghost","peerId":"wx-9",` +
		`"skillName":"xdr-query","skillRoot":"/skills/xdr-query","status":"queued",` +
		`"submittedAt":"2026-08-09T10:00:00.000Z","startedAt":"","endedAt":"",` +
		`"terminalReason":"","errorCode":"","updatedAt":"2026-08-09T10:00:00.000Z"}]}]}`

	rr := doInternalLongTasks(env, token, body)
	assertStatus(t, rr, http.StatusOK)
	if updated := decodeAPIData[struct {
		Updated int `json:"updated"`
	}](t, rr.Body.Bytes()).Updated; updated != 1 {
		t.Fatalf("push updated count = %d, want 1", updated)
	}

	items, total, err := env.store.ListLongTaskTasks(repo.LongTaskListFilter{
		PodID: "pod-a", AgentID: "ghost", Limit: 10,
	})
	if err != nil || total != 1 || len(items) != 1 || items[0].HumanUserID != "" {
		t.Fatalf("lenient upsert for unknown agent = total %d items %+v, err %v", total, items, err)
	}
}

func TestLongTaskInternalAPI_InvalidSkillNameRejected(t *testing.T) {
	env := newTestEnv(t)
	token := createPodWithToken(t, env, "pod-a")

	// skillName 为空触发 repo.ErrInvalidSkill，handler 应映射为 400 请求体错误
	// （而非误导性的"无效 Skill"客户端错误码），避免把服务端数据校验失败伪装成 Skill 错误。
	body := `{"active":0,"queued":0,"limit":2,"pools":[{"poolKey":"agent:alice:wecom:direct:wx-1",` +
		`"sessionKey":"agent:alice:wecom:direct:wx-1","agentId":"alice","peerId":"wx-1",` +
		`"queued":0,"active":0,"limit":2,"tasks":[{"taskId":"task-invalid",` +
		`"poolKey":"agent:alice:wecom:direct:wx-1","sessionKey":"agent:alice:longtask:task-invalid",` +
		`"sourceSessionKey":"agent:alice:wecom:direct:wx-1","agentId":"alice","peerId":"wx-1",` +
		`"skillName":"","skillRoot":"/skills/xdr-query","status":"queued",` +
		`"submittedAt":"2026-08-09T10:00:00.000Z","startedAt":"","endedAt":"",` +
		`"terminalReason":"","errorCode":"","updatedAt":"2026-08-09T10:00:00.000Z"}]}]}`

	rr := doInternalLongTasks(env, token, body)
	assertStatus(t, rr, http.StatusBadRequest)
}

func doInternalLongTasks(env *testEnv, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/long-tasks", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	env.h.ServeHTTP(recorder, req)
	return recorder
}

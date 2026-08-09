package test

import (
	"net/http"
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
	task.Status = repo.LongTaskQueued
	task.PoolQueued = 1
	task.PoolRunning = 0
	task.UpdatedAt = submitted.Add(90 * time.Second)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("regress running Long Task: %v", err)
	}
	task.Status = repo.LongTaskSucceeded
	task.PoolQueued = 0
	task.PoolRunning = 0
	task.EndedAt = submitted.Add(2 * time.Minute)
	task.UpdatedAt = submitted.Add(2 * time.Minute)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("finish Long Task: %v", err)
	}
	task.Status = repo.LongTaskQueued
	task.UpdatedAt = submitted.Add(3 * time.Minute)
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("regress terminal Long Task: %v", err)
	}

	items, total, err := store.ListLongTaskTasks(repo.LongTaskListFilter{
		Query: "xdr", Status: repo.LongTaskSucceeded, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListLongTaskTasks: %v", err)
	}
	if total != 1 || len(items) != 1 || items[0].Status != repo.LongTaskSucceeded ||
		items[0].PoolQueued != 0 || items[0].PoolRunning != 0 || items[0].PoolLimit != 2 ||
		items[0].StartedAt.IsZero() || items[0].EndedAt.IsZero() {
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

func TestLongTaskTasks_ReconcileMarksMissingNonTerminalTasksFailed(t *testing.T) {
	store := newStore(t)
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	taskA := repo.LongTaskTask{
		TaskID: "task-a", PodID: "pod-a", HumanUserID: "user-a",
		PoolKey: "agent:alice:wecom:direct:wx-1", PoolQueued: 1, PoolRunning: 1,
		AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", Status: repo.LongTaskRunning,
		SubmittedAt: now, StartedAt: now, UpdatedAt: now, LastSeenAt: now,
	}
	taskB := repo.LongTaskTask{
		TaskID: "task-b", PodID: "pod-a", HumanUserID: "user-a",
		PoolKey: "agent:alice:wecom:direct:wx-1", PoolQueued: 1, PoolRunning: 1,
		AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", Status: repo.LongTaskQueued,
		SubmittedAt: now, UpdatedAt: now, LastSeenAt: now,
	}
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{taskA, taskB}); err != nil {
		t.Fatalf("seed Long Tasks: %v", err)
	}
	taskA.UpdatedAt = now.Add(time.Minute)
	taskA.LastSeenAt = now.Add(time.Minute)
	if err := store.ReconcileLongTaskTasks("pod-a", []repo.LongTaskTask{taskA}); err != nil {
		t.Fatalf("reconcile Long Tasks: %v", err)
	}
	failed, total, err := store.ListLongTaskTasks(repo.LongTaskListFilter{
		PodID: "pod-a", Status: repo.LongTaskFailed, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListLongTaskTasks failed: %v", err)
	}
	if total != 1 || len(failed) != 1 || failed[0].TaskID != "task-b" ||
		failed[0].ErrorCode != "long_task_missing_snapshot" || failed[0].EndedAt.IsZero() {
		t.Fatalf("failed Long Tasks after reconcile = total %d items %+v", total, failed)
	}

	if err := store.ReconcileLongTaskTasks("pod-a", nil); err != nil {
		t.Fatalf("reconcile empty Long Tasks: %v", err)
	}
	failed, total, err = store.ListLongTaskTasks(repo.LongTaskListFilter{
		PodID: "pod-a", Status: repo.LongTaskFailed, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListLongTaskTasks after empty reconcile: %v", err)
	}
	if total != 2 || len(failed) != 2 {
		t.Fatalf("empty reconcile did not fail all non-terminal tasks: total %d items %+v", total, failed)
	}
	pools, err := store.ListLongTaskPools(repo.LongTaskListFilter{PodID: "pod-a"})
	if err != nil {
		t.Fatalf("ListLongTaskPools after empty reconcile: %v", err)
	}
	if len(pools) != 1 || pools[0].PoolQueued != 0 || pools[0].PoolRunning != 0 {
		t.Fatalf("empty reconcile left stale pool counters: %+v", pools)
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

package test

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// LongTaskControlB03 [integration] 真实边界：真实 SQLite 文件、升级前四状态旧表、
// repo 迁移与镜像合并；不 mock。

const legacyLongTaskDDLForMirror = `CREATE TABLE long_task_tasks (
	task_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL,
	human_user_id TEXT NOT NULL DEFAULT '',
	pool_key TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	peer_id TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_root TEXT NOT NULL DEFAULT '',
	pool_queued INTEGER NOT NULL DEFAULT 0 CHECK (pool_queued >= 0),
	pool_running INTEGER NOT NULL DEFAULT 0 CHECK (pool_running >= 0),
	pool_limit INTEGER NOT NULL DEFAULT 0 CHECK (pool_limit >= 0),
	status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
	submitted_at TEXT NOT NULL,
	started_at TEXT NOT NULL DEFAULT '',
	ended_at TEXT NOT NULL DEFAULT '',
	terminal_reason TEXT NOT NULL DEFAULT '',
	error_code TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_long_task_pod_updated ON long_task_tasks(pod_id, updated_at);
CREATE INDEX idx_long_task_user_status ON long_task_tasks(human_user_id, status, submitted_at);
CREATE INDEX idx_long_task_pool_status ON long_task_tasks(pool_key, status, submitted_at);`

func openMirrorStore(t *testing.T) (*repo.Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mirror.db")
	store, err := repo.Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, path
}

func taskSnapshot(taskID, status string, revision int, base time.Time) repo.LongTaskTask {
	return repo.LongTaskTask{
		TaskID: taskID, PodID: "pod-1", HumanUserID: "user-1",
		PoolKey: "agent:alice:wecom:direct:wx-1", AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", SkillRoot: "/skills/xdr-query",
		PoolQueued: 0, PoolRunning: 1, PoolLimit: 2,
		Status: status, StateRevision: revision,
		SubmittedAt: base, UpdatedAt: base, LastSeenAt: base,
	}
}

func mustUpsert(t *testing.T, store *repo.Store, task repo.LongTaskTask) {
	t.Helper()
	if err := store.UpsertLongTaskTasks([]repo.LongTaskTask{task}); err != nil {
		t.Fatalf("upsert %s/%s rev=%d: %v", task.TaskID, task.Status, task.StateRevision, err)
	}
}

func readTaskRow(t *testing.T, store *repo.Store, taskID string) repo.LongTaskTask {
	t.Helper()
	tasks, _, err := store.ListLongTaskTasks(repo.LongTaskListFilter{})
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	for _, task := range tasks {
		if task.TaskID == taskID {
			return task
		}
	}
	t.Fatalf("task %s not found", taskID)
	return repo.LongTaskTask{}
}

func TestLongTaskControlB03MirrorMergeKeepsTerminalsAndIgnoresStaleSnapshots(t *testing.T) {
	store, _ := openMirrorStore(t)
	base := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)

	// 正常前进：queued -> running -> cancelling -> cancelled，快照 revision 递增。
	for _, step := range []struct {
		status   string
		revision int
	}{
		{repo.LongTaskQueued, 1},
		{repo.LongTaskRunning, 2},
		{repo.LongTaskCancelling, 3},
		{repo.LongTaskCancelled, 4},
	} {
		mustUpsert(t, store, taskSnapshot("task-linear", step.status, step.revision, base.Add(time.Duration(step.revision)*time.Minute)))
	}
	linear := readTaskRow(t, store, "task-linear")
	if linear.Status != repo.LongTaskCancelled || linear.StateRevision != 4 {
		t.Fatalf("linear cancel flow not applied: %+v", linear)
	}

	// 重复快照幂等：同一 revision 重复上报不产生第二行、不回退。
	mustUpsert(t, store, taskSnapshot("task-linear", repo.LongTaskCancelled, 4, base.Add(10*time.Minute)))
	if again := readTaskRow(t, store, "task-linear"); again.Status != repo.LongTaskCancelled || again.StateRevision != 4 {
		t.Fatalf("repeated snapshot changed the row: %+v", again)
	}

	// 已取消/已完成终态不被任何快照回退或改成 failed（含旧 revision 与旧格式 rev=0）。
	succeeded := taskSnapshot("task-done", repo.LongTaskSucceeded, 5, base)
	mustUpsert(t, store, succeeded)
	mustUpsert(t, store, taskSnapshot("task-done", repo.LongTaskRunning, 2, base.Add(time.Minute)))
	mustUpsert(t, store, taskSnapshot("task-done", repo.LongTaskQueued, 0, base.Add(2*time.Minute)))
	if done := readTaskRow(t, store, "task-done"); done.Status != repo.LongTaskSucceeded {
		t.Fatalf("succeeded terminal was overwritten: %+v", done)
	}
	mustUpsert(t, store, taskSnapshot("task-linear", repo.LongTaskRunning, 0, base.Add(3*time.Minute)))
	if cancelled := readTaskRow(t, store, "task-linear"); cancelled.Status != repo.LongTaskCancelled {
		t.Fatalf("cancelled terminal was overwritten by a legacy snapshot: %+v", cancelled)
	}

	// 乱序快照：迟到的 queued(rev 1) 不把 running(rev 3) 拉回去。
	mustUpsert(t, store, taskSnapshot("task-ooo", repo.LongTaskRunning, 3, base))
	mustUpsert(t, store, taskSnapshot("task-ooo", repo.LongTaskQueued, 1, base.Add(time.Minute)))
	if ooo := readTaskRow(t, store, "task-ooo"); ooo.Status != repo.LongTaskRunning || ooo.StateRevision != 3 {
		t.Fatalf("stale snapshot regressed the row: %+v", ooo)
	}

	// cancelling 单向门：迟到的 running(更高 revision) 也不得改写成 failed。
	mustUpsert(t, store, taskSnapshot("task-stop", repo.LongTaskRunning, 2, base))
	mustUpsert(t, store, taskSnapshot("task-stop", repo.LongTaskCancelling, 3, base.Add(time.Minute)))
	mustUpsert(t, store, taskSnapshot("task-stop", repo.LongTaskRunning, 4, base.Add(2*time.Minute)))
	stopping := readTaskRow(t, store, "task-stop")
	if stopping.Status != repo.LongTaskCancelling {
		t.Fatalf("cancelling task was regressed: %+v", stopping)
	}
	if strings.Contains(stopping.TerminalReason, "status_regressed") {
		t.Fatalf("late snapshot must not fabricate a failed regression: %+v", stopping)
	}

	// 旧 revision（0）的合法前进仍兼容旧 Worker：queued(0) -> running(0) -> succeeded(0)。
	for _, step := range []struct {
		status   string
		revision int
	}{{repo.LongTaskQueued, 0}, {repo.LongTaskRunning, 0}, {repo.LongTaskSucceeded, 0}} {
		mustUpsert(t, store, taskSnapshot("task-legacy", step.status, step.revision, base))
	}
	if legacy := readTaskRow(t, store, "task-legacy"); legacy.Status != repo.LongTaskSucceeded {
		t.Fatalf("legacy revision-0 flow broken: %+v", legacy)
	}
}

func TestLongTaskControlB03MigrationRepeatKeepsHistoryAndIndexes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-mirror.db")
	legacy, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path))
	if err != nil {
		t.Fatalf("open legacy sqlite: %v", err)
	}
	if _, err := legacy.Exec(legacyLongTaskDDLForMirror); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if _, err := legacy.Exec(`INSERT INTO long_task_tasks (
		task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name, skill_root,
		pool_queued, pool_running, pool_limit, status, submitted_at, started_at, ended_at,
		terminal_reason, error_code, updated_at, last_seen_at
	) VALUES ('lt-old', 'pod-1', 'user-1', 'agent:alice:wecom:direct:wx-1', 'alice', 'wx-1',
		'xdr-query', '/skills/xdr-query', 1, 0, 2, 'succeeded', '2026-10-15T08:00:00.000Z',
		'2026-10-15T08:00:01.000Z', '2026-10-15T08:01:00.000Z', 'finished', '',
		'2026-10-15T08:01:00.000Z', '2026-10-15T08:01:00.000Z')`); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy: %v", err)
	}

	store, err := repo.Open(path)
	if err != nil {
		t.Fatalf("migrate legacy store: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close migrated store: %v", err)
	}
	// 迁移重复执行：历史行与索引保留，且旧终态不被改写。
	again, err := repo.Open(path)
	if err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	defer again.Close()
	tasks, total, err := again.ListLongTaskTasks(repo.LongTaskListFilter{})
	if err != nil || total != 1 || len(tasks) != 1 {
		t.Fatalf("legacy history lost: total=%d len=%d err=%v", total, len(tasks), err)
	}
	if tasks[0].Status != repo.LongTaskSucceeded || tasks[0].TerminalReason != "finished" {
		t.Fatalf("legacy terminal changed: %+v", tasks[0])
	}
	raw, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path))
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	defer raw.Close()
	var indexes int
	if err := raw.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_long_task_%'`).Scan(&indexes); err != nil {
		t.Fatalf("inspect indexes: %v", err)
	}
	if indexes != 3 {
		t.Fatalf("expected the three long-task indexes, got %d", indexes)
	}
}

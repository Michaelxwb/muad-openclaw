package repo

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// LongTaskControlS16 [integration] 真实边界：SQLite 旧表（升级前 DDL 与既有行）、
// repo 迁移的真实事务与 PRAGMA/sqlite_master 检查、真实索引；均不 mock。

// 升级前部署的 long_task_tasks：status CHECK 仅四状态，无取消 metadata 列。
const legacyLongTaskDDL = `CREATE TABLE long_task_tasks (
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

// 损坏的旧库形态：没有 status CHECK，因此能藏一条新约束无法接受的历史脏值。
const corruptLegacyLongTaskDDL = `CREATE TABLE long_task_tasks (
	task_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL,
	human_user_id TEXT NOT NULL DEFAULT '',
	pool_key TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	peer_id TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_root TEXT NOT NULL DEFAULT '',
	pool_queued INTEGER NOT NULL DEFAULT 0,
	pool_running INTEGER NOT NULL DEFAULT 0,
	pool_limit INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL,
	submitted_at TEXT NOT NULL,
	started_at TEXT NOT NULL DEFAULT '',
	ended_at TEXT NOT NULL DEFAULT '',
	terminal_reason TEXT NOT NULL DEFAULT '',
	error_code TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL
);`

func openRawSQLite(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path))
	if err != nil {
		t.Fatalf("open sqlite %s: %v", path, err)
	}
	return db
}

func execLegacy(t *testing.T, db *sql.DB, ddl string) {
	t.Helper()
	if _, err := db.Exec(ddl); err != nil {
		t.Fatalf("apply legacy DDL: %v", err)
	}
}

func insertLegacyLongTask(t *testing.T, db *sql.DB, taskID, status, reason string, updatedAt time.Time) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO long_task_tasks (
		task_id, pod_id, human_user_id, pool_key, agent_id, peer_id, skill_name, skill_root,
		pool_queued, pool_running, pool_limit, status, submitted_at, started_at, ended_at,
		terminal_reason, error_code, updated_at, last_seen_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		taskID, "pod-1", "user-1", "agent:alice:wecom:direct:wx-1", "alice", "wx-1", "xdr-query", "/skills/xdr-query",
		0, 0, 2, status, "2026-10-15T08:00:00.000Z", "2026-10-15T08:00:01.000Z", "",
		reason, "", updatedAt.UTC().Format("2006-01-02T15:04:05.000Z"), updatedAt.UTC().Format("2006-01-02T15:04:05.000Z"))
	if err != nil {
		t.Fatalf("insert legacy row %s: %v", taskID, err)
	}
}

func longTaskTableColumns(t *testing.T, db *sql.DB) map[string]bool {
	t.Helper()
	rows, err := db.Query(`PRAGMA table_info(long_task_tasks)`)
	if err != nil {
		t.Fatalf("pragma table_info: %v", err)
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		columns[name] = true
	}
	return columns
}

func longTaskTableSQL(t *testing.T, db *sql.DB) string {
	t.Helper()
	var definition string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'long_task_tasks'`).Scan(&definition); err != nil {
		t.Fatalf("read long_task_tasks sqlite_master: %v", err)
	}
	return definition
}

func countTable(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return count
}

func TestLongTaskControlS16MigrationPreservesLegacyRowsAndIsRepeatable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-long-tasks.db")
	legacy := openRawSQLite(t, path)
	execLegacy(t, legacy, legacyLongTaskDDL)
	base := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	insertLegacyLongTask(t, legacy, "lt-queued", "queued", "", base)
	insertLegacyLongTask(t, legacy, "lt-run", "running", "", base.Add(time.Minute))
	insertLegacyLongTask(t, legacy, "lt-done", "succeeded", "finished", base.Add(2*time.Minute))
	insertLegacyLongTask(t, legacy, "lt-failed", "failed", "boom", base.Add(3*time.Minute))
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("open store with legacy long tasks: %v", err)
	}
	columns := longTaskTableColumns(t, store.db)
	for _, column := range []string{"state_revision", "cancel_requested_at", "cancel_requested_by", "cancelled_at"} {
		if !columns[column] {
			t.Fatalf("migrated table is missing column %s", column)
		}
	}
	definition := longTaskTableSQL(t, store.db)
	for _, state := range []string{"'cancelling'", "'cancelled'"} {
		if !strings.Contains(definition, state) {
			t.Fatalf("status CHECK does not accept %s: %s", state, definition)
		}
	}
	if countTable(t, store.db, "long_task_tasks") != 4 {
		t.Fatalf("row count changed during migration")
	}
	var leftOver int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'long_task_tasks_legacy'`).Scan(&leftOver); err != nil {
		t.Fatalf("inspect legacy table: %v", err)
	}
	if leftOver != 0 {
		t.Fatalf("rebuild left long_task_tasks_legacy behind")
	}
	for _, index := range []string{"idx_long_task_pod_updated", "idx_long_task_user_status", "idx_long_task_pool_status"} {
		var found int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, index).Scan(&found); err != nil {
			t.Fatalf("inspect index %s: %v", index, err)
		}
		if found != 1 {
			t.Fatalf("index %s missing after migration", index)
		}
	}
	preserved := map[string][2]string{}
	rows, err := store.db.Query(`SELECT task_id, status, terminal_reason, state_revision, cancel_requested_by FROM long_task_tasks`)
	if err != nil {
		t.Fatalf("read migrated rows: %v", err)
	}
	for rows.Next() {
		var taskID, status, reason, cancelRequestedBy string
		var revision int
		if err := rows.Scan(&taskID, &status, &reason, &revision, &cancelRequestedBy); err != nil {
			t.Fatalf("scan migrated row: %v", err)
		}
		if revision != 0 || cancelRequestedBy != "" {
			t.Fatalf("new columns should default to 0/empty for %s", taskID)
		}
		preserved[taskID] = [2]string{status, reason}
	}
	rows.Close()
	for taskID, want := range map[string][2]string{
		"lt-queued": {"queued", ""},
		"lt-run":    {"running", ""},
		"lt-done":   {"succeeded", "finished"},
		"lt-failed": {"failed", "boom"},
	} {
		if preserved[taskID] != want {
			t.Fatalf("row %s changed: got %v want %v", taskID, preserved[taskID], want)
		}
	}
	now := time.Now().UTC()
	if err := store.UpsertLongTaskTasks([]LongTaskTask{{
		TaskID: "lt-run", PodID: "pod-1", HumanUserID: "user-1",
		PoolKey: "agent:alice:wecom:direct:wx-1", AgentID: "alice", PeerID: "wx-1",
		SkillName: "xdr-query", SkillRoot: "/skills/xdr-query", PoolLimit: 2,
		Status: LongTaskCancelling, StateRevision: 2, CancelRequestedAt: now, CancelRequestedBy: "admin",
		SubmittedAt: now, UpdatedAt: now, LastSeenAt: now,
	}}); err != nil {
		t.Fatalf("upsert cancelling snapshot: %v", err)
	}
	tasks, total, err := store.ListLongTaskTasks(LongTaskListFilter{Status: LongTaskCancelling})
	if err != nil || total != 1 || len(tasks) != 1 {
		t.Fatalf("list cancelling: total=%d len=%d err=%v", total, len(tasks), err)
	}
	if tasks[0].StateRevision != 2 || tasks[0].CancelRequestedBy != "admin" || tasks[0].CancelRequestedAt.IsZero() {
		t.Fatalf("cancel metadata not persisted: %+v", tasks[0])
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	// 迁移可重复执行：再次打开不报错、行数与数据不变。
	again, err := Open(path)
	if err != nil {
		t.Fatalf("reopen migrated store: %v", err)
	}
	defer again.Close()
	if countTable(t, again.db, "long_task_tasks") != 4 {
		t.Fatalf("repeat migration changed row count")
	}
	if !strings.Contains(longTaskTableSQL(t, again.db), "'cancelling'") {
		t.Fatalf("repeat migration lost the cancel states")
	}
}

func TestLongTaskControlS16FailedMigrationRollsBackLegacyTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt-long-tasks.db")
	legacy := openRawSQLite(t, path)
	execLegacy(t, legacy, corruptLegacyLongTaskDDL)
	base := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	insertLegacyLongTask(t, legacy, "lt-queued", "queued", "", base)
	insertLegacyLongTask(t, legacy, "lt-corrupt", "corrupt", "legacy garbage", base.Add(time.Minute))
	insertLegacyLongTask(t, legacy, "lt-done", "succeeded", "finished", base.Add(2*time.Minute))
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	if _, err := Open(path); err == nil {
		t.Fatalf("expected the migration to fail on the legacy status")
	} else if !strings.Contains(err.Error(), "migrate long task status constraint") {
		t.Fatalf("unexpected migration error: %v", err)
	}

	raw := openRawSQLite(t, path)
	defer raw.Close()
	columns := longTaskTableColumns(t, raw)
	if columns["state_revision"] || columns["cancelled_at"] {
		t.Fatalf("failed migration must roll back the rebuilt layout: %v", columns)
	}
	if countTable(t, raw, "long_task_tasks") != 3 {
		t.Fatalf("failed migration lost legacy rows")
	}
	var status string
	if err := raw.QueryRow(`SELECT status FROM long_task_tasks WHERE task_id = 'lt-corrupt'`).Scan(&status); err != nil {
		t.Fatalf("read legacy row: %v", err)
	}
	if status != "corrupt" {
		t.Fatalf("legacy row changed: %s", status)
	}
	var leftOver int
	if err := raw.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'long_task_tasks_legacy'`).Scan(&leftOver); err != nil {
		t.Fatalf("inspect legacy table: %v", err)
	}
	if leftOver != 0 {
		t.Fatalf("rolled-back migration left a legacy table behind")
	}
}

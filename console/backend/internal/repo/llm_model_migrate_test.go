package repo

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
)

// E-B01 [integration] 真实边界：SQLite 文件、schemaDDL、columnExists 的
// PRAGMA table_info 路径、migrate() 注册顺序 —— 均不 mock。
//
// 步骤：先手写一个不含 supports_images 列的"旧库"（模拟升级前的存量部署），
// 再通过 Open() 触发真实迁移，验证 ①二次迁移幂等 ②既有行取值逐行保全
// ③新列默认值为 0。
func TestMigrateLLMModelSupportsImagesIdempotentAndPreservesRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")

	legacy, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path))
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	// 与升级前部署一致的建表语句：注意没有 supports_images 列。
	if _, err := legacy.Exec(`CREATE TABLE llm_model_configs (
		model_config_id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		provider TEXT NOT NULL,
		base_url TEXT NOT NULL,
		api_key TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL,
		last_test_at TEXT NOT NULL DEFAULT '',
		last_test_ok INTEGER NOT NULL DEFAULT 0 CHECK (last_test_ok IN (0,1)),
		last_test_error TEXT NOT NULL DEFAULT '',
		supports_tools INTEGER NOT NULL DEFAULT 1 CHECK (supports_tools IN (0,1)),
		thinking TEXT NOT NULL DEFAULT 'off'
			CHECK (thinking IN ('off','minimal','low','medium','high','xhigh','max')),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	// 既有行显式置 supports_tools=0：若迁移实现有任何改写行为，断言会捕获。
	if _, err := legacy.Exec(`INSERT INTO llm_model_configs
		(model_config_id, display_name, provider, base_url, api_key, model,
		 supports_tools, thinking, created_at, updated_at)
		VALUES ('m1','legacy','deepseek','https://api.deepseek.com','sk-x','deepseek-flash',
		 0,'high','t','t')`); err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	// 第一次迁移。
	store, err := Open(path)
	if err != nil {
		t.Fatalf("first Open (migrate): %v", err)
	}

	assertLegacyRowPreserved := func(step string) {
		t.Helper()
		var supportsTools, supportsImages int
		if err := store.db.QueryRow(
			`SELECT supports_tools, supports_images FROM llm_model_configs WHERE model_config_id = 'm1'`,
		).Scan(&supportsTools, &supportsImages); err != nil {
			t.Fatalf("%s: select row: %v", step, err)
		}
		if supportsTools != 0 {
			t.Fatalf("%s: 既有 supports_tools 被迁移改写, got %d want 0", step, supportsTools)
		}
		if supportsImages != 0 {
			t.Fatalf("%s: supports_images 新列默认值应为 0, got %d", step, supportsImages)
		}
	}
	assertLegacyRowPreserved("after first migrate")

	// 第二次迁移必须幂等（columnExists 守卫命中，不再发 ALTER）。
	if err := store.migrate(); err != nil {
		t.Fatalf("second migrate 应幂等, got error: %v", err)
	}
	assertLegacyRowPreserved("after second migrate")

	var rows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM llm_model_configs`).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 1 {
		t.Fatalf("迁移前后行数应相等, got %d want 1", rows)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	// 第三次：完整重开，仍须幂等且数据保全。
	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen (third migrate): %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	var supportsTools, supportsImages int
	if err := reopened.db.QueryRow(
		`SELECT supports_tools, supports_images FROM llm_model_configs WHERE model_config_id = 'm1'`,
	).Scan(&supportsTools, &supportsImages); err != nil {
		t.Fatalf("reopen: select: %v", err)
	}
	if supportsTools != 0 || supportsImages != 0 {
		t.Fatalf("reopen: 取值应保持 tools=0 images=0, got tools=%d images=%d", supportsTools, supportsImages)
	}
}

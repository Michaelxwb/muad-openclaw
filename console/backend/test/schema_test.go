package test

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestOpen_CreatesMultiUserSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "console.db")
	store, err := repo.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	db := openSchemaDB(t, path)
	expected := []string{
		"pods", "human_users", "user_identities", "binding_codes", "platform_configs",
		"admins", "audit_log", "llm_model_configs", "resource_global",
		"skill_assets", "skill_policies", "skill_execution_records",
	}
	for _, table := range expected {
		if !schemaObjectExists(t, db, "table", table) {
			t.Errorf("table %q was not created", table)
		}
	}
	if schemaObjectExists(t, db, "table", "users") {
		t.Error("legacy users table must not be created")
	}
	indexes := []string{
		"idx_human_users_pod_status", "idx_identities_human_user",
		"idx_human_users_model_config",
		"idx_binding_codes_user_status", "idx_binding_codes_scope",
		"idx_binding_codes_expiry", "idx_audit_ts", "idx_audit_actor",
		"idx_skill_assets_scope_name", "idx_skill_assets_human_user",
		"idx_skill_assets_pod", "idx_skill_assets_status",
		"uidx_skill_public_name", "uidx_skill_private_user_name",
		"idx_skill_policies_human_user", "idx_skill_policies_skill_name",
		"idx_skill_executions_human_user_started", "idx_skill_executions_pod_started",
		"idx_skill_executions_skill_started", "idx_skill_executions_status_started",
	}
	for _, index := range indexes {
		if !schemaObjectExists(t, db, "index", index) {
			t.Errorf("index %q was not created", index)
		}
	}

	assertPragmaInt(t, db, "foreign_keys", 1)
	assertPragmaInt(t, db, "busy_timeout", 5000)
	var journalMode string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatalf("read journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("journal_mode = %q, want wal", journalMode)
	}
}

func TestOpen_RejectsLegacyUsersSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db := openSchemaDB(t, path)
	if _, err := db.Exec(`CREATE TABLE users (user_id TEXT PRIMARY KEY)`); err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	store, err := repo.Open(path)
	if store != nil {
		_ = store.Close()
	}
	if !errors.Is(err, repo.ErrLegacySchema) {
		t.Fatalf("Open error = %v, want ErrLegacySchema", err)
	}
}

func TestOpen_EnforcesMultiUserConstraints(t *testing.T) {
	path := filepath.Join(t.TempDir(), "constraints.db")
	store, err := repo.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	db := openSchemaDB(t, path)

	insertPod(t, db, "pod-a", "fingerprint-a")
	insertPod(t, db, "pod-b", "fingerprint-b")
	insertLLMModel(t, db, "model-a")
	if _, err := db.Exec(`INSERT INTO human_users (
		human_user_id, pod_id, model_config_id, display_name, agent_id, browser_profile,
		browser_cdp_port, status, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"user-a", "pod-a", "model-a", "Alice", "alice", "alice", 18802, "invalid", "now", "now"); err == nil {
		t.Fatal("expected invalid Human User status to fail")
	}
	if _, err := db.Exec(`INSERT INTO human_users (
		human_user_id, pod_id, model_config_id, display_name, agent_id, browser_profile,
		browser_cdp_port, status, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"user-a", "pod-a", "model-a", "Alice", "alice", "alice", 18802, "active", "now", "now"); err != nil {
		t.Fatalf("insert Human User: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO user_identities (
		identity_id, human_user_id, pod_id, channel, openclaw_channel,
		external_id, external_id_type, status, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"identity-a", "user-a", "pod-b", "wecom", "wecom", "sender-a",
		"scoped_userid", "active", "now", "now"); err == nil {
		t.Fatal("expected composite Human User/Pod foreign key to fail")
	}
}

func openSchemaDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func schemaObjectExists(t *testing.T, db *sql.DB, kind, name string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?`,
		kind, name,
	).Scan(&count); err != nil {
		t.Fatalf("inspect schema object %s/%s: %v", kind, name, err)
	}
	return count == 1
}

func assertPragmaInt(t *testing.T, db *sql.DB, pragma string, want int) {
	t.Helper()
	var got int
	var row *sql.Row
	switch pragma {
	case "foreign_keys":
		row = db.QueryRow(`PRAGMA foreign_keys`)
	case "busy_timeout":
		row = db.QueryRow(`PRAGMA busy_timeout`)
	default:
		t.Fatalf("unsupported pragma %q", pragma)
	}
	if err := row.Scan(&got); err != nil {
		t.Fatalf("read %s: %v", pragma, err)
	}
	if got != want {
		t.Errorf("%s = %d, want %d", pragma, got, want)
	}
}

func insertPod(t *testing.T, db *sql.DB, podID, fingerprint string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO pods (
		pod_id, display_name, service_token_enc, service_token_fingerprint,
		service_token_rotated_at, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		podID, podID, "ciphertext", fingerprint, "now", "now", "now")
	if err != nil {
		t.Fatalf("insert Pod %s: %v", podID, err)
	}
}

func insertLLMModel(t *testing.T, db *sql.DB, modelConfigID string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO llm_model_configs (
		model_config_id, display_name, provider, base_url, api_key_enc,
		api_key_fingerprint, model, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		modelConfigID, modelConfigID, "deepseek", "https://api.deepseek.com",
		"ciphertext", "fingerprint-"+modelConfigID, "deepseek-chat", "now", "now")
	if err != nil {
		t.Fatalf("insert LLM model %s: %v", modelConfigID, err)
	}
}

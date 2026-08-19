package test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// TestOpen_MigratesPodAgnosticSchema builds a legacy pod-scoped database
// (user_identities/skill_assets carry pod_id, human_users lacks last_pod_id),
// opens it through repo.Open, and verifies data survives with the new shape.
func TestOpen_MigratesPodAgnosticSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pod-agnostic-migration.db")
	preparePodAgnosticLegacyDatabase(t, path)

	store, err := repo.Open(path)
	if err != nil {
		t.Fatalf("Open migrated database: %v", err)
	}
	defer func() { _ = store.Close() }()

	// Schema shape: last_pod_id present, pod_id dropped from identity/skill.
	if !tableColumnExists(t, openSchemaDB(t, path), "human_users", "last_pod_id") {
		t.Fatal("human_users.last_pod_id missing after migration")
	}
	if !tableColumnExists(t, openSchemaDB(t, path), "human_users", "prompt") {
		t.Fatal("human_users.prompt missing after migration")
	}
	if tableColumnExists(t, openSchemaDB(t, path), "human_users", "notes") {
		t.Fatal("human_users.notes still present after migration")
	}
	if tableColumnExists(t, openSchemaDB(t, path), "user_identities", "pod_id") {
		t.Fatal("user_identities.pod_id still present after migration")
	}
	if tableColumnExists(t, openSchemaDB(t, path), "skill_assets", "pod_id") {
		t.Fatal("skill_assets.pod_id still present after migration")
	}

	// Data preserved.
	user, err := store.GetHumanUser("user-1")
	if err != nil {
		t.Fatalf("GetHumanUser after migration: %v", err)
	}
	if user.AgentID != "alice" || user.LastPodID != "" || user.PodID != "pod-a" {
		t.Fatalf("migrated user = %+v", user)
	}
	if user.Prompt != "owner note" {
		t.Fatalf("legacy notes did not land in prompt: %q", user.Prompt)
	}
	idents, err := store.ListIdentitiesByHumanUser("user-1")
	if err != nil {
		t.Fatalf("ListIdentitiesByHumanUser: %v", err)
	}
	if len(idents) != 1 || idents[0].ExternalID != "wx-alice" {
		t.Fatalf("migrated identities = %+v", idents)
	}
	skill, err := store.GetSkillAsset("skill-1")
	if err != nil {
		t.Fatalf("GetSkillAsset after migration: %v", err)
	}
	if skill.HumanUserID != "user-1" {
		t.Fatalf("migrated skill owner = %q", skill.HumanUserID)
	}
}

// preparePodAgnosticLegacyDatabase creates a database matching the pre-change
// pod-scoped schema for the tables the pod-agnostic migration rebuilds.
func preparePodAgnosticLegacyDatabase(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatalf("enable FK: %v", err)
	}
	for _, stmt := range []string{
		`CREATE TABLE pods (
			pod_id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL DEFAULT '',
			image_tag TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL DEFAULT 'creating',
			max_users INTEGER NOT NULL DEFAULT 10,
			channels TEXT NOT NULL DEFAULT '[]',
			channel_configs_enc TEXT NOT NULL DEFAULT '',
			mem_limit TEXT NOT NULL DEFAULT '',
			cpu_limit TEXT NOT NULL DEFAULT '',
			restart_policy TEXT NOT NULL DEFAULT '',
			max_skill_concurrency INTEGER NOT NULL DEFAULT 0,
			max_browser_concurrency INTEGER NOT NULL DEFAULT 0,
			service_token_enc TEXT NOT NULL,
			service_token_fingerprint TEXT NOT NULL UNIQUE,
			service_token_rotated_at TEXT NOT NULL,
			config_generation INTEGER NOT NULL DEFAULT 1,
			applied_generation INTEGER NOT NULL DEFAULT 0,
			last_config_hash TEXT NOT NULL DEFAULT '',
			last_apply_status TEXT NOT NULL DEFAULT 'pending',
			last_apply_error TEXT NOT NULL DEFAULT '',
			last_applied_at TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE llm_model_configs (
			model_config_id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			provider TEXT NOT NULL,
			base_url TEXT NOT NULL,
			api_key TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL,
			last_test_at TEXT NOT NULL DEFAULT '',
			last_test_ok INTEGER NOT NULL DEFAULT 0,
			last_test_error TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE human_users (
			human_user_id TEXT PRIMARY KEY,
			pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
			model_config_id TEXT NOT NULL REFERENCES llm_model_configs(model_config_id),
			display_name TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			browser_profile TEXT NOT NULL,
			browser_cdp_port INTEGER NOT NULL,
			status TEXT NOT NULL,
			notes TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (human_user_id, pod_id)
		);`,
		`CREATE TABLE user_identities (
			identity_id TEXT PRIMARY KEY,
			human_user_id TEXT NOT NULL,
			pod_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			openclaw_channel TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT 'default',
			external_id TEXT NOT NULL,
			external_id_type TEXT NOT NULL,
			peer_kind TEXT NOT NULL DEFAULT 'direct',
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`CREATE TABLE skill_assets (
			skill_id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			scope TEXT NOT NULL,
			human_user_id TEXT,
			pod_id TEXT,
			display_name TEXT NOT NULL,
			version TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			source_path TEXT NOT NULL,
			manifest_hash TEXT NOT NULL,
			manifest_json TEXT NOT NULL DEFAULT '{}',
			entry_type TEXT NOT NULL DEFAULT 'managed',
			platforms_json TEXT NOT NULL DEFAULT '[]',
			browser_required INTEGER NOT NULL DEFAULT 0,
			progress_supported INTEGER NOT NULL DEFAULT 0,
			system_protected INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);`,
		`INSERT INTO pods (pod_id, service_token_enc, service_token_fingerprint, service_token_rotated_at, created_at, updated_at)
			VALUES ('pod-a', 'enc', 'sha256:pod-a', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
		`INSERT INTO llm_model_configs (model_config_id, display_name, provider, base_url, model, created_at, updated_at)
			VALUES ('model-1', 'm', 'p', 'u', 'm', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
		`INSERT INTO human_users (human_user_id, pod_id, model_config_id, display_name, agent_id, browser_profile, browser_cdp_port, status, notes, created_at, updated_at)
			VALUES ('user-1', 'pod-a', 'model-1', 'Alice', 'alice', 'alice', 18802, 'active', 'owner note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
		`INSERT INTO user_identities (identity_id, human_user_id, pod_id, channel, openclaw_channel, external_id, external_id_type, peer_kind, status, created_at, updated_at)
			VALUES ('identity-1', 'user-1', 'pod-a', 'wechat', 'openclaw-weixin', 'wx-alice', 'openid', 'direct', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
		`INSERT INTO skill_assets (skill_id, name, scope, human_user_id, pod_id, display_name, status, source_path, manifest_hash, created_at, updated_at)
			VALUES ('skill-1', 'alert', 'private', 'user-1', 'pod-a', 'alert', 'active', '/w', 'sha256:s', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed legacy schema: %v", err)
		}
	}
}

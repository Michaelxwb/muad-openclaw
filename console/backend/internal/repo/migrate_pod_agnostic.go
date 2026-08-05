package repo

import (
	"fmt"
)

// migratePodAgnosticUsers removes pod-scoping from user-owned records so a
// Human User and its assets (IM identities, private Skills) survive Pod
// deletion. human_users becomes the single holder of pod membership
// (pod_id nullable + last_pod_id backfill), and user_identities / skill_assets
// drop their pod_id columns. binding_codes / skill_execution_records keep
// pod_id and their composite FK stays valid because human_users keeps
// UNIQUE(human_user_id, pod_id).
//
// This migration rebuilds three tables (SQLite cannot ALTER constraints) and
// must run with foreign_keys=OFF because the parent table is renamed first.
func (s *Store) migratePodAgnosticUsers() error {
	hasPodID, err := columnExists(s.db, "user_identities", "pod_id")
	if err != nil {
		return fmt.Errorf("inspect user_identities schema: %w", err)
	}
	if !hasPodID {
		// Already on the pod-agnostic schema (or a fresh DB from the new DDL).
		return nil
	}
	if _, err := s.db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		return fmt.Errorf("disable foreign keys for migration: %w", err)
	}
	defer func() { _, _ = s.db.Exec(`PRAGMA foreign_keys=ON`) }()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin pod-agnostic migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(podAgnosticMigrationStatements); err != nil {
		return fmt.Errorf("migrate pod-agnostic schema: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit pod-agnostic migration: %w", err)
	}
	return nil
}

const podAgnosticMigrationStatements = `
ALTER TABLE human_users RENAME TO human_users_legacy;
CREATE TABLE human_users (
	human_user_id TEXT PRIMARY KEY,
	pod_id TEXT REFERENCES pods(pod_id),
	model_config_id TEXT NOT NULL REFERENCES llm_model_configs(model_config_id) ON DELETE RESTRICT,
	display_name TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	browser_profile TEXT NOT NULL,
	browser_cdp_port INTEGER NOT NULL CHECK (browser_cdp_port = 0 OR browser_cdp_port BETWEEN 1024 AND 65535),
	status TEXT NOT NULL CHECK (status IN ('pending','active','disabled','deleting')),
	notes TEXT NOT NULL DEFAULT '',
	last_pod_id TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (agent_id NOT IN ('main','quarantine')),
	CHECK (browser_profile NOT IN ('main','quarantine')),
	UNIQUE (human_user_id, pod_id),
	UNIQUE (pod_id, agent_id),
	UNIQUE (pod_id, browser_profile),
	UNIQUE (pod_id, browser_cdp_port)
);
INSERT INTO human_users (
	human_user_id, pod_id, model_config_id, display_name, agent_id, browser_profile,
	browser_cdp_port, status, notes, created_at, updated_at, last_pod_id
) SELECT human_user_id, pod_id, model_config_id, display_name, agent_id, browser_profile,
	browser_cdp_port, status, notes, created_at, updated_at, '' FROM human_users_legacy;
DROP TABLE human_users_legacy;
CREATE INDEX IF NOT EXISTS idx_human_users_pod_status ON human_users(pod_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_users_model_config ON human_users(model_config_id);

ALTER TABLE user_identities RENAME TO user_identities_legacy;
CREATE TABLE user_identities (
	identity_id TEXT PRIMARY KEY,
	human_user_id TEXT NOT NULL,
	channel TEXT NOT NULL,
	openclaw_channel TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT 'default',
	external_id TEXT NOT NULL,
	external_id_type TEXT NOT NULL,
	peer_kind TEXT NOT NULL DEFAULT 'direct',
	status TEXT NOT NULL CHECK (status IN ('active','disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (human_user_id) REFERENCES human_users(human_user_id) ON DELETE CASCADE,
	UNIQUE (human_user_id, openclaw_channel, account_id, peer_kind, external_id)
);
INSERT INTO user_identities (
	identity_id, human_user_id, channel, openclaw_channel, account_id, external_id,
	external_id_type, peer_kind, status, created_at, updated_at
) SELECT identity_id, human_user_id, channel, openclaw_channel, account_id, external_id,
	external_id_type, peer_kind, status, created_at, updated_at FROM user_identities_legacy;
DROP TABLE user_identities_legacy;
CREATE INDEX IF NOT EXISTS idx_identities_human_user ON user_identities(human_user_id);

ALTER TABLE skill_assets RENAME TO skill_assets_legacy;
CREATE TABLE skill_assets (
	skill_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('system','public','private')),
	human_user_id TEXT,
	display_name TEXT NOT NULL,
	version TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active','disabled','deleted')),
	source_path TEXT NOT NULL,
	manifest_hash TEXT NOT NULL,
	manifest_json TEXT NOT NULL DEFAULT '{}',
	entry_type TEXT NOT NULL DEFAULT 'managed',
	platforms_json TEXT NOT NULL DEFAULT '[]',
	browser_required INTEGER NOT NULL DEFAULT 0 CHECK (browser_required IN (0,1)),
	progress_supported INTEGER NOT NULL DEFAULT 0 CHECK (progress_supported IN (0,1)),
	system_protected INTEGER NOT NULL DEFAULT 0 CHECK (system_protected IN (0,1)),
	source TEXT NOT NULL DEFAULT 'platform',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (human_user_id) REFERENCES human_users(human_user_id) ON DELETE CASCADE,
	CHECK (
		(scope = 'private' AND human_user_id IS NOT NULL)
		OR (scope IN ('system','public') AND human_user_id IS NULL)
	)
);
INSERT INTO skill_assets (
	skill_id, name, scope, human_user_id, display_name, version, status, source_path,
	manifest_hash, manifest_json, entry_type, platforms_json, browser_required,
	progress_supported, system_protected, source, created_at, updated_at
) SELECT skill_id, name, scope, human_user_id, display_name, version, status, source_path,
	manifest_hash, manifest_json, entry_type, platforms_json, browser_required,
	progress_supported, system_protected, source, created_at, updated_at FROM skill_assets_legacy;
DROP TABLE skill_assets_legacy;
CREATE INDEX IF NOT EXISTS idx_skill_assets_scope_name ON skill_assets(scope, name);
CREATE INDEX IF NOT EXISTS idx_skill_assets_human_user ON skill_assets(human_user_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_assets_status ON skill_assets(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_skill_public_name
	ON skill_assets(name) WHERE scope IN ('system','public') AND status != 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS uidx_skill_private_user_name
	ON skill_assets(human_user_id, name) WHERE scope = 'private' AND status != 'deleted';
`

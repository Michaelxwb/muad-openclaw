package repo

import (
	"database/sql"
	"errors"
	"fmt"
)

const schemaDDL = `
CREATE TABLE IF NOT EXISTS pods (
	pod_id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	image_tag TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'creating'
		CHECK (state IN ('creating','running','stopped','unhealthy','error','deleting')),
	max_users INTEGER NOT NULL DEFAULT 10 CHECK (max_users > 0),
	channels TEXT NOT NULL DEFAULT '[]',
	channel_configs_enc TEXT NOT NULL DEFAULT '',
	mem_limit TEXT NOT NULL DEFAULT '',
	cpu_limit TEXT NOT NULL DEFAULT '',
	restart_policy TEXT NOT NULL DEFAULT '',
	max_skill_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_skill_concurrency >= 0),
	max_browser_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_browser_concurrency >= 0),
	service_token_enc TEXT NOT NULL,
	service_token_fingerprint TEXT NOT NULL UNIQUE,
	service_token_rotated_at TEXT NOT NULL,
	config_generation INTEGER NOT NULL DEFAULT 1 CHECK (config_generation > 0),
	applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (applied_generation >= 0),
	last_config_hash TEXT NOT NULL DEFAULT '',
	last_apply_status TEXT NOT NULL DEFAULT 'pending'
		CHECK (last_apply_status IN ('pending','applying','applied','failed')),
	last_apply_error TEXT NOT NULL DEFAULT '',
	last_applied_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (applied_generation <= config_generation)
);

CREATE TABLE IF NOT EXISTS llm_model_configs (
	model_config_id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	provider TEXT NOT NULL,
	base_url TEXT NOT NULL,
	api_key_enc TEXT NOT NULL,
	api_key_fingerprint TEXT NOT NULL,
	model TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_users (
	human_user_id TEXT PRIMARY KEY,
	pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
	model_config_id TEXT NOT NULL REFERENCES llm_model_configs(model_config_id) ON DELETE RESTRICT,
	display_name TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	browser_profile TEXT NOT NULL,
	browser_cdp_port INTEGER NOT NULL CHECK (browser_cdp_port BETWEEN 1024 AND 65535),
	status TEXT NOT NULL CHECK (status IN ('pending','active','disabled','deleting')),
	platform_credentials_enc TEXT NOT NULL DEFAULT '',
	notes TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (agent_id NOT IN ('main','quarantine')),
	CHECK (browser_profile NOT IN ('main','quarantine')),
	UNIQUE (human_user_id, pod_id),
	UNIQUE (pod_id, agent_id),
	UNIQUE (pod_id, browser_profile),
	UNIQUE (pod_id, browser_cdp_port)
);
CREATE INDEX IF NOT EXISTS idx_human_users_pod_status ON human_users(pod_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_users_model_config
	ON human_users(model_config_id);

CREATE TABLE IF NOT EXISTS user_identities (
	identity_id TEXT PRIMARY KEY,
	human_user_id TEXT NOT NULL,
	pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	openclaw_channel TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT 'default',
	external_id TEXT NOT NULL,
	external_id_type TEXT NOT NULL,
	peer_kind TEXT NOT NULL DEFAULT 'direct',
	status TEXT NOT NULL CHECK (status IN ('active','disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (human_user_id, pod_id)
		REFERENCES human_users(human_user_id, pod_id) ON DELETE CASCADE,
	UNIQUE (pod_id, openclaw_channel, account_id, peer_kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_human_user ON user_identities(human_user_id);

CREATE TABLE IF NOT EXISTS binding_codes (
	binding_code_id TEXT PRIMARY KEY,
	code_hash TEXT NOT NULL UNIQUE,
	code_hint TEXT NOT NULL,
	human_user_id TEXT NOT NULL,
	pod_id TEXT NOT NULL REFERENCES pods(pod_id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	openclaw_channel TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT 'default',
	purpose TEXT NOT NULL CHECK (purpose IN ('create_user_first_identity','add_identity_to_existing_user')),
	status TEXT NOT NULL CHECK (status IN ('pending','used','expired','revoked')),
	failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
	expires_at TEXT NOT NULL,
	used_at TEXT NOT NULL DEFAULT '',
	used_external_id TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (human_user_id, pod_id)
		REFERENCES human_users(human_user_id, pod_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_binding_codes_user_status ON binding_codes(human_user_id, status);
CREATE INDEX IF NOT EXISTS idx_binding_codes_scope ON binding_codes(pod_id, openclaw_channel, status);
CREATE INDEX IF NOT EXISTS idx_binding_codes_expiry ON binding_codes(status, expires_at);

CREATE TABLE IF NOT EXISTS platform_configs (
	platform TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	config_enc TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target TEXT NOT NULL DEFAULT '',
	payload TEXT NOT NULL DEFAULT '',
	ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, ts);

CREATE TABLE IF NOT EXISTS admins (
	username TEXT PRIMARY KEY,
	password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_global (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	mem_limit TEXT NOT NULL DEFAULT '',
	cpu_limit TEXT NOT NULL DEFAULT '',
	restart_policy TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);`

func (s *Store) migrate() error {
	legacy, err := tableExists(s.db, "users")
	if err != nil {
		return fmt.Errorf("inspect legacy schema: %w", err)
	}
	if legacy {
		return ErrLegacySchema
	}
	if _, err := s.db.Exec(schemaDDL); err != nil {
		return fmt.Errorf("create multi-user schema: %w", err)
	}
	if err := s.seedPlatformConfigs(); err != nil {
		return err
	}
	return nil
}

func tableExists(db *sql.DB, name string) (bool, error) {
	var found string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

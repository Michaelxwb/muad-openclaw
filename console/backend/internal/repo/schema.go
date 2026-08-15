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
	max_long_task_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_long_task_concurrency >= 0),
	service_token_enc TEXT NOT NULL,
	service_token_fingerprint TEXT NOT NULL UNIQUE,
	service_token_rotated_at TEXT NOT NULL,
	config_generation INTEGER NOT NULL DEFAULT 1 CHECK (config_generation > 0),
	applied_generation INTEGER NOT NULL DEFAULT 0 CHECK (applied_generation >= 0),
	skills_pending INTEGER NOT NULL DEFAULT 0 CHECK (skills_pending IN (0,1)),
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
	api_key TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL,
	last_test_at TEXT NOT NULL DEFAULT '',
	last_test_ok INTEGER NOT NULL DEFAULT 0 CHECK (last_test_ok IN (0,1)),
	last_test_error TEXT NOT NULL DEFAULT '',
	supports_tools INTEGER NOT NULL DEFAULT 1 CHECK (supports_tools IN (0,1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_users (
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
CREATE INDEX IF NOT EXISTS idx_human_users_pod_status ON human_users(pod_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_users_model_config
	ON human_users(model_config_id);

CREATE TABLE IF NOT EXISTS user_identities (
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
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_platform_credentials (
	human_user_id TEXT NOT NULL REFERENCES human_users(human_user_id) ON DELETE CASCADE,
	platform TEXT NOT NULL REFERENCES platform_configs(platform) ON DELETE CASCADE,
	credentials_json TEXT NOT NULL,
	credential_fingerprint TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (human_user_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_user_platform_credentials_platform
	ON user_platform_credentials(platform);

CREATE TABLE IF NOT EXISTS skill_assets (
	skill_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('system','public','private')),
	human_user_id TEXT,
	display_name TEXT NOT NULL,
	version TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active','disabled','pending','deleted')),
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
CREATE INDEX IF NOT EXISTS idx_skill_assets_scope_name ON skill_assets(scope, name);
CREATE INDEX IF NOT EXISTS idx_skill_assets_human_user ON skill_assets(human_user_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_assets_status ON skill_assets(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_skill_public_name
	ON skill_assets(name) WHERE scope IN ('system','public') AND status != 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS uidx_skill_private_user_name
	ON skill_assets(human_user_id, name) WHERE scope = 'private' AND status != 'deleted';

CREATE TABLE IF NOT EXISTS skill_policies (
	policy_id TEXT PRIMARY KEY,
	human_user_id TEXT NOT NULL REFERENCES human_users(human_user_id) ON DELETE CASCADE,
	skill_name TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('disable','allow_override')),
	reason TEXT NOT NULL DEFAULT '',
	created_by TEXT NOT NULL,
	expires_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_policies_human_user ON skill_policies(human_user_id);
CREATE INDEX IF NOT EXISTS idx_skill_policies_skill_name ON skill_policies(skill_name);

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
	max_skill_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_skill_concurrency >= 0),
	max_browser_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_browser_concurrency >= 0),
	max_long_task_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_long_task_concurrency >= 0),
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_guidance (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	user_skill TEXT NOT NULL DEFAULT '',
	memory TEXT NOT NULL DEFAULT '',
	main TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS long_task_tasks (
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
CREATE INDEX IF NOT EXISTS idx_long_task_pod_updated ON long_task_tasks(pod_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_long_task_user_status ON long_task_tasks(human_user_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_long_task_pool_status ON long_task_tasks(pool_key, status, submitted_at);`

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
	if err := s.migrateLLMModelSupportsTools(); err != nil {
		return err
	}
	if err := s.migratePodSkillsPending(); err != nil {
		return err
	}
	if err := s.migratePodLongTaskConcurrency(); err != nil {
		return err
	}
	if err := s.migrateResourceGlobalConcurrency(); err != nil {
		return err
	}
	if err := s.migrateSkillAssetEntryTypes(); err != nil {
		return err
	}
	if err := s.migrateSkillAssetSource(); err != nil {
		return err
	}
	if err := s.migratePodAgnosticUsers(); err != nil {
		return err
	}
	if err := s.migrateSkillAssetStatusPending(); err != nil {
		return err
	}
	if err := s.migrateSkillExecutionRecords(); err != nil {
		return err
	}
	if err := s.migrateLongTaskTasks(); err != nil {
		return err
	}
	return nil
}

// migrateSkillAssetStatusPending rebuilds skill_assets to add 'pending' to the
// status CHECK constraint (SQLite cannot ALTER a CHECK). Existing rows are copied
// unchanged; fresh databases already carry the updated DDL.
func (s *Store) migrateSkillAssetStatusPending() error {
	allows, err := skillAssetsAllowsPending(s.db)
	if err != nil {
		return err
	}
	if allows {
		return nil
	}
	if _, err := s.db.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		return fmt.Errorf("disable foreign keys for skill status migration: %w", err)
	}
	defer func() { _, _ = s.db.Exec(`PRAGMA foreign_keys=ON`) }()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin skill status migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(skillAssetStatusPendingStatements); err != nil {
		return fmt.Errorf("migrate skill status: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit skill status migration: %w", err)
	}
	return nil
}

func skillAssetsAllowsPending(db *sql.DB) (bool, error) {
	var one int
	err := db.QueryRow(`SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'skill_assets' AND sql LIKE "%'pending'%"`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect skill_assets schema: %w", err)
	}
	return true, nil
}

const skillAssetStatusPendingStatements = `
ALTER TABLE skill_assets RENAME TO skill_assets_legacy;
CREATE TABLE skill_assets (
	skill_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('system','public','private')),
	human_user_id TEXT,
	display_name TEXT NOT NULL,
	version TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active','disabled','pending','deleted')),
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

func (s *Store) migrateLLMModelSupportsTools() error {
	exists, err := columnExists(s.db, "llm_model_configs", "supports_tools")
	if err != nil {
		return fmt.Errorf("inspect LLM model supports_tools column: %w", err)
	}
	if exists {
		return nil
	}
	if _, err := s.db.Exec(`ALTER TABLE llm_model_configs
		ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 1
		CHECK (supports_tools IN (0,1))`); err != nil {
		return fmt.Errorf("add LLM model supports_tools column: %w", err)
	}
	return nil
}

func (s *Store) migratePodSkillsPending() error {
	exists, err := columnExists(s.db, "pods", "skills_pending")
	if err != nil {
		return fmt.Errorf("inspect Pod skills_pending column: %w", err)
	}
	if exists {
		return nil
	}
	_, err = s.db.Exec(`ALTER TABLE pods ADD COLUMN skills_pending INTEGER NOT NULL DEFAULT 0
		CHECK (skills_pending IN (0,1))`)
	if err != nil {
		return fmt.Errorf("add Pod skills_pending column: %w", err)
	}
	return nil
}

func (s *Store) migratePodLongTaskConcurrency() error {
	exists, err := columnExists(s.db, "pods", "max_long_task_concurrency")
	if err != nil {
		return fmt.Errorf("inspect Pod max_long_task_concurrency column: %w", err)
	}
	if exists {
		return nil
	}
	_, err = s.db.Exec(`ALTER TABLE pods ADD COLUMN max_long_task_concurrency INTEGER NOT NULL DEFAULT 0
		CHECK (max_long_task_concurrency >= 0)`)
	if err != nil {
		return fmt.Errorf("add Pod max_long_task_concurrency column: %w", err)
	}
	return nil
}

func (s *Store) migrateResourceGlobalConcurrency() error {
	for _, column := range []string{
		"max_skill_concurrency", "max_browser_concurrency", "max_long_task_concurrency",
	} {
		if err := s.addResourceGlobalConcurrencyColumn(column); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) addResourceGlobalConcurrencyColumn(column string) error {
	exists, err := columnExists(s.db, "resource_global", column)
	if err != nil {
		return fmt.Errorf("inspect resource_global %s column: %w", column, err)
	}
	if exists {
		return nil
	}
	if _, err := s.db.Exec(`ALTER TABLE resource_global ADD COLUMN ` + column + ` INTEGER NOT NULL DEFAULT 0
		CHECK (` + column + ` >= 0)`); err != nil {
		return fmt.Errorf("add resource_global %s column: %w", column, err)
	}
	return nil
}

func (s *Store) migrateSkillAssetEntryTypes() error {
	_, err := s.db.Exec(`UPDATE skill_assets
		SET entry_type = CASE entry_type
			WHEN 'prompt-only' THEN 'traditional-prompt'
			WHEN 'script' THEN 'traditional-script'
			ELSE entry_type
		END
		WHERE entry_type IN ('prompt-only', 'script')`)
	if err != nil {
		return fmt.Errorf("migrate Skill asset entry types: %w", err)
	}
	return nil
}

// migrateSkillAssetSource adds the `source` column ('user'|'platform', default
// 'platform') for UI distinction of user-authored vs platform skills. Existing
// rows stay 'platform'; operators may backfill ingest-uploaded skills to 'user'.
func (s *Store) migrateSkillAssetSource() error {
	exists, err := columnExists(s.db, "skill_assets", "source")
	if err != nil {
		return fmt.Errorf("inspect Skill asset source column: %w", err)
	}
	if exists {
		return nil
	}
	if _, err := s.db.Exec(`ALTER TABLE skill_assets
		ADD COLUMN source TEXT NOT NULL DEFAULT 'platform'`); err != nil {
		return fmt.Errorf("add Skill asset source column: %w", err)
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

func columnExists(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

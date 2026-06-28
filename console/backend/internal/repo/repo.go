// Package repo is the SQLite persistence layer for the console: user records,
// global LLM config, audit log, and admin accounts (§3.3). Runtime monitoring
// data is NOT persisted here — it lives in the collector's in-memory cache.
package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrUserExists is returned when creating a user_id that already exists (E-01).
var ErrUserExists = errors.New("repo: user already exists")

// ErrNotFound is returned when a row is absent.
var ErrNotFound = errors.New("repo: not found")

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

// User is a persisted user/container record. Secret/override hold ciphertext.
type User struct {
	UserID      string
	Channel     string // message channel: "wecom" | "wechat"
	BotID       string
	SecretEnc   string
	LLMOverride string // encrypted JSON, empty when inheriting global
	ImageTag    string
	State       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// LLMGlobal is the single-row global LLM default. APIKeyEnc holds ciphertext.
type LLMGlobal struct {
	Provider  string
	BaseURL   string
	APIKeyEnc string
	Model     string
	UpdatedAt time.Time
}

// AuditEntry is one audit record (payload already redacted).
type AuditEntry struct {
	ID      int64     `json:"id"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	Target  string    `json:"target"`
	Payload string    `json:"payload"`
	TS      time.Time `json:"ts"`
}

// Admin is an admin account.
type Admin struct {
	Username     string
	PasswordHash string
}

const tsLayout = time.RFC3339Nano

// Open opens (creating if needed) the SQLite database and runs migrations.
func Open(path string) (*Store, error) {
	// Auto-create the parent directory so users don't need to pre-create
	// e.g. /var/lib/muad-console/ when running outside Docker.
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, fmt.Errorf("create db directory %s: %w", dir, err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; avoids SQLITE_BUSY under concurrency
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	const ddl = `
CREATE TABLE IF NOT EXISTS users (
	user_id      TEXT PRIMARY KEY,
	channel      TEXT NOT NULL DEFAULT 'wecom',
	bot_id       TEXT NOT NULL,
	secret_enc   TEXT NOT NULL,
	llm_override TEXT NOT NULL DEFAULT '',
	image_tag    TEXT NOT NULL,
	state        TEXT NOT NULL DEFAULT 'creating',
	created_at   TEXT NOT NULL,
	updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_global (
	id          INTEGER PRIMARY KEY CHECK (id = 1),
	provider    TEXT NOT NULL,
	base_url    TEXT NOT NULL,
	api_key_enc TEXT NOT NULL,
	model       TEXT NOT NULL,
	updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	actor   TEXT NOT NULL,
	action  TEXT NOT NULL,
	target  TEXT NOT NULL DEFAULT '',
	payload TEXT NOT NULL DEFAULT '',
	ts      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, ts);
CREATE TABLE IF NOT EXISTS admins (
	username      TEXT PRIMARY KEY,
	password_hash TEXT NOT NULL
);`
	if _, err := s.db.Exec(ddl); err != nil {
		return err
	}
	// Additive migration for DBs created before the `channel` column existed.
	// SQLite lacks ADD COLUMN IF NOT EXISTS, so tolerate the duplicate error.
	if _, err := s.db.Exec(`ALTER TABLE users ADD COLUMN channel TEXT NOT NULL DEFAULT 'wecom'`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		return err
	}
	return nil
}

// --- users ---

// CreateUser inserts a new user; returns ErrUserExists on user_id conflict.
func (s *Store) CreateUser(u User) error {
	now := time.Now().UTC().Format(tsLayout)
	_, err := s.db.Exec(
		`INSERT INTO users (user_id, channel, bot_id, secret_enc, llm_override, image_tag, state, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.UserID, defaultChannel(u.Channel), u.BotID, u.SecretEnc, u.LLMOverride, u.ImageTag, defaultState(u.State), now, now,
	)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return ErrUserExists
	}
	return err
}

// GetUser returns one user or ErrNotFound.
func (s *Store) GetUser(userID string) (User, error) {
	row := s.db.QueryRow(
		`SELECT user_id, channel, bot_id, secret_enc, llm_override, image_tag, state, created_at, updated_at
		 FROM users WHERE user_id = ?`, userID)
	return scanUser(row)
}

// ListUsers returns users with pagination. offset=0, limit=0 means "all".
func (s *Store) ListUsers(offset, limit int) ([]User, int, error) {
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := `SELECT user_id, channel, bot_id, secret_enc, llm_override, image_tag, state, created_at, updated_at
		 FROM users ORDER BY user_id`
	var args []any
	if limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// UpdateUserState sets a user's state.
func (s *Store) UpdateUserState(userID, state string) error {
	return s.touch(`UPDATE users SET state = ?, updated_at = ? WHERE user_id = ?`, state, userID)
}

// UpdateUserImageTag sets a user's image tag (FEAT-14 upgrade).
func (s *Store) UpdateUserImageTag(userID, tag string) error {
	return s.touch(`UPDATE users SET image_tag = ?, updated_at = ? WHERE user_id = ?`, tag, userID)
}

// UpdateUserLLMOverride sets a user's encrypted per-user LLM override (FEAT-04).
func (s *Store) UpdateUserLLMOverride(userID, enc string) error {
	return s.touch(`UPDATE users SET llm_override = ?, updated_at = ? WHERE user_id = ?`, enc, userID)
}

// DeleteUser removes a user record.
func (s *Store) DeleteUser(userID string) error {
	res, err := s.db.Exec(`DELETE FROM users WHERE user_id = ?`, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) touch(query, value, userID string) error {
	now := time.Now().UTC().Format(tsLayout)
	res, err := s.db.Exec(query, value, now, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- llm_global ---

// SetLLMGlobal upserts the single global LLM row.
func (s *Store) SetLLMGlobal(g LLMGlobal) error {
	now := time.Now().UTC().Format(tsLayout)
	_, err := s.db.Exec(
		`INSERT INTO llm_global (id, provider, base_url, api_key_enc, model, updated_at)
		 VALUES (1, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   provider=excluded.provider, base_url=excluded.base_url,
		   api_key_enc=excluded.api_key_enc, model=excluded.model, updated_at=excluded.updated_at`,
		g.Provider, g.BaseURL, g.APIKeyEnc, g.Model, now,
	)
	return err
}

// GetLLMGlobal returns the global LLM row or ErrNotFound when unset.
func (s *Store) GetLLMGlobal() (LLMGlobal, error) {
	row := s.db.QueryRow(`SELECT provider, base_url, api_key_enc, model, updated_at FROM llm_global WHERE id = 1`)
	var g LLMGlobal
	var ts string
	switch err := row.Scan(&g.Provider, &g.BaseURL, &g.APIKeyEnc, &g.Model, &ts); err {
	case sql.ErrNoRows:
		return LLMGlobal{}, ErrNotFound
	case nil:
		g.UpdatedAt, _ = time.Parse(tsLayout, ts)
		return g, nil
	default:
		return LLMGlobal{}, err
	}
}

// --- audit_log ---

// AddAudit appends an audit record.
func (s *Store) AddAudit(e AuditEntry) error {
	ts := time.Now().UTC()
	if !e.TS.IsZero() {
		ts = e.TS.UTC()
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_log (actor, action, target, payload, ts) VALUES (?, ?, ?, ?, ?)`,
		e.Actor, e.Action, e.Target, e.Payload, ts.Format(tsLayout),
	)
	return err
}

// QueryAudit returns audit entries filtered by actor (optional) and time range,
// newest first, with pagination. Zero-value from/to mean unbounded.
func (s *Store) QueryAudit(actor string, from, to time.Time, offset, limit int) ([]AuditEntry, int, error) {
	// Build WHERE clause for COUNT and SELECT
	where := ` WHERE 1=1`
	var whereArgs []any
	if actor != "" {
		where += ` AND actor = ?`
		whereArgs = append(whereArgs, actor)
	}
	if !from.IsZero() {
		where += ` AND ts >= ?`
		whereArgs = append(whereArgs, from.UTC().Format(tsLayout))
	}
	if !to.IsZero() {
		where += ` AND ts <= ?`
		whereArgs = append(whereArgs, to.UTC().Format(tsLayout))
	}

	// COUNT
	var total int
	countQ := `SELECT COUNT(*) FROM audit_log` + where
	if err := s.db.QueryRow(countQ, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// SELECT with pagination
	q := `SELECT id, actor, action, target, payload, ts FROM audit_log` + where + ` ORDER BY id DESC`
	selectArgs := make([]any, len(whereArgs))
	copy(selectArgs, whereArgs)
	if limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		selectArgs = append(selectArgs, limit, offset)
	}
	rows, err := s.db.Query(q, selectArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var ts string
		if err := rows.Scan(&e.ID, &e.Actor, &e.Action, &e.Target, &e.Payload, &ts); err != nil {
			return nil, 0, err
		}
		e.TS, _ = time.Parse(tsLayout, ts)
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// --- admins ---

// CreateAdminIfAbsent inserts an admin, ignoring if the username already exists
// (idempotent bootstrap).
func (s *Store) CreateAdminIfAbsent(a Admin) error {
	_, err := s.db.Exec(
		`INSERT INTO admins (username, password_hash) VALUES (?, ?) ON CONFLICT(username) DO NOTHING`,
		a.Username, a.PasswordHash)
	return err
}

// GetAdmin returns an admin or ErrNotFound.
func (s *Store) GetAdmin(username string) (Admin, error) {
	row := s.db.QueryRow(`SELECT username, password_hash FROM admins WHERE username = ?`, username)
	var a Admin
	switch err := row.Scan(&a.Username, &a.PasswordHash); err {
	case sql.ErrNoRows:
		return Admin{}, ErrNotFound
	case nil:
		return a, nil
	default:
		return Admin{}, err
	}
}

// --- helpers ---

type scanner interface {
	Scan(dest ...any) error
}

func scanUser(sc scanner) (User, error) {
	var u User
	var created, updated string
	switch err := sc.Scan(&u.UserID, &u.Channel, &u.BotID, &u.SecretEnc, &u.LLMOverride, &u.ImageTag, &u.State, &created, &updated); err {
	case sql.ErrNoRows:
		return User{}, ErrNotFound
	case nil:
		u.CreatedAt, _ = time.Parse(tsLayout, created)
		u.UpdatedAt, _ = time.Parse(tsLayout, updated)
		return u, nil
	default:
		return User{}, err
	}
}

func defaultState(s string) string {
	if s == "" {
		return "creating"
	}
	return s
}

func defaultChannel(c string) string {
	if c == "" {
		return "wecom"
	}
	return c
}

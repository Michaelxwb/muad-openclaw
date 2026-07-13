// Package repo is the SQLite persistence layer for the console. Runtime
// monitoring data is not persisted here; it lives in the monitor cache.
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

// ErrNotFound is returned when a row is absent.
var ErrNotFound = errors.New("repo: not found")

// ErrLegacySchema requires the development database to be reset before the
// multi-user schema can be used.
var ErrLegacySchema = errors.New("repo: legacy users schema detected; reset the database")

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
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
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate", path)
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

// --- resource_global ---

// SetResourceGlobal upserts the single global resource-limit row.
func (s *Store) SetResourceGlobal(c ResourceConfig) error {
	now := time.Now().UTC().Format(tsLayout)
	_, err := s.db.Exec(
		`INSERT INTO resource_global (id, mem_limit, cpu_limit, restart_policy, updated_at)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   mem_limit=excluded.mem_limit, cpu_limit=excluded.cpu_limit,
		   restart_policy=excluded.restart_policy, updated_at=excluded.updated_at`,
		c.MemLimit, c.CPULimit, c.RestartPolicy, now,
	)
	return err
}

// GetResourceGlobal returns the global resource config or ErrNotFound when unset.
func (s *Store) GetResourceGlobal() (ResourceConfig, error) {
	row := s.db.QueryRow(`SELECT mem_limit, cpu_limit, restart_policy, updated_at FROM resource_global WHERE id = 1`)
	var c ResourceConfig
	var ts string
	switch err := row.Scan(&c.MemLimit, &c.CPULimit, &c.RestartPolicy, &ts); err {
	case sql.ErrNoRows:
		return ResourceConfig{}, ErrNotFound
	case nil:
		c.UpdatedAt, _ = time.Parse(tsLayout, ts)
		return c, nil
	default:
		return ResourceConfig{}, err
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
	return s.QueryAuditFiltered(AuditFilter{Actor: actor, From: from, To: to, Offset: offset, Limit: limit})
}

func (s *Store) QueryAuditFiltered(filter AuditFilter) ([]AuditEntry, int, error) {
	where, whereArgs := auditWhere(filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM audit_log`+where, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := `SELECT id, actor, action, target, payload, ts FROM audit_log` + where + ` ORDER BY id DESC`
	selectArgs := append([]any(nil), whereArgs...)
	if filter.Limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		selectArgs = append(selectArgs, filter.Limit, filter.Offset)
	}
	return s.scanAuditEntries(q, selectArgs, total)
}

func (s *Store) scanAuditEntries(q string, args []any, total int) ([]AuditEntry, int, error) {
	rows, err := s.db.Query(q, args...)
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

func auditWhere(filter AuditFilter) (string, []any) {
	where := ` WHERE 1=1`
	args := make([]any, 0, 12)
	for _, item := range []struct{ clause, value string }{
		{` AND actor = ?`, filter.Actor}, {` AND action = ?`, filter.Action}, {` AND target = ?`, filter.Target},
	} {
		if item.value != "" {
			where += item.clause
			args = append(args, item.value)
		}
	}
	for _, item := range []struct{ path, value string }{
		{"$.podId", filter.PodID}, {"$.humanUserId", filter.HumanUserID},
		{"$.identityId", filter.IdentityID}, {"$.bindingCodeId", filter.BindingCodeID},
	} {
		if item.value != "" {
			where += ` AND json_valid(payload) AND json_extract(payload, ?) = ?`
			args = append(args, item.path, item.value)
		}
	}
	if !filter.From.IsZero() {
		where += ` AND ts >= ?`
		args = append(args, filter.From.UTC().Format(tsLayout))
	}
	if !filter.To.IsZero() {
		where += ` AND ts <= ?`
		args = append(args, filter.To.UTC().Format(tsLayout))
	}
	return where, args
}

func (s *Store) CountAuditActionsSince(actions []string, since time.Time) ([]AuditActionCount, error) {
	if len(actions) == 0 {
		return []AuditActionCount{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(actions)), ",")
	args := make([]any, 0, len(actions)+1)
	for _, action := range actions {
		args = append(args, action)
	}
	args = append(args, since.UTC().Format(tsLayout))
	query := `SELECT action, json_extract(payload, '$.podId'), COUNT(*) FROM audit_log
		WHERE action IN (` + placeholders + `) AND ts >= ? AND json_valid(payload)
		AND COALESCE(json_extract(payload, '$.podId'), '') <> '' GROUP BY action, json_extract(payload, '$.podId')`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("count audit actions: %w", err)
	}
	defer rows.Close()
	var counts []AuditActionCount
	for rows.Next() {
		var count AuditActionCount
		if err := rows.Scan(&count.Action, &count.PodID, &count.Count); err != nil {
			return nil, err
		}
		counts = append(counts, count)
	}
	return counts, rows.Err()
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

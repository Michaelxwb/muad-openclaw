package repo

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	defaultBrowserPortStart = 18802
	defaultBrowserPortEnd   = 65535
)

var (
	ErrHumanUserExists        = errors.New("repo: Human User already exists")
	ErrPodCapacity            = errors.New("repo: Pod Human User capacity exceeded")
	ErrInvalidCapacity        = errors.New("repo: invalid Pod Human User capacity")
	ErrInvalidHumanUser       = errors.New("repo: invalid Human User")
	ErrInvalidStateTransition = errors.New("repo: invalid Human User state transition")
	ErrBrowserPortsExhausted  = errors.New("repo: Browser CDP port range exhausted")

	runtimeIDPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
)

// HumanUserListFilter controls Pod-scoped user pagination.
type HumanUserListFilter struct {
	Offset int
	Limit  int
	Status string
	Query  string
}

// HumanUserUpdate contains fields mutable through the normal PATCH path.
type HumanUserUpdate struct {
	DisplayName string
	Status      string
	Notes       string
}

// CreateHumanUser atomically checks capacity, allocates a stable port, inserts
// the user, and increments the Pod config generation.
func (s *Store) CreateHumanUser(user HumanUser, portStart, portEnd int) (HumanUser, error) {
	user, portStart, portEnd, err := prepareHumanUserCreate(user, portStart, portEnd)
	if err != nil {
		return HumanUser{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return HumanUser{}, fmt.Errorf("begin create Human User: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err = insertPreparedHumanUser(tx, user, portStart, portEnd)
	if err != nil {
		return HumanUser{}, err
	}
	if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
		return HumanUser{}, err
	}
	if err := tx.Commit(); err != nil {
		return HumanUser{}, fmt.Errorf("commit create Human User: %w", err)
	}
	return user, nil
}

// GetHumanUser returns one user or ErrNotFound.
func (s *Store) GetHumanUser(humanUserID string) (HumanUser, error) {
	row := s.db.QueryRow(`SELECT `+humanUserColumns+` FROM human_users WHERE human_user_id = ?`, humanUserID)
	return scanHumanUser(row)
}

// GetHumanUserByAgent resolves an agent only within one Pod.
func (s *Store) GetHumanUserByAgent(podID, agentID string) (HumanUser, error) {
	row := s.db.QueryRow(`SELECT `+humanUserColumns+`
		FROM human_users WHERE pod_id = ? AND agent_id = ?`, podID, agentID)
	return scanHumanUser(row)
}

// ListHumanUsersByPod returns a filtered page of users.
func (s *Store) ListHumanUsersByPod(podID string, filter HumanUserListFilter) ([]HumanUser, int, error) {
	where, args := humanUserFilterSQL(podID, filter)
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM human_users`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count Human Users: %w", err)
	}
	query := `SELECT ` + humanUserColumns + ` FROM human_users` + where + ` ORDER BY agent_id`
	listArgs := append([]any(nil), args...)
	if filter.Limit > 0 {
		query += ` LIMIT ? OFFSET ?`
		listArgs = append(listArgs, filter.Limit, filter.Offset)
	}
	rows, err := s.db.Query(query, listArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list Human Users: %w", err)
	}
	defer rows.Close()
	users, err := collectHumanUsers(rows)
	return users, total, err
}

// UpdateHumanUser applies mutable fields and rechecks capacity when enabling.
func (s *Store) UpdateHumanUser(humanUserID string, update HumanUserUpdate) error {
	if strings.TrimSpace(update.DisplayName) == "" || !validHumanUserStatus(update.Status) {
		return ErrInvalidHumanUser
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update Human User: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	current, err := getHumanUserTx(tx, humanUserID)
	if err != nil {
		return err
	}
	if err := validateStateTransition(current.Status, update.Status); err != nil {
		return err
	}
	if !statusConsumesCapacity(current.Status) && statusConsumesCapacity(update.Status) {
		if err := ensureAvailablePodCapacity(tx, current.PodID, 1); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`UPDATE human_users SET display_name = ?, status = ?,
		notes = ?, updated_at = ? WHERE human_user_id = ?`, strings.TrimSpace(update.DisplayName),
		update.Status, update.Notes, formatTime(time.Now().UTC()), humanUserID)
	if err := affectedOrNotFound(res, err, "update Human User"); err != nil {
		return err
	}
	if current.Status != update.Status {
		if err := markPodConfigPendingTx(tx, current.PodID); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update Human User: %w", err)
	}
	return nil
}

// MarkHumanUserDeleting excludes a user from capacity and runtime rendering.
func (s *Store) MarkHumanUserDeleting(humanUserID string) error {
	user, err := s.GetHumanUser(humanUserID)
	if err != nil {
		return err
	}
	return s.UpdateHumanUser(humanUserID, HumanUserUpdate{
		DisplayName: user.DisplayName, Status: HumanUserStatusDeleting, Notes: user.Notes,
	})
}

// DeleteHumanUser physically deletes only a user already in deleting state.
func (s *Store) DeleteHumanUser(humanUserID string) error {
	res, err := s.db.Exec(`DELETE FROM human_users
		WHERE human_user_id = ? AND status = 'deleting'`, humanUserID)
	if err != nil {
		return fmt.Errorf("delete Human User: %w", err)
	}
	count, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete Human User rows affected: %w", err)
	}
	if count > 0 {
		return nil
	}
	if _, err := s.GetHumanUser(humanUserID); errors.Is(err, ErrNotFound) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	return ErrInvalidStateTransition
}

// ListDeletingHumanUsers returns cleanup work, optionally scoped to a Pod.
func (s *Store) ListDeletingHumanUsers(podID string) ([]HumanUser, error) {
	query := `SELECT ` + humanUserColumns + ` FROM human_users WHERE status = 'deleting'`
	var args []any
	if podID != "" {
		query += ` AND pod_id = ?`
		args = append(args, podID)
	}
	query += ` ORDER BY pod_id, agent_id`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list deleting Human Users: %w", err)
	}
	defer rows.Close()
	return collectHumanUsers(rows)
}

const humanUserColumns = `human_user_id, pod_id, display_name, agent_id,
	browser_profile, browser_cdp_port, status, model_override_enc,
	platform_credentials_enc, notes, created_at, updated_at`

func prepareNewHumanUser(user *HumanUser) error {
	if user.HumanUserID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return fmt.Errorf("generate Human User ID: %w", err)
		}
		user.HumanUserID = id
	}
	user.DisplayName = strings.TrimSpace(user.DisplayName)
	if user.Status == "" {
		user.Status = HumanUserStatusPending
	}
	if user.DisplayName == "" || user.PodID == "" || !validRuntimeID(user.AgentID) ||
		!validRuntimeID(user.BrowserProfile) || !validHumanUserStatus(user.Status) {
		return ErrInvalidHumanUser
	}
	now := time.Now().UTC()
	user.CreatedAt = now
	user.UpdatedAt = now
	return nil
}

func validRuntimeID(value string) bool {
	return value != "main" && value != "quarantine" && runtimeIDPattern.MatchString(value)
}

func validHumanUserStatus(status string) bool {
	switch status {
	case HumanUserStatusPending, HumanUserStatusActive, HumanUserStatusDisabled, HumanUserStatusDeleting:
		return true
	default:
		return false
	}
}

func validateStateTransition(current, next string) error {
	if current == HumanUserStatusDeleting && next != HumanUserStatusDeleting {
		return ErrInvalidStateTransition
	}
	return nil
}

func statusConsumesCapacity(status string) bool {
	return status == HumanUserStatusPending || status == HumanUserStatusActive
}

func normalizePortRange(start, end int) (int, int, error) {
	if start == 0 {
		start = defaultBrowserPortStart
	}
	if end == 0 {
		end = defaultBrowserPortEnd
	}
	if start < 1024 || end < start || end > 65535 {
		return 0, 0, ErrInvalidHumanUser
	}
	return start, end, nil
}

func allocateBrowserPort(tx *sql.Tx, podID string, start, end int) (int, error) {
	rows, err := tx.Query(`SELECT browser_cdp_port FROM human_users
		WHERE pod_id = ? AND browser_cdp_port BETWEEN ? AND ? ORDER BY browser_cdp_port`,
		podID, start, end)
	if err != nil {
		return 0, fmt.Errorf("list allocated Browser ports: %w", err)
	}
	defer rows.Close()
	candidate := start
	for rows.Next() {
		var used int
		if err := rows.Scan(&used); err != nil {
			return 0, fmt.Errorf("scan allocated Browser port: %w", err)
		}
		if used == candidate {
			candidate++
		}
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate allocated Browser ports: %w", err)
	}
	if candidate > end {
		return 0, ErrBrowserPortsExhausted
	}
	return candidate, nil
}

func insertHumanUser(tx *sql.Tx, user HumanUser) error {
	_, err := tx.Exec(`INSERT INTO human_users (
		human_user_id, pod_id, display_name, agent_id, browser_profile,
		browser_cdp_port, status, model_override_enc, platform_credentials_enc,
		notes, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, user.HumanUserID, user.PodID,
		user.DisplayName, user.AgentID, user.BrowserProfile, user.BrowserCDPPort,
		user.Status, user.ModelOverrideEnc, user.PlatformCredentialsEnc, user.Notes,
		formatTime(user.CreatedAt), formatTime(user.UpdatedAt))
	if isUniqueConstraint(err) {
		return ErrHumanUserExists
	}
	if err != nil {
		return fmt.Errorf("insert Human User: %w", err)
	}
	return nil
}

func ensureAvailablePodCapacity(tx *sql.Tx, podID string, additional int) error {
	var maxUsers int
	if err := tx.QueryRow(`SELECT max_users FROM pods WHERE pod_id = ?`, podID).Scan(&maxUsers); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("read Pod capacity: %w", err)
	}
	return ensurePodCapacity(tx, podID, maxUsers, additional)
}

func ensurePodCapacity(tx *sql.Tx, podID string, maxUsers, additional int) error {
	if maxUsers <= 0 {
		return ErrInvalidCapacity
	}
	if err := ensurePodExists(tx, podID); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM human_users
		WHERE pod_id = ? AND status IN ('active','pending')`, podID).Scan(&count); err != nil {
		return fmt.Errorf("count Pod Human Users: %w", err)
	}
	if count+additional > maxUsers {
		return ErrPodCapacity
	}
	return nil
}

func ensurePodExists(tx *sql.Tx, podID string) error {
	var exists int
	if err := tx.QueryRow(`SELECT 1 FROM pods WHERE pod_id = ?`, podID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("inspect Pod: %w", err)
	}
	return nil
}

func markPodConfigPendingTx(tx *sql.Tx, podID string) error {
	res, err := tx.Exec(`UPDATE pods SET config_generation = config_generation + 1,
		last_apply_status = 'pending', last_apply_error = '', updated_at = ? WHERE pod_id = ?`,
		formatTime(time.Now().UTC()), podID)
	return affectedOrNotFound(res, err, "mark Pod config pending")
}

func getHumanUserTx(tx *sql.Tx, humanUserID string) (HumanUser, error) {
	row := tx.QueryRow(`SELECT `+humanUserColumns+` FROM human_users WHERE human_user_id = ?`, humanUserID)
	return scanHumanUser(row)
}

func humanUserFilterSQL(podID string, filter HumanUserListFilter) (string, []any) {
	clauses := []string{"pod_id = ?"}
	args := []any{podID}
	if filter.Status != "" {
		clauses = append(clauses, "status = ?")
		args = append(args, filter.Status)
	}
	if query := strings.TrimSpace(filter.Query); query != "" {
		clauses = append(clauses, "(agent_id LIKE ? OR display_name LIKE ?)")
		pattern := "%" + query + "%"
		args = append(args, pattern, pattern)
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func collectHumanUsers(rows *sql.Rows) ([]HumanUser, error) {
	var users []HumanUser
	for rows.Next() {
		user, err := scanHumanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func scanHumanUser(sc scanner) (HumanUser, error) {
	var user HumanUser
	var createdAt, updatedAt string
	err := sc.Scan(&user.HumanUserID, &user.PodID, &user.DisplayName, &user.AgentID,
		&user.BrowserProfile, &user.BrowserCDPPort, &user.Status, &user.ModelOverrideEnc,
		&user.PlatformCredentialsEnc, &user.Notes, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return HumanUser{}, ErrNotFound
	}
	if err != nil {
		return HumanUser{}, fmt.Errorf("scan Human User: %w", err)
	}
	user.CreatedAt, err = parseRequiredTime(createdAt, "human_users.created_at")
	if err != nil {
		return HumanUser{}, err
	}
	user.UpdatedAt, err = parseRequiredTime(updatedAt, "human_users.updated_at")
	if err != nil {
		return HumanUser{}, err
	}
	return user, nil
}

func generateUUIDv4() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], raw[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], raw[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], raw[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], raw[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], raw[10:16])
	return string(encoded), nil
}

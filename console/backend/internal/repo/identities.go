package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrIdentityExists = errors.New("repo: scoped IM identity already exists")

const identityColumns = `identity_id, human_user_id, pod_id, channel,
	openclaw_channel, account_id, external_id, external_id_type, peer_kind,
	status, created_at, updated_at`

// CreateIdentity inserts an IM identity and activates a pending Human User.
func (s *Store) CreateIdentity(identity UserIdentity) (UserIdentity, error) {
	if err := prepareIdentity(&identity); err != nil {
		return UserIdentity{}, err
	}
	if err := validateIdentity(identity); err != nil {
		return UserIdentity{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return UserIdentity{}, fmt.Errorf("begin create Identity: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err := getHumanUserTx(tx, identity.HumanUserID)
	if err != nil {
		return UserIdentity{}, err
	}
	if user.PodID != identity.PodID || user.Status == HumanUserStatusDisabled || user.Status == HumanUserStatusDeleting {
		return UserIdentity{}, ErrInvalidStateTransition
	}
	if err := insertIdentity(tx, identity); err != nil {
		return UserIdentity{}, err
	}
	if identity.Status == IdentityStatusActive && user.Status == HumanUserStatusPending {
		if err := setHumanUserStatusTx(tx, user.HumanUserID, HumanUserStatusActive); err != nil {
			return UserIdentity{}, err
		}
	}
	if err := markPodConfigPendingTx(tx, identity.PodID); err != nil {
		return UserIdentity{}, err
	}
	if err := tx.Commit(); err != nil {
		return UserIdentity{}, fmt.Errorf("commit create Identity: %w", err)
	}
	return identity, nil
}

// GetIdentity returns one identity or ErrNotFound.
func (s *Store) GetIdentity(identityID string) (UserIdentity, error) {
	row := s.db.QueryRow(`SELECT `+identityColumns+`
		FROM user_identities WHERE identity_id = ?`, identityID)
	return scanIdentity(row)
}

// FindIdentityByExternalID performs an exact, scoped external-ID lookup.
func (s *Store) FindIdentityByExternalID(
	podID, openClawChannel, accountID, peerKind, externalID string,
) (UserIdentity, error) {
	row := s.db.QueryRow(`SELECT `+identityColumns+` FROM user_identities
		WHERE pod_id = ? AND openclaw_channel = ? AND account_id = ?
		AND peer_kind = ? AND external_id = ?`, podID, openClawChannel,
		accountID, peerKind, externalID)
	return scanIdentity(row)
}

// ListIdentitiesByHumanUser returns all identities in stable order.
func (s *Store) ListIdentitiesByHumanUser(humanUserID string) ([]UserIdentity, error) {
	rows, err := s.db.Query(`SELECT `+identityColumns+` FROM user_identities
		WHERE human_user_id = ? ORDER BY openclaw_channel, account_id, external_id`, humanUserID)
	if err != nil {
		return nil, fmt.Errorf("list Identities: %w", err)
	}
	defer rows.Close()
	return collectIdentities(rows)
}

// ListIdentitiesByPod returns all Pod identities without per-user queries.
func (s *Store) ListIdentitiesByPod(podID string) ([]UserIdentity, error) {
	rows, err := s.db.Query(`SELECT `+identityColumns+` FROM user_identities
		WHERE pod_id = ? ORDER BY openclaw_channel, account_id, peer_kind, external_id`, podID)
	if err != nil {
		return nil, fmt.Errorf("list Pod Identities: %w", err)
	}
	defer rows.Close()
	return collectIdentities(rows)
}

// CountIdentitiesByHumanUser returns Identity counts keyed by Human User ID.
func (s *Store) CountIdentitiesByHumanUser(podID string) (map[string]int, error) {
	query := `SELECT human_user_id, COUNT(*) FROM user_identities`
	var args []any
	if podID != "" {
		query += ` WHERE pod_id = ?`
		args = append(args, podID)
	}
	query += ` GROUP BY human_user_id`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("count Identities by Human User: %w", err)
	}
	defer rows.Close()
	counts := make(map[string]int)
	for rows.Next() {
		var humanUserID string
		var count int
		if err := rows.Scan(&humanUserID, &count); err != nil {
			return nil, fmt.Errorf("scan Identity count: %w", err)
		}
		counts[humanUserID] = count
	}
	return counts, rows.Err()
}

// UpdateIdentityStatus enables or disables one identity and reconciles user status.
func (s *Store) UpdateIdentityStatus(identityID, status string) error {
	if status != IdentityStatusActive && status != IdentityStatusDisabled {
		return ErrInvalidHumanUser
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin update Identity: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	identity, user, err := identityAndUserTx(tx, identityID)
	if err != nil {
		return err
	}
	if status == IdentityStatusActive &&
		(user.Status == HumanUserStatusDisabled || user.Status == HumanUserStatusDeleting) {
		return ErrInvalidStateTransition
	}
	res, err := tx.Exec(`UPDATE user_identities SET status = ?, updated_at = ?
		WHERE identity_id = ?`, status, formatTime(time.Now().UTC()), identityID)
	if err := affectedOrNotFound(res, err, "update Identity"); err != nil {
		return err
	}
	if err := reconcileHumanUserIdentityStatus(tx, user, status); err != nil {
		return err
	}
	if err := markPodConfigPendingTx(tx, identity.PodID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update Identity: %w", err)
	}
	return nil
}

// DeleteIdentity removes an identity and returns an active user to pending when needed.
func (s *Store) DeleteIdentity(identityID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin delete Identity: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	identity, user, err := identityAndUserTx(tx, identityID)
	if err != nil {
		return err
	}
	res, err := tx.Exec(`DELETE FROM user_identities WHERE identity_id = ?`, identityID)
	if err := affectedOrNotFound(res, err, "delete Identity"); err != nil {
		return err
	}
	if err := reconcileHumanUserIdentityStatus(tx, user, IdentityStatusDisabled); err != nil {
		return err
	}
	if err := markPodConfigPendingTx(tx, identity.PodID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete Identity: %w", err)
	}
	return nil
}

func prepareIdentity(identity *UserIdentity) error {
	if identity.IdentityID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return fmt.Errorf("generate Identity ID: %w", err)
		}
		identity.IdentityID = id
	}
	if identity.AccountID == "" {
		identity.AccountID = "default"
	}
	if identity.PeerKind == "" {
		identity.PeerKind = "direct"
	}
	if identity.Status == "" {
		identity.Status = IdentityStatusActive
	}
	now := time.Now().UTC()
	identity.CreatedAt = now
	identity.UpdatedAt = now
	return nil
}

func validateIdentity(identity UserIdentity) error {
	values := []string{
		identity.IdentityID, identity.HumanUserID, identity.PodID, identity.Channel,
		identity.OpenClawChannel, identity.AccountID, identity.ExternalID,
		identity.ExternalIDType, identity.PeerKind,
	}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return ErrInvalidHumanUser
		}
	}
	if identity.Status != IdentityStatusActive && identity.Status != IdentityStatusDisabled {
		return ErrInvalidHumanUser
	}
	return nil
}

func insertIdentity(tx *sql.Tx, identity UserIdentity) error {
	_, err := tx.Exec(`INSERT INTO user_identities (
		identity_id, human_user_id, pod_id, channel, openclaw_channel, account_id,
		external_id, external_id_type, peer_kind, status, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, identity.IdentityID,
		identity.HumanUserID, identity.PodID, identity.Channel, identity.OpenClawChannel,
		identity.AccountID, identity.ExternalID, identity.ExternalIDType,
		identity.PeerKind, identity.Status, formatTime(identity.CreatedAt),
		formatTime(identity.UpdatedAt))
	if isUniqueConstraint(err) {
		return ErrIdentityExists
	}
	if err != nil {
		return fmt.Errorf("insert Identity: %w", err)
	}
	return nil
}

func identityAndUserTx(tx *sql.Tx, identityID string) (UserIdentity, HumanUser, error) {
	row := tx.QueryRow(`SELECT `+identityColumns+`
		FROM user_identities WHERE identity_id = ?`, identityID)
	identity, err := scanIdentity(row)
	if err != nil {
		return UserIdentity{}, HumanUser{}, err
	}
	user, err := getHumanUserTx(tx, identity.HumanUserID)
	if err != nil {
		return UserIdentity{}, HumanUser{}, err
	}
	return identity, user, nil
}

func reconcileHumanUserIdentityStatus(tx *sql.Tx, user HumanUser, changedStatus string) error {
	if changedStatus == IdentityStatusActive && user.Status == HumanUserStatusPending {
		return setHumanUserStatusTx(tx, user.HumanUserID, HumanUserStatusActive)
	}
	if user.Status != HumanUserStatusActive {
		return nil
	}
	var activeCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM user_identities
		WHERE human_user_id = ? AND status = 'active'`, user.HumanUserID).Scan(&activeCount); err != nil {
		return fmt.Errorf("count active Identities: %w", err)
	}
	if activeCount == 0 {
		return setHumanUserStatusTx(tx, user.HumanUserID, HumanUserStatusPending)
	}
	return nil
}

func setHumanUserStatusTx(tx *sql.Tx, humanUserID, status string) error {
	res, err := tx.Exec(`UPDATE human_users SET status = ?, updated_at = ?
		WHERE human_user_id = ?`, status, formatTime(time.Now().UTC()), humanUserID)
	return affectedOrNotFound(res, err, "update Human User status")
}

func collectIdentities(rows *sql.Rows) ([]UserIdentity, error) {
	var identities []UserIdentity
	for rows.Next() {
		identity, err := scanIdentity(rows)
		if err != nil {
			return nil, err
		}
		identities = append(identities, identity)
	}
	return identities, rows.Err()
}

func scanIdentity(sc scanner) (UserIdentity, error) {
	var identity UserIdentity
	var createdAt, updatedAt string
	err := sc.Scan(&identity.IdentityID, &identity.HumanUserID, &identity.PodID,
		&identity.Channel, &identity.OpenClawChannel, &identity.AccountID,
		&identity.ExternalID, &identity.ExternalIDType, &identity.PeerKind,
		&identity.Status, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return UserIdentity{}, ErrNotFound
	}
	if err != nil {
		return UserIdentity{}, fmt.Errorf("scan Identity: %w", err)
	}
	identity.CreatedAt, err = parseRequiredTime(createdAt, "user_identities.created_at")
	if err != nil {
		return UserIdentity{}, err
	}
	identity.UpdatedAt, err = parseRequiredTime(updatedAt, "user_identities.updated_at")
	if err != nil {
		return UserIdentity{}, err
	}
	return identity, nil
}

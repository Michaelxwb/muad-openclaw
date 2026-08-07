package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

const maxPlatformCredentialBytes = 16 * 1024

var (
	ErrPlatformExists          = &Error{Code: errcode.ConflictPlatformExists, Msg: "repo: platform already exists"}
	ErrPlatformDisabled        = &Error{Code: errcode.ConflictPlatformDisabled, Msg: "repo: platform is disabled"}
	ErrCredentialNotConfigured = &Error{Code: errcode.NotFoundPlatformCredential, Msg: "repo: platform credential not configured"}
	ErrInvalidPlatform         = &Error{Code: errcode.InvalidPlatform, Msg: "repo: invalid platform"}

	platformPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

const platformColumns = `platform, display_name, enabled, updated_at`

// PlatformCredentialSummary is safe for administrator-facing responses.
type PlatformCredentialSummary struct {
	Platform              string
	CredentialFingerprint string
	UpdatedAt             time.Time
}

// ResolvedPlatformCredential contains plaintext only for the internal resolver.
type ResolvedPlatformCredential struct {
	Platform              string
	CredentialsJSON       string
	CredentialFingerprint string
	UpdatedAt             time.Time
}

// CreatePlatformConfig adds a platform supported by administrator configuration.
func (s *Store) CreatePlatformConfig(config PlatformConfig) error {
	if err := validatePlatformConfig(config); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO platform_configs
		(platform, display_name, enabled, updated_at) VALUES (?, ?, ?, ?)`,
		config.Platform, strings.TrimSpace(config.DisplayName),
		boolToInt(config.Enabled), formatTime(time.Now().UTC()))
	if isUniqueConstraint(err) {
		return ErrPlatformExists
	}
	if err != nil {
		return fmt.Errorf("create platform config: %w", err)
	}
	return nil
}

// GetPlatformConfig returns one platform or ErrNotFound.
func (s *Store) GetPlatformConfig(platform string) (PlatformConfig, error) {
	row := s.db.QueryRow(`SELECT `+platformColumns+`
		FROM platform_configs WHERE platform = ?`, platform)
	return scanPlatformConfig(row)
}

// ListPlatformConfigs returns all platforms in stable order.
func (s *Store) ListPlatformConfigs() ([]PlatformConfig, error) {
	rows, err := s.db.Query(`SELECT ` + platformColumns + `
		FROM platform_configs ORDER BY platform`)
	if err != nil {
		return nil, fmt.Errorf("list platform configs: %w", err)
	}
	defer rows.Close()
	var configs []PlatformConfig
	for rows.Next() {
		config, err := scanPlatformConfig(rows)
		if err != nil {
			return nil, err
		}
		configs = append(configs, config)
	}
	return configs, rows.Err()
}

// UpdatePlatformConfig updates mutable platform fields; the platform ID is immutable.
func (s *Store) UpdatePlatformConfig(platform, displayName string, enabled bool) error {
	if !validPlatform(platform) || strings.TrimSpace(displayName) == "" {
		return ErrInvalidPlatform
	}
	res, err := s.db.Exec(`UPDATE platform_configs SET display_name = ?,
		enabled = ?, updated_at = ? WHERE platform = ?`,
		strings.TrimSpace(displayName), boolToInt(enabled),
		formatTime(time.Now().UTC()), platform)
	return affectedOrNotFound(res, err, "update platform config")
}

// UpsertUserPlatformCredential atomically replaces one platform credential object.
func (s *Store) UpsertUserPlatformCredential(
	humanUserID, platform string, credentials map[string]any,
) (PlatformCredentialSummary, error) {
	summary, _, err := s.upsertUserPlatformCredential(humanUserID, platform, credentials, false)
	return summary, err
}

// UpsertUserPlatformCredentialAndMarkPod replaces one platform credential object
// and marks the owning Pod pending because Skill availability may depend on credentials.
func (s *Store) UpsertUserPlatformCredentialAndMarkPod(
	humanUserID, platform string, credentials map[string]any,
) (PlatformCredentialSummary, string, error) {
	return s.upsertUserPlatformCredential(humanUserID, platform, credentials, true)
}

func (s *Store) upsertUserPlatformCredential(
	humanUserID, platform string, credentials map[string]any, markPod bool,
) (PlatformCredentialSummary, string, error) {
	if !validPlatform(platform) {
		return PlatformCredentialSummary{}, "", ErrInvalidPlatform
	}
	canonical, fingerprint, err := canonicalPlatformCredentials(credentials)
	if err != nil {
		return PlatformCredentialSummary{}, "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return PlatformCredentialSummary{}, "", fmt.Errorf("begin upsert platform credential: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err := getHumanUserTx(tx, humanUserID)
	if err != nil {
		return PlatformCredentialSummary{}, "", err
	}
	if err := requirePlatformTx(tx, platform, true); err != nil {
		return PlatformCredentialSummary{}, "", err
	}
	now := time.Now().UTC()
	_, err = tx.Exec(`INSERT INTO user_platform_credentials
		(human_user_id, platform, credentials_json, credential_fingerprint, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(human_user_id, platform) DO UPDATE SET
			credentials_json = excluded.credentials_json,
			credential_fingerprint = excluded.credential_fingerprint,
			updated_at = excluded.updated_at`,
		humanUserID, platform, canonical, fingerprint, formatTime(now))
	if err != nil {
		return PlatformCredentialSummary{}, "", fmt.Errorf("upsert platform credential: %w", err)
	}
	if markPod {
		if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
			return PlatformCredentialSummary{}, "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return PlatformCredentialSummary{}, "", fmt.Errorf("commit platform credential: %w", err)
	}
	return PlatformCredentialSummary{
		Platform: platform, CredentialFingerprint: fingerprint, UpdatedAt: now,
	}, user.PodID, nil
}

// ListUserPlatformCredentials returns redacted credential summaries.
func (s *Store) ListUserPlatformCredentials(humanUserID string) ([]PlatformCredentialSummary, error) {
	if _, err := s.GetHumanUser(humanUserID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT platform, credential_fingerprint, updated_at
		FROM user_platform_credentials WHERE human_user_id = ? ORDER BY platform`, humanUserID)
	if err != nil {
		return nil, fmt.Errorf("list platform credentials: %w", err)
	}
	defer rows.Close()
	summaries := make([]PlatformCredentialSummary, 0)
	for rows.Next() {
		var summary PlatformCredentialSummary
		var updatedAt string
		if err := rows.Scan(&summary.Platform, &summary.CredentialFingerprint, &updatedAt); err != nil {
			return nil, fmt.Errorf("scan platform credential: %w", err)
		}
		parsed, err := parseRequiredTime(updatedAt, "user_platform_credentials.updated_at")
		if err != nil {
			return nil, err
		}
		summary.UpdatedAt = parsed
		summaries = append(summaries, summary)
	}
	return summaries, rows.Err()
}

// ResolveUserPlatformCredential returns plaintext credentials for the internal resolver only.
func (s *Store) ResolveUserPlatformCredential(
	humanUserID, platform string,
) (ResolvedPlatformCredential, error) {
	if !validPlatform(platform) {
		return ResolvedPlatformCredential{}, ErrInvalidPlatform
	}
	if config, err := s.GetPlatformConfig(platform); err != nil {
		return ResolvedPlatformCredential{}, err
	} else if !config.Enabled {
		return ResolvedPlatformCredential{}, ErrPlatformDisabled
	}
	row := s.db.QueryRow(`SELECT credentials_json, credential_fingerprint, updated_at
		FROM user_platform_credentials WHERE human_user_id = ? AND platform = ?`, humanUserID, platform)
	var credential ResolvedPlatformCredential
	var updatedAt string
	err := row.Scan(&credential.CredentialsJSON, &credential.CredentialFingerprint, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		if _, userErr := s.GetHumanUser(humanUserID); userErr != nil {
			return ResolvedPlatformCredential{}, userErr
		}
		return ResolvedPlatformCredential{}, ErrCredentialNotConfigured
	}
	if err != nil {
		return ResolvedPlatformCredential{}, fmt.Errorf("read platform credential: %w", err)
	}
	parsed, err := parseRequiredTime(updatedAt, "user_platform_credentials.updated_at")
	if err != nil {
		return ResolvedPlatformCredential{}, err
	}
	credential.Platform = platform
	credential.UpdatedAt = parsed
	return credential, nil
}

// DeleteUserPlatformCredential atomically removes one platform credential object.
func (s *Store) DeleteUserPlatformCredential(humanUserID, platform string) error {
	_, err := s.deleteUserPlatformCredential(humanUserID, platform, false)
	return err
}

// DeleteUserPlatformCredentialAndMarkPod removes one platform credential object
// and marks the owning Pod pending because Skill availability may depend on credentials.
func (s *Store) DeleteUserPlatformCredentialAndMarkPod(
	humanUserID, platform string,
) (string, error) {
	return s.deleteUserPlatformCredential(humanUserID, platform, true)
}

func (s *Store) deleteUserPlatformCredential(
	humanUserID, platform string, markPod bool,
) (string, error) {
	if !validPlatform(platform) {
		return "", ErrInvalidPlatform
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", fmt.Errorf("begin delete platform credential: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	user, err := getHumanUserTx(tx, humanUserID)
	if err != nil {
		return "", err
	}
	if err := requirePlatformTx(tx, platform, false); err != nil {
		return "", err
	}
	result, err := tx.Exec(`DELETE FROM user_platform_credentials
		WHERE human_user_id = ? AND platform = ?`, humanUserID, platform)
	if err := affectedOrNotFound(result, err, "delete platform credential"); err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", ErrCredentialNotConfigured
		}
		return "", err
	}
	if markPod {
		if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit delete platform credential: %w", err)
	}
	return user.PodID, nil
}

func validatePlatformConfig(config PlatformConfig) error {
	if !validPlatform(config.Platform) || strings.TrimSpace(config.DisplayName) == "" {
		return ErrInvalidPlatform
	}
	return nil
}

func validPlatform(platform string) bool {
	return platformPattern.MatchString(platform)
}

func canonicalPlatformCredentials(credentials map[string]any) (string, string, error) {
	if credentials == nil {
		return "", "", ErrInvalidPlatform
	}
	canonical, err := json.Marshal(credentials)
	if err != nil {
		return "", "", fmt.Errorf("marshal platform credentials: %w", err)
	}
	if len(canonical) > maxPlatformCredentialBytes {
		return "", "", ErrInvalidPlatform
	}
	fingerprint := secretcrypto.Fingerprint(string(canonical))
	return string(canonical), fingerprint, nil
}

func requirePlatformTx(tx *sql.Tx, platform string, requireEnabled bool) error {
	var enabled int
	if err := tx.QueryRow(`SELECT enabled FROM platform_configs
		WHERE platform = ?`, platform).Scan(&enabled); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("read platform state: %w", err)
	}
	if requireEnabled && enabled == 0 {
		return ErrPlatformDisabled
	}
	return nil
}

func scanPlatformConfig(sc scanner) (PlatformConfig, error) {
	var config PlatformConfig
	var enabled int
	var updatedAt string
	err := sc.Scan(&config.Platform, &config.DisplayName, &enabled, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PlatformConfig{}, ErrNotFound
	}
	if err != nil {
		return PlatformConfig{}, fmt.Errorf("scan platform config: %w", err)
	}
	config.Enabled = enabled == 1
	config.UpdatedAt, err = parseRequiredTime(updatedAt, "platform_configs.updated_at")
	if err != nil {
		return PlatformConfig{}, err
	}
	return config, nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

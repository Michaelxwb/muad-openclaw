package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

var (
	ErrPlatformExists          = errors.New("repo: platform already exists")
	ErrPlatformDisabled        = errors.New("repo: platform is disabled")
	ErrCredentialNotConfigured = errors.New("repo: platform credential not configured")
	ErrInvalidPlatform         = errors.New("repo: invalid platform")

	platformPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

const platformColumns = `platform, display_name, config_enc, enabled, updated_at`

type storedPlatformCredential struct {
	Platform    string `json:"platform"`
	APIKey      string `json:"apiKey"`
	Fingerprint string `json:"fingerprint"`
	UpdatedAt   string `json:"updatedAt"`
}

// PlatformCredentialSummary is safe for administrator-facing responses.
type PlatformCredentialSummary struct {
	Platform       string
	KeyFingerprint string
	UpdatedAt      time.Time
}

// ResolvedPlatformCredential contains plaintext only for the internal resolver.
type ResolvedPlatformCredential struct {
	Platform    string
	APIKey      string
	Fingerprint string
	UpdatedAt   time.Time
}

func (s *Store) seedPlatformConfigs() error {
	now := formatTime(time.Now().UTC())
	_, err := s.db.Exec(`INSERT INTO platform_configs
		(platform, display_name, config_enc, enabled, updated_at) VALUES
		('soar', 'SOAR', '', 1, ?),
		('sea_soar', 'Sea_SOAR', '', 1, ?),
		('mssw', 'MSSW', '', 1, ?),
		('xdr', 'XDR', '', 1, ?),
		('sdsp', 'SDSP', '', 1, ?)
		ON CONFLICT(platform) DO NOTHING`, now, now, now, now, now)
	if err != nil {
		return fmt.Errorf("seed platform configs: %w", err)
	}
	return nil
}

// CreatePlatformConfig adds a platform supported by the installed adapter registry.
func (s *Store) CreatePlatformConfig(config PlatformConfig) error {
	if err := validatePlatformConfig(config); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO platform_configs
		(platform, display_name, config_enc, enabled, updated_at) VALUES (?, ?, ?, ?, ?)`,
		config.Platform, strings.TrimSpace(config.DisplayName), config.ConfigEnc,
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
func (s *Store) UpdatePlatformConfig(platform, displayName, configEnc string, enabled bool) error {
	if !validPlatform(platform) || strings.TrimSpace(displayName) == "" {
		return ErrInvalidPlatform
	}
	res, err := s.db.Exec(`UPDATE platform_configs SET display_name = ?,
		config_enc = ?, enabled = ?, updated_at = ? WHERE platform = ?`,
		strings.TrimSpace(displayName), configEnc, boolToInt(enabled),
		formatTime(time.Now().UTC()), platform)
	return affectedOrNotFound(res, err, "update platform config")
}

// UpsertUserPlatformCredential atomically replaces one platform key.
func (s *Store) UpsertUserPlatformCredential(
	cipher *secretcrypto.Cipher, humanUserID, platform, apiKey string,
) (PlatformCredentialSummary, error) {
	summary, _, err := s.upsertUserPlatformCredential(cipher, humanUserID, platform, apiKey, false)
	return summary, err
}

// UpsertUserPlatformCredentialAndMarkPod replaces one platform key and marks
// the owning Pod pending because Skill availability may depend on credentials.
func (s *Store) UpsertUserPlatformCredentialAndMarkPod(
	cipher *secretcrypto.Cipher, humanUserID, platform, apiKey string,
) (PlatformCredentialSummary, string, error) {
	return s.upsertUserPlatformCredential(cipher, humanUserID, platform, apiKey, true)
}

func (s *Store) upsertUserPlatformCredential(
	cipher *secretcrypto.Cipher, humanUserID, platform, apiKey string, markPod bool,
) (PlatformCredentialSummary, string, error) {
	if cipher == nil || !validPlatform(platform) || strings.TrimSpace(apiKey) == "" {
		return PlatformCredentialSummary{}, "", ErrInvalidPlatform
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
	credentials, err := loadCredentialsTx(tx, cipher, humanUserID)
	if err != nil {
		return PlatformCredentialSummary{}, "", err
	}
	now := time.Now().UTC()
	credential := storedPlatformCredential{
		Platform: platform, APIKey: apiKey, Fingerprint: secretcrypto.Fingerprint(apiKey),
		UpdatedAt: formatTime(now),
	}
	credentials = upsertCredential(credentials, credential)
	if err := saveCredentialsTx(tx, cipher, humanUserID, credentials); err != nil {
		return PlatformCredentialSummary{}, "", err
	}
	if markPod {
		if err := markPodConfigPendingTx(tx, user.PodID); err != nil {
			return PlatformCredentialSummary{}, "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return PlatformCredentialSummary{}, "", fmt.Errorf("commit platform credential: %w", err)
	}
	summary, err := credentialSummary(credential)
	return summary, user.PodID, err
}

// ListUserPlatformCredentials returns redacted credential summaries.
func (s *Store) ListUserPlatformCredentials(
	cipher *secretcrypto.Cipher, humanUserID string,
) ([]PlatformCredentialSummary, error) {
	if cipher == nil {
		return nil, ErrInvalidPlatform
	}
	row := s.db.QueryRow(`SELECT platform_credentials_enc FROM human_users
		WHERE human_user_id = ?`, humanUserID)
	var encrypted string
	if err := row.Scan(&encrypted); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, fmt.Errorf("read platform credentials: %w", err)
	}
	credentials, err := decodeCredentials(cipher, encrypted)
	if err != nil {
		return nil, err
	}
	return summarizeCredentials(credentials)
}

// ResolveUserPlatformCredential returns plaintext for the internal resolver only.
func (s *Store) ResolveUserPlatformCredential(
	cipher *secretcrypto.Cipher, humanUserID, platform string,
) (ResolvedPlatformCredential, error) {
	if cipher == nil || !validPlatform(platform) {
		return ResolvedPlatformCredential{}, ErrInvalidPlatform
	}
	if config, err := s.GetPlatformConfig(platform); err != nil {
		return ResolvedPlatformCredential{}, err
	} else if !config.Enabled {
		return ResolvedPlatformCredential{}, ErrPlatformDisabled
	}
	row := s.db.QueryRow(`SELECT platform_credentials_enc FROM human_users
		WHERE human_user_id = ?`, humanUserID)
	var encrypted string
	if err := row.Scan(&encrypted); errors.Is(err, sql.ErrNoRows) {
		return ResolvedPlatformCredential{}, ErrNotFound
	} else if err != nil {
		return ResolvedPlatformCredential{}, fmt.Errorf("read platform credential: %w", err)
	}
	credentials, err := decodeCredentials(cipher, encrypted)
	if err != nil {
		return ResolvedPlatformCredential{}, err
	}
	return findResolvedCredential(credentials, platform)
}

// DeleteUserPlatformCredential atomically removes one platform key.
func (s *Store) DeleteUserPlatformCredential(
	cipher *secretcrypto.Cipher, humanUserID, platform string,
) error {
	_, err := s.deleteUserPlatformCredential(cipher, humanUserID, platform, false)
	return err
}

// DeleteUserPlatformCredentialAndMarkPod removes one platform key and marks
// the owning Pod pending because Skill availability may depend on credentials.
func (s *Store) DeleteUserPlatformCredentialAndMarkPod(
	cipher *secretcrypto.Cipher, humanUserID, platform string,
) (string, error) {
	return s.deleteUserPlatformCredential(cipher, humanUserID, platform, true)
}

func (s *Store) deleteUserPlatformCredential(
	cipher *secretcrypto.Cipher, humanUserID, platform string, markPod bool,
) (string, error) {
	if cipher == nil || !validPlatform(platform) {
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
	credentials, err := loadCredentialsTx(tx, cipher, humanUserID)
	if err != nil {
		return "", err
	}
	credentials, found := deleteCredential(credentials, platform)
	if !found {
		return "", ErrCredentialNotConfigured
	}
	if err := saveCredentialsTx(tx, cipher, humanUserID, credentials); err != nil {
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

func loadCredentialsTx(
	tx *sql.Tx, cipher *secretcrypto.Cipher, humanUserID string,
) ([]storedPlatformCredential, error) {
	var encrypted string
	if err := tx.QueryRow(`SELECT platform_credentials_enc FROM human_users
		WHERE human_user_id = ?`, humanUserID).Scan(&encrypted); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, fmt.Errorf("read user platform credentials: %w", err)
	}
	return decodeCredentials(cipher, encrypted)
}

func saveCredentialsTx(
	tx *sql.Tx, cipher *secretcrypto.Cipher, humanUserID string,
	credentials []storedPlatformCredential,
) error {
	encrypted := ""
	if len(credentials) > 0 {
		plain, err := json.Marshal(credentials)
		if err != nil {
			return fmt.Errorf("marshal platform credentials: %w", err)
		}
		encrypted, err = cipher.Encrypt(string(plain))
		if err != nil {
			return fmt.Errorf("encrypt platform credentials: %w", err)
		}
	}
	res, err := tx.Exec(`UPDATE human_users SET platform_credentials_enc = ?,
		updated_at = ? WHERE human_user_id = ?`, encrypted,
		formatTime(time.Now().UTC()), humanUserID)
	return affectedOrNotFound(res, err, "save platform credentials")
}

func decodeCredentials(
	cipher *secretcrypto.Cipher, encrypted string,
) ([]storedPlatformCredential, error) {
	if encrypted == "" {
		return []storedPlatformCredential{}, nil
	}
	plain, err := cipher.Decrypt(encrypted)
	if err != nil {
		return nil, fmt.Errorf("decrypt platform credentials: %w", err)
	}
	var credentials []storedPlatformCredential
	if err := json.Unmarshal([]byte(plain), &credentials); err != nil {
		return nil, fmt.Errorf("decode platform credentials: %w", err)
	}
	seen := make(map[string]struct{}, len(credentials))
	for _, credential := range credentials {
		if !validPlatform(credential.Platform) || credential.APIKey == "" ||
			credential.Fingerprint == "" || credential.UpdatedAt == "" {
			return nil, errors.New("repo: invalid stored platform credential")
		}
		if _, exists := seen[credential.Platform]; exists {
			return nil, errors.New("repo: duplicate stored platform credential")
		}
		seen[credential.Platform] = struct{}{}
	}
	slices.SortFunc(credentials, func(left, right storedPlatformCredential) int {
		return strings.Compare(left.Platform, right.Platform)
	})
	return credentials, nil
}

func upsertCredential(
	credentials []storedPlatformCredential, next storedPlatformCredential,
) []storedPlatformCredential {
	for index := range credentials {
		if credentials[index].Platform == next.Platform {
			credentials[index] = next
			return credentials
		}
	}
	credentials = append(credentials, next)
	slices.SortFunc(credentials, func(left, right storedPlatformCredential) int {
		return strings.Compare(left.Platform, right.Platform)
	})
	return credentials
}

func deleteCredential(
	credentials []storedPlatformCredential, platform string,
) ([]storedPlatformCredential, bool) {
	for index := range credentials {
		if credentials[index].Platform == platform {
			return append(credentials[:index], credentials[index+1:]...), true
		}
	}
	return credentials, false
}

func summarizeCredentials(
	credentials []storedPlatformCredential,
) ([]PlatformCredentialSummary, error) {
	summaries := make([]PlatformCredentialSummary, 0, len(credentials))
	for _, credential := range credentials {
		summary, err := credentialSummary(credential)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, summary)
	}
	return summaries, nil
}

func credentialSummary(credential storedPlatformCredential) (PlatformCredentialSummary, error) {
	updatedAt, err := parseRequiredTime(credential.UpdatedAt, "platform credential updatedAt")
	if err != nil {
		return PlatformCredentialSummary{}, err
	}
	return PlatformCredentialSummary{
		Platform: credential.Platform, KeyFingerprint: credential.Fingerprint, UpdatedAt: updatedAt,
	}, nil
}

func findResolvedCredential(
	credentials []storedPlatformCredential, platform string,
) (ResolvedPlatformCredential, error) {
	for _, credential := range credentials {
		if credential.Platform != platform {
			continue
		}
		updatedAt, err := parseRequiredTime(credential.UpdatedAt, "platform credential updatedAt")
		if err != nil {
			return ResolvedPlatformCredential{}, err
		}
		return ResolvedPlatformCredential{
			Platform: credential.Platform, APIKey: credential.APIKey,
			Fingerprint: credential.Fingerprint, UpdatedAt: updatedAt,
		}, nil
	}
	return ResolvedPlatformCredential{}, ErrCredentialNotConfigured
}

func scanPlatformConfig(sc scanner) (PlatformConfig, error) {
	var config PlatformConfig
	var enabled int
	var updatedAt string
	err := sc.Scan(&config.Platform, &config.DisplayName, &config.ConfigEnc, &enabled, &updatedAt)
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

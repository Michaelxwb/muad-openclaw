package repo

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

func (s *Store) CreatePlatformConfigAndMarkPods(config PlatformConfig) ([]string, error) {
	if err := validatePlatformConfig(config); err != nil {
		return nil, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin create platform config: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.Exec(`INSERT INTO platform_configs
		(platform, display_name, config_enc, enabled, updated_at) VALUES (?, ?, ?, ?, ?)`,
		config.Platform, strings.TrimSpace(config.DisplayName), config.ConfigEnc,
		boolToInt(config.Enabled), formatTime(time.Now().UTC()))
	if isUniqueConstraint(err) {
		return nil, ErrPlatformExists
	}
	if err != nil {
		return nil, fmt.Errorf("create platform config: %w", err)
	}
	return commitPlatformGeneration(tx)
}

func (s *Store) UpdatePlatformConfigAndMarkPods(
	platform, displayName, configEnc string, enabled bool,
) ([]string, error) {
	if !validPlatform(platform) || strings.TrimSpace(displayName) == "" {
		return nil, ErrInvalidPlatform
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin update platform config: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(`UPDATE platform_configs SET display_name = ?,
		config_enc = ?, enabled = ?, updated_at = ? WHERE platform = ?`,
		strings.TrimSpace(displayName), configEnc, boolToInt(enabled),
		formatTime(time.Now().UTC()), platform)
	if err := affectedOrNotFound(result, err, "update platform config"); err != nil {
		return nil, err
	}
	return commitPlatformGeneration(tx)
}

func commitPlatformGeneration(tx *sql.Tx) ([]string, error) {
	podIDs, err := markAllPodsConfigPendingTx(tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit platform config and Pod generations: %w", err)
	}
	return podIDs, nil
}

func markAllPodsConfigPendingTx(tx *sql.Tx) ([]string, error) {
	rows, err := tx.Query(`UPDATE pods SET config_generation = config_generation + 1,
		last_apply_status = 'pending', last_apply_error = '', updated_at = ?
		RETURNING pod_id`, formatTime(time.Now().UTC()))
	if err != nil {
		return nil, fmt.Errorf("mark platform config pending: %w", err)
	}
	defer rows.Close()
	var podIDs []string
	for rows.Next() {
		var podID string
		if err := rows.Scan(&podID); err != nil {
			return nil, fmt.Errorf("scan platform Pod generation: %w", err)
		}
		podIDs = append(podIDs, podID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate platform Pod generations: %w", err)
	}
	return podIDs, nil
}

package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrInvalidNotifyChannel rejects malformed notify channel rows at the repo
// boundary. Webhook plaintext validation happens before encryption upstream.
var ErrInvalidNotifyChannel = errors.New("repo: invalid notify channel")

const notifyChannelColumns = `channel_id, type, name, config_enc, enabled,
	created_at, updated_at`

// UpsertNotifyChannel creates (when ChannelID is empty) or updates one alert
// channel. ConfigEnc is stored verbatim; callers encrypt before persistence.
func (s *Store) UpsertNotifyChannel(channel NotifyChannel) (NotifyChannel, error) {
	prepared, err := prepareNotifyChannel(channel)
	if err != nil {
		return NotifyChannel{}, err
	}
	_, err = s.db.Exec(`INSERT INTO notify_channels (
		channel_id, type, name, config_enc, enabled, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?)
	 ON CONFLICT(channel_id) DO UPDATE SET
	   type=excluded.type, name=excluded.name, config_enc=excluded.config_enc,
	   enabled=excluded.enabled, updated_at=excluded.updated_at`,
		prepared.ChannelID, prepared.Type, prepared.Name, prepared.ConfigEnc,
		boolToInt(prepared.Enabled), formatTime(prepared.CreatedAt), formatTime(prepared.UpdatedAt))
	if err != nil {
		return NotifyChannel{}, fmt.Errorf("upsert notify channel: %w", err)
	}
	return s.GetNotifyChannel(prepared.ChannelID)
}

func prepareNotifyChannel(channel NotifyChannel) (NotifyChannel, error) {
	channel.ChannelID = strings.TrimSpace(channel.ChannelID)
	channel.Type = strings.TrimSpace(channel.Type)
	channel.Name = strings.TrimSpace(channel.Name)
	channel.ConfigEnc = strings.TrimSpace(channel.ConfigEnc)
	if channel.ChannelID == "" {
		id, err := generateUUIDv4()
		if err != nil {
			return NotifyChannel{}, fmt.Errorf("generate notify channel ID: %w", err)
		}
		channel.ChannelID = id
	}
	if !validNotifyChannelType(channel.Type) || channel.Name == "" || channel.ConfigEnc == "" {
		return NotifyChannel{}, ErrInvalidNotifyChannel
	}
	now := time.Now().UTC()
	if channel.CreatedAt.IsZero() {
		channel.CreatedAt = now
	}
	channel.UpdatedAt = now
	return channel, nil
}

func validNotifyChannelType(channelType string) bool {
	return channelType == NotifyChannelTypeWecom
}

// GetNotifyChannel returns one alert channel or ErrNotFound.
func (s *Store) GetNotifyChannel(channelID string) (NotifyChannel, error) {
	row := s.db.QueryRow(`SELECT `+notifyChannelColumns+`
		FROM notify_channels WHERE channel_id = ?`, strings.TrimSpace(channelID))
	return scanNotifyChannel(row)
}

// ListNotifyChannels returns every configured alert channel.
func (s *Store) ListNotifyChannels() ([]NotifyChannel, error) {
	rows, err := s.db.Query(`SELECT ` + notifyChannelColumns + `
		FROM notify_channels ORDER BY created_at ASC, channel_id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list notify channels: %w", err)
	}
	defer rows.Close()
	channels := []NotifyChannel{}
	for rows.Next() {
		channel, err := scanNotifyChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

// SetNotifyChannelEnabled toggles one channel without touching its ciphertext.
func (s *Store) SetNotifyChannelEnabled(channelID string, enabled bool) error {
	result, err := s.db.Exec(`UPDATE notify_channels SET enabled = ?, updated_at = ?
		WHERE channel_id = ?`, boolToInt(enabled), formatTime(time.Now().UTC()),
		strings.TrimSpace(channelID))
	return affectedOrNotFound(result, err, "set notify channel enabled")
}

// DeleteNotifyChannel removes one alert channel.
func (s *Store) DeleteNotifyChannel(channelID string) error {
	result, err := s.db.Exec(`DELETE FROM notify_channels WHERE channel_id = ?`,
		strings.TrimSpace(channelID))
	return affectedOrNotFound(result, err, "delete notify channel")
}

func scanNotifyChannel(sc scanner) (NotifyChannel, error) {
	var channel NotifyChannel
	var enabled int
	var createdAt, updatedAt string
	err := sc.Scan(&channel.ChannelID, &channel.Type, &channel.Name, &channel.ConfigEnc,
		&enabled, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return NotifyChannel{}, ErrNotFound
	}
	if err != nil {
		return NotifyChannel{}, fmt.Errorf("scan notify channel: %w", err)
	}
	channel.Enabled = enabled == 1
	var parseErr error
	channel.CreatedAt, parseErr = parseRequiredTime(createdAt, "notify_channels.created_at")
	if parseErr != nil {
		return NotifyChannel{}, parseErr
	}
	channel.UpdatedAt, parseErr = parseRequiredTime(updatedAt, "notify_channels.updated_at")
	if parseErr != nil {
		return NotifyChannel{}, parseErr
	}
	return channel, nil
}

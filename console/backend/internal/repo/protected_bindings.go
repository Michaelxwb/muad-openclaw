package repo

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// ProtectedBindings is the read-only snapshot of everything a one-way runtime
// upgrade must not change: pod channel identity/config ciphertext, user
// ownership (agent/model/profile/status) and channel identities.
type ProtectedBindings struct {
	PodID               string
	Channels            string
	ChannelConfigDigest string
	Users               []ProtectedUser
	Identities          []ProtectedIdentity
}

// ProtectedUser mirrors the protected human_users columns.
type ProtectedUser struct {
	HumanUserID    string
	PodID          string
	AgentID        string
	ModelConfigID  string
	BrowserProfile string
	BrowserCDPPort int
	Status         string
	Prompt         string
}

// ProtectedIdentity mirrors the protected user_identities columns.
type ProtectedIdentity struct {
	IdentityID      string
	HumanUserID     string
	Channel         string
	OpenClawChannel string
	AccountID       string
	ExternalID      string
	ExternalIDType  string
	PeerKind        string
	Status          string
}

// SnapshotProtectedBindings reads the protected records with explicit columns
// in short read-only statements (no wildcard projection, no long transaction,
// no secrets in the result: the channel config is reduced to a digest).
func (s *Store) SnapshotProtectedBindings(podID string) (ProtectedBindings, error) {
	snapshot := ProtectedBindings{PodID: podID}
	var channels, channelConfigs string
	if err := s.db.QueryRow(
		`SELECT channels, channel_configs_enc FROM pods WHERE pod_id = ?`, podID,
	).Scan(&channels, &channelConfigs); err != nil {
		return ProtectedBindings{}, fmt.Errorf("snapshot pod bindings: %w", err)
	}
	snapshot.Channels = channels
	digest := sha256.Sum256([]byte(channelConfigs))
	snapshot.ChannelConfigDigest = hex.EncodeToString(digest[:])

	userRows, err := s.db.Query(
		`SELECT human_user_id, pod_id, agent_id, model_config_id, browser_profile,
		        browser_cdp_port, status, prompt
		   FROM human_users WHERE pod_id = ? ORDER BY human_user_id`, podID)
	if err != nil {
		return ProtectedBindings{}, fmt.Errorf("snapshot users: %w", err)
	}
	defer userRows.Close()
	for userRows.Next() {
		var user ProtectedUser
		if err := userRows.Scan(
			&user.HumanUserID, &user.PodID, &user.AgentID, &user.ModelConfigID,
			&user.BrowserProfile, &user.BrowserCDPPort, &user.Status, &user.Prompt,
		); err != nil {
			return ProtectedBindings{}, fmt.Errorf("scan user: %w", err)
		}
		snapshot.Users = append(snapshot.Users, user)
	}
	if err := userRows.Err(); err != nil {
		return ProtectedBindings{}, fmt.Errorf("iterate users: %w", err)
	}

	identityRows, err := s.db.Query(
		`SELECT identity_id, human_user_id, channel, openclaw_channel, account_id,
		        external_id, external_id_type, peer_kind, status
		   FROM user_identities
		  WHERE human_user_id IN (SELECT human_user_id FROM human_users WHERE pod_id = ?)
		  ORDER BY identity_id`, podID)
	if err != nil {
		return ProtectedBindings{}, fmt.Errorf("snapshot identities: %w", err)
	}
	defer identityRows.Close()
	for identityRows.Next() {
		var identity ProtectedIdentity
		if err := identityRows.Scan(
			&identity.IdentityID, &identity.HumanUserID, &identity.Channel,
			&identity.OpenClawChannel, &identity.AccountID, &identity.ExternalID,
			&identity.ExternalIDType, &identity.PeerKind, &identity.Status,
		); err != nil {
			return ProtectedBindings{}, fmt.Errorf("scan identity: %w", err)
		}
		snapshot.Identities = append(snapshot.Identities, identity)
	}
	if err := identityRows.Err(); err != nil {
		return ProtectedBindings{}, fmt.Errorf("iterate identities: %w", err)
	}
	return snapshot, nil
}

// DiffProtectedBindings returns stable, redacted descriptions of protected
// changes. An empty result means every protected record is unchanged.
func DiffProtectedBindings(before, after ProtectedBindings) []string {
	var diff []string
	if before.Channels != after.Channels {
		diff = append(diff, "pods.channels changed")
	}
	if before.ChannelConfigDigest != after.ChannelConfigDigest {
		diff = append(diff, "pods.channel_configs changed")
	}
	diff = append(diff, diffProtectedUsers(before.Users, after.Users)...)
	diff = append(diff, diffProtectedIdentities(before.Identities, after.Identities)...)
	sort.Strings(diff)
	return diff
}

func diffProtectedUsers(before, after []ProtectedUser) []string {
	beforeByID := map[string]ProtectedUser{}
	for _, user := range before {
		beforeByID[user.HumanUserID] = user
	}
	var diff []string
	seen := map[string]bool{}
	for _, user := range after {
		seen[user.HumanUserID] = true
		previous, ok := beforeByID[user.HumanUserID]
		if !ok {
			diff = append(diff, fmt.Sprintf("human_users[%s] added", user.HumanUserID))
			continue
		}
		diff = append(diff, diffUserFields(previous, user)...)
	}
	for id := range beforeByID {
		if !seen[id] {
			diff = append(diff, fmt.Sprintf("human_users[%s] removed", id))
		}
	}
	return diff
}

func diffUserFields(before, after ProtectedUser) []string {
	var diff []string
	fields := []struct {
		name         string
		before, after string
	}{
		{"pod_id", before.PodID, after.PodID},
		{"agent_id", before.AgentID, after.AgentID},
		{"model_config_id", before.ModelConfigID, after.ModelConfigID},
		{"browser_profile", before.BrowserProfile, after.BrowserProfile},
		{"status", before.Status, after.Status},
		{"prompt", before.Prompt, after.Prompt},
	}
	for _, field := range fields {
		if field.before != field.after {
			diff = append(diff, fmt.Sprintf("human_users[%s].%s changed", before.HumanUserID, field.name))
		}
	}
	if before.BrowserCDPPort != after.BrowserCDPPort {
		diff = append(diff, fmt.Sprintf("human_users[%s].browser_cdp_port changed", before.HumanUserID))
	}
	return diff
}

func diffProtectedIdentities(before, after []ProtectedIdentity) []string {
	beforeByID := map[string]ProtectedIdentity{}
	for _, identity := range before {
		beforeByID[identity.IdentityID] = identity
	}
	var diff []string
	seen := map[string]bool{}
	for _, identity := range after {
		seen[identity.IdentityID] = true
		previous, ok := beforeByID[identity.IdentityID]
		if !ok {
			diff = append(diff, fmt.Sprintf("user_identities[%s] added", identity.IdentityID))
			continue
		}
		diff = append(diff, diffIdentityFields(previous, identity)...)
	}
	for id := range beforeByID {
		if !seen[id] {
			diff = append(diff, fmt.Sprintf("user_identities[%s] removed", id))
		}
	}
	return diff
}

func diffIdentityFields(before, after ProtectedIdentity) []string {
	var diff []string
	fields := []struct {
		name         string
		before, after string
	}{
		{"human_user_id", before.HumanUserID, after.HumanUserID},
		{"channel", before.Channel, after.Channel},
		{"openclaw_channel", before.OpenClawChannel, after.OpenClawChannel},
		{"account_id", before.AccountID, after.AccountID},
		{"external_id", before.ExternalID, after.ExternalID},
		{"external_id_type", before.ExternalIDType, after.ExternalIDType},
		{"peer_kind", before.PeerKind, after.PeerKind},
		{"status", before.Status, after.Status},
	}
	for _, field := range fields {
		if field.before != field.after {
			diff = append(diff, fmt.Sprintf("user_identities[%s].%s changed", before.IdentityID, field.name))
		}
	}
	return diff
}

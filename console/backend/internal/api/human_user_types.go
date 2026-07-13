package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

var (
	identityFieldPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	accountIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type identityInput struct {
	Channel        string `json:"channel"`
	AccountID      string `json:"accountId"`
	ExternalID     string `json:"externalId"`
	ExternalIDType string `json:"externalIdType"`
	PeerKind       string `json:"peerKind"`
}

type activationInput struct {
	Channel          string `json:"channel"`
	AccountID        string `json:"accountId"`
	ExpiresInMinutes int    `json:"expiresInMinutes"`
}

type createHumanUserRequest struct {
	DisplayName   string           `json:"displayName"`
	AgentID       string           `json:"agentId"`
	ModelConfigID string           `json:"modelConfigId"`
	Notes         string           `json:"notes"`
	Identity      *identityInput   `json:"identity"`
	Activation    *activationInput `json:"activation"`
}

type assignedModelView struct {
	Provider       string `json:"provider,omitempty"`
	BaseURL        string `json:"baseUrl,omitempty"`
	Model          string `json:"model,omitempty"`
	KeyConfigured  bool   `json:"keyConfigured"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
}

type humanUserView struct {
	HumanUserID    string            `json:"humanUserId"`
	PodID          string            `json:"podId"`
	ModelConfigID  string            `json:"modelConfigId"`
	DisplayName    string            `json:"displayName"`
	AgentID        string            `json:"agentId"`
	BrowserProfile string            `json:"browserProfile"`
	BrowserCDPPort int               `json:"browserCdpPort"`
	Status         string            `json:"status"`
	Notes          string            `json:"notes"`
	IdentityCount  int               `json:"identityCount"`
	ModelConfig    assignedModelView `json:"modelConfig"`
	CreatedAt      time.Time         `json:"createdAt"`
	UpdatedAt      time.Time         `json:"updatedAt"`
}

type identityView struct {
	IdentityID      string    `json:"identityId"`
	Channel         string    `json:"channel"`
	OpenClawChannel string    `json:"openclawChannel"`
	AccountID       string    `json:"accountId"`
	ExternalID      string    `json:"externalId"`
	ExternalIDType  string    `json:"externalIdType"`
	PeerKind        string    `json:"peerKind"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func normalizeIdentityInput(pod repo.Pod, input identityInput) (repo.UserIdentity, error) {
	input.Channel = strings.TrimSpace(input.Channel)
	input.AccountID = strings.TrimSpace(input.AccountID)
	input.ExternalIDType = strings.TrimSpace(input.ExternalIDType)
	input.PeerKind = strings.TrimSpace(input.PeerKind)
	if input.AccountID == "" {
		input.AccountID = "default"
	}
	if input.PeerKind == "" {
		input.PeerKind = "direct"
	}
	if !driver.IsValidChannel(input.Channel) || !podUsesChannel(pod, input.Channel) ||
		input.PeerKind != "direct" || !identityFieldPattern.MatchString(input.ExternalIDType) ||
		strings.TrimSpace(input.ExternalID) == "" || len(input.ExternalID) > 512 ||
		!accountIDPattern.MatchString(input.AccountID) {
		return repo.UserIdentity{}, repo.ErrInvalidHumanUser
	}
	return repo.UserIdentity{
		Channel: input.Channel, OpenClawChannel: driver.OpenClawChannelFor(input.Channel),
		AccountID: input.AccountID, ExternalID: input.ExternalID,
		ExternalIDType: input.ExternalIDType, PeerKind: input.PeerKind,
		Status: repo.IdentityStatusActive,
	}, nil
}

func normalizeActivationInput(pod repo.Pod, input activationInput) (repo.BindingCodeRequest, error) {
	input.Channel = strings.TrimSpace(input.Channel)
	input.AccountID = strings.TrimSpace(input.AccountID)
	if input.AccountID == "" {
		input.AccountID = "default"
	}
	if input.ExpiresInMinutes == 0 {
		input.ExpiresInMinutes = 30
	}
	if !driver.IsValidChannel(input.Channel) || !podUsesChannel(pod, input.Channel) ||
		input.ExpiresInMinutes < 1 || input.ExpiresInMinutes > 24*60 ||
		!accountIDPattern.MatchString(input.AccountID) {
		return repo.BindingCodeRequest{}, repo.ErrInvalidBindingCode
	}
	return repo.BindingCodeRequest{
		Channel: input.Channel, OpenClawChannel: driver.OpenClawChannelFor(input.Channel),
		AccountID: input.AccountID, Purpose: repo.BindingPurposeFirstIdentity,
		ExpiresAt: time.Now().UTC().Add(time.Duration(input.ExpiresInMinutes) * time.Minute),
	}, nil
}

func podUsesChannel(pod repo.Pod, channel string) bool {
	var channels []string
	if err := decodeDocument([]byte(pod.Channels), &channels); err != nil {
		return false
	}
	for _, enabled := range channels {
		if enabled == channel {
			return true
		}
	}
	return false
}

func resolveAgentID(requested, displayName string) (string, error) {
	if requested = strings.TrimSpace(requested); requested != "" {
		return requested, nil
	}
	base := sanitizeAgentBase(displayName)
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate agent ID: %w", err)
	}
	return base + "-" + hex.EncodeToString(raw), nil
}

func sanitizeAgentBase(value string) string {
	var output strings.Builder
	for _, char := range strings.ToLower(value) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			output.WriteRune(char)
		} else if output.Len() > 0 && output.String()[output.Len()-1] != '-' {
			output.WriteByte('-')
		}
		if output.Len() >= 48 {
			break
		}
	}
	base := strings.Trim(output.String(), "-")
	if base == "" || base == "main" || base == "quarantine" {
		return "user"
	}
	return base
}

func identityToView(identity repo.UserIdentity) identityView {
	return identityView{
		IdentityID: identity.IdentityID, Channel: identity.Channel,
		OpenClawChannel: identity.OpenClawChannel, AccountID: identity.AccountID,
		ExternalID: identity.ExternalID, ExternalIDType: identity.ExternalIDType,
		PeerKind: identity.PeerKind, Status: identity.Status,
		CreatedAt: identity.CreatedAt, UpdatedAt: identity.UpdatedAt,
	}
}

func modelConfigToView(model repo.LLMModelConfig) assignedModelView {
	return assignedModelView{
		Provider: model.Provider, BaseURL: model.BaseURL, Model: model.Model,
		KeyConfigured:  model.APIKeyEnc != "",
		KeyFingerprint: secretcrypto.DisplayFingerprint(model.APIKeyFingerprint),
	}
}

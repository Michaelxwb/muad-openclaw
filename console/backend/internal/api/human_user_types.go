package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
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
	Prompt        string           `json:"prompt"`
	Identity      *identityInput   `json:"identity"`
	Activation    *activationInput `json:"activation"`
}

type assignedModelView struct {
	Provider      string `json:"provider,omitempty"`
	BaseURL       string `json:"baseUrl,omitempty"`
	Model         string `json:"model,omitempty"`
	KeyConfigured bool   `json:"keyConfigured"`
	APIKey        string `json:"apiKey,omitempty"`
}

type humanUserView struct {
	HumanUserID    string            `json:"humanUserId"`
	PodID          string            `json:"podId"`
	LastPodID      string            `json:"lastPodId,omitempty"`
	ModelConfigID  string            `json:"modelConfigId"`
	DisplayName    string            `json:"displayName"`
	AgentID        string            `json:"agentId"`
	BrowserProfile string            `json:"browserProfile"`
	BrowserCDPPort int               `json:"browserCdpPort"`
	Status         string            `json:"status"`
	Prompt         string            `json:"prompt"`
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
	if err := validateIdentityInput(pod, input); err != nil {
		return repo.UserIdentity{}, err
	}
	return repo.UserIdentity{
		Channel: input.Channel, OpenClawChannel: driver.OpenClawChannelFor(input.Channel),
		AccountID: input.AccountID, ExternalID: input.ExternalID,
		ExternalIDType: input.ExternalIDType, PeerKind: input.PeerKind,
		Status: repo.IdentityStatusActive,
	}, nil
}

func validateIdentityInput(pod repo.Pod, input identityInput) error {
	if !driver.IsValidChannel(input.Channel) {
		return wrapInputValidationError(
			errcode.InvalidHumanUserConfig, repo.ErrInvalidHumanUser,
			fmt.Sprintf("identity.channel %q 不支持，请选择 Pod 已启用的通道", input.Channel),
			fmt.Sprintf("identity.channel %q is not supported", input.Channel),
		)
	}
	if !podUsesChannel(pod, input.Channel) {
		return wrapInputValidationError(
			errcode.InvalidHumanUserConfig, repo.ErrInvalidHumanUser,
			fmt.Sprintf("identity.channel %q 未在当前 Pod 启用", input.Channel),
			fmt.Sprintf("identity.channel %q is not enabled on this Pod", input.Channel),
		)
	}
	if input.PeerKind != "direct" {
		return invalidHumanUserField("identity.peerKind 只能填写 direct", "identity.peerKind must be direct")
	}
	if !identityFieldPattern.MatchString(input.ExternalIDType) {
		return invalidHumanUserField(
			"identity.externalIdType 必须以小写字母开头，只能包含小写字母、数字和下划线，最长 64 位",
			"identity.externalIdType must start with a lowercase letter and contain lowercase letters, digits, or underscores, max 64 characters",
		)
	}
	if strings.TrimSpace(input.ExternalID) == "" || len(input.ExternalID) > 512 {
		return invalidHumanUserField(
			"identity.externalId 不能为空，且不能超过 512 个字符",
			"identity.externalId is required and must be at most 512 characters",
		)
	}
	if !accountIDPattern.MatchString(input.AccountID) {
		return invalidHumanUserField(
			"identity.accountId 只能包含字母、数字、点、下划线、冒号或中划线，最长 128 位",
			"identity.accountId may contain letters, digits, dots, underscores, colons, or hyphens, max 128 characters",
		)
	}
	return nil
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
	if err := validateActivationInput(pod, input); err != nil {
		return repo.BindingCodeRequest{}, err
	}
	return repo.BindingCodeRequest{
		Channel: input.Channel, OpenClawChannel: driver.OpenClawChannelFor(input.Channel),
		AccountID: input.AccountID, Purpose: repo.BindingPurposeFirstIdentity,
		ExpiresAt: time.Now().UTC().Add(time.Duration(input.ExpiresInMinutes) * time.Minute),
	}, nil
}

func validateActivationInput(pod repo.Pod, input activationInput) error {
	if !driver.IsValidChannel(input.Channel) {
		return invalidBindingField(
			fmt.Sprintf("activation.channel %q 不支持，请选择 Pod 已启用的通道", input.Channel),
			fmt.Sprintf("activation.channel %q is not supported", input.Channel),
		)
	}
	if !podUsesChannel(pod, input.Channel) {
		return invalidBindingField(
			fmt.Sprintf("activation.channel %q 未在当前 Pod 启用", input.Channel),
			fmt.Sprintf("activation.channel %q is not enabled on this Pod", input.Channel),
		)
	}
	if input.ExpiresInMinutes < 1 || input.ExpiresInMinutes > 24*60 {
		return invalidBindingField(
			"activation.expiresInMinutes 必须在 1-1440 分钟之间",
			"activation.expiresInMinutes must be between 1 and 1440 minutes",
		)
	}
	if !accountIDPattern.MatchString(input.AccountID) {
		return invalidBindingField(
			"activation.accountId 只能包含字母、数字、点、下划线、冒号或中划线，最长 128 位",
			"activation.accountId may contain letters, digits, dots, underscores, colons, or hyphens, max 128 characters",
		)
	}
	return nil
}

func invalidHumanUserField(detailZH, detailEN string) error {
	return wrapInputValidationError(
		errcode.InvalidHumanUserConfig, repo.ErrInvalidHumanUser, detailZH, detailEN,
	)
}

func invalidBindingField(detailZH, detailEN string) error {
	return wrapInputValidationError(
		errcode.InvalidHumanUserConfig, repo.ErrInvalidBindingCode, detailZH, detailEN,
	)
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
		KeyConfigured: model.APIKey != "",
		APIKey:        model.APIKey,
	}
}

package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type channelConfigInput struct {
	BotID               string `json:"botId"`
	Secret              string `json:"secret"`
	BaseURL             string `json:"baseUrl,omitempty"`
	BotToken            string `json:"botToken,omitempty"`
	AllowPrivateNetwork string `json:"allowPrivateNetwork,omitempty"`
}

type channelConfigView struct {
	BotID               string `json:"botId,omitempty"`
	BaseURL             string `json:"baseUrl,omitempty"`
	AllowPrivateNetwork string `json:"allowPrivateNetwork,omitempty"`
	SecretConfigured    bool   `json:"secretConfigured"`
	BotTokenConfigured  bool   `json:"botTokenConfigured,omitempty"`
}

type podChannelsRequest struct {
	Channels       []string                      `json:"channels"`
	ChannelConfigs map[string]channelConfigInput `json:"channelConfigs"`
}

func (s *Server) normalizeChannelSettings(
	request podChannelsRequest, current map[string]channelConfigInput,
) ([]string, map[string]channelConfigInput, error) {
	channels := make([]string, 0, len(request.Channels))
	seen := make(map[string]struct{}, len(request.Channels))
	for _, raw := range request.Channels {
		channel := strings.TrimSpace(raw)
		if !driver.IsValidChannel(channel) {
			return nil, nil, newInputValidationError(
				errcode.InvalidChannelConfig,
				fmt.Sprintf("channels 包含不支持的通道 %q，目前支持 wecom、wechat、mattermost", channel),
				fmt.Sprintf("channels contains unsupported channel %q; supported channels are wecom, wechat, mattermost", channel),
			)
		}
		if _, exists := seen[channel]; exists {
			return nil, nil, newInputValidationError(
				errcode.InvalidChannelConfig,
				fmt.Sprintf("channels 中的通道 %q 重复，请只保留一次", channel),
				fmt.Sprintf("channel %q appears more than once in channels", channel),
			)
		}
		seen[channel] = struct{}{}
		channels = append(channels, channel)
	}
	if len(channels) == 0 {
		return nil, nil, newInputValidationError(
			errcode.InvalidChannelConfig,
			"channels 至少要选择一个消息通道",
			"channels must contain at least one message channel",
		)
	}
	for channel := range request.ChannelConfigs {
		if _, exists := seen[channel]; !exists {
			return nil, nil, newInputValidationError(
				errcode.InvalidChannelConfig,
				fmt.Sprintf("channelConfigs.%s 不属于已启用的通道，请先在 channels 中选择它", channel),
				fmt.Sprintf("channelConfigs.%s is not enabled in channels", channel),
			)
		}
	}
	slices.Sort(channels)
	configs := make(map[string]channelConfigInput, len(channels))
	for _, channel := range channels {
		config := mergeChannelInput(current[channel], request.ChannelConfigs[channel])
		if err := validateChannelInput(channel, config); err != nil {
			return nil, nil, err
		}
		configs[channel] = config
	}
	return channels, configs, nil
}

func mergeChannelInput(current, requested channelConfigInput) channelConfigInput {
	next := channelConfigInput{
		BotID:               strings.TrimSpace(requested.BotID),
		Secret:              strings.TrimSpace(requested.Secret),
		BaseURL:             strings.TrimSpace(requested.BaseURL),
		BotToken:            strings.TrimSpace(requested.BotToken),
		AllowPrivateNetwork: strings.TrimSpace(requested.AllowPrivateNetwork),
	}
	if next.BotID == "" {
		next.BotID = current.BotID
	}
	if next.Secret == "" {
		next.Secret = current.Secret
	}
	if next.BaseURL == "" {
		next.BaseURL = current.BaseURL
	}
	if next.BotToken == "" {
		next.BotToken = current.BotToken
	}
	if next.AllowPrivateNetwork == "" {
		next.AllowPrivateNetwork = current.AllowPrivateNetwork
	}
	return next
}

func validateChannelInput(channel string, config channelConfigInput) error {
	if len(config.BotID) > 256 || len(config.Secret) > 4096 || len(config.BotToken) > 4096 ||
		len(config.BaseURL) > 2048 {
		return newInputValidationError(
			errcode.InvalidChannelConfig,
			"channelConfigs 中的 botId/baseUrl 过长，或 secret/botToken 超过长度限制",
			"channelConfigs contains an overlong botId/baseUrl or secret/botToken",
		)
	}
	if channel == driver.ChannelWeCom && (config.BotID == "" || config.Secret == "") {
		return newInputValidationError(
			errcode.InvalidChannelConfig,
			"channelConfigs.wecom 必须填写 botId 和 secret",
			"channelConfigs.wecom requires botId and secret",
		)
	}
	if channel == driver.ChannelWeChat && hasAnyChannelCredential(config) {
		return newInputValidationError(
			errcode.InvalidChannelConfig,
			"channelConfigs.wechat 不需要填写 botId、secret、baseUrl 或 botToken",
			"channelConfigs.wechat must not include botId, secret, baseUrl, or botToken",
		)
	}
	if channel == driver.ChannelMattermost {
		if config.BaseURL == "" || config.BotToken == "" {
			return newInputValidationError(
				errcode.InvalidChannelConfig,
				"channelConfigs.mattermost 必须填写 baseUrl 和 botToken",
				"channelConfigs.mattermost requires baseUrl and botToken",
			)
		}
		if err := validateHTTPURL(config.BaseURL); err != nil {
			return err
		}
		if config.AllowPrivateNetwork != "" && config.AllowPrivateNetwork != "true" &&
			config.AllowPrivateNetwork != "false" {
			return newInputValidationError(
				errcode.InvalidChannelConfig,
				"channelConfigs.mattermost.allowPrivateNetwork 只能为空、true 或 false",
				"channelConfigs.mattermost.allowPrivateNetwork must be empty, true, or false",
			)
		}
	}
	return nil
}

func hasAnyChannelCredential(config channelConfigInput) bool {
	return config.BotID != "" || config.Secret != "" || config.BaseURL != "" || config.BotToken != "" ||
		config.AllowPrivateNetwork != ""
}

func validateHTTPURL(value string) error {
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return newInputValidationError(
			errcode.InvalidChannelConfig,
			"channelConfigs.mattermost.baseUrl 必须是完整 URL，例如 https://mattermost.example.com",
			"channelConfigs.mattermost.baseUrl must be a full URL, for example https://mattermost.example.com",
		)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return newInputValidationError(
			errcode.InvalidChannelConfig,
			"channelConfigs.mattermost.baseUrl 只能使用 http 或 https",
			"channelConfigs.mattermost.baseUrl must use http or https",
		)
	}
	return nil
}

func (s *Server) encodeChannelSettings(
	channels []string, configs map[string]channelConfigInput,
) (string, string, error) {
	channelsJSON, err := json.Marshal(channels)
	if err != nil {
		return "", "", fmt.Errorf("encode channels: %w", err)
	}
	configsJSON, err := json.Marshal(configs)
	if err != nil {
		return "", "", fmt.Errorf("encode channel configs: %w", err)
	}
	encrypted, err := s.cipher.Encrypt(string(configsJSON))
	if err != nil {
		return "", "", fmt.Errorf("encrypt channel configs: %w", err)
	}
	return string(channelsJSON), encrypted, nil
}

func (s *Server) decodeChannelSettings(pod repo.Pod) ([]string, map[string]channelConfigInput, error) {
	var channels []string
	if err := decodeDocument([]byte(pod.Channels), &channels); err != nil {
		return nil, nil, fmt.Errorf("decode channels: %w", err)
	}
	configs := map[string]channelConfigInput{}
	if pod.ChannelConfigsEnc == "" {
		return channels, configs, nil
	}
	plain, err := s.cipher.Decrypt(pod.ChannelConfigsEnc)
	if err != nil {
		return nil, nil, fmt.Errorf("decrypt channel configs: %w", err)
	}
	if err := decodeDocument([]byte(plain), &configs); err != nil {
		return nil, nil, fmt.Errorf("decode channel configs: %w", err)
	}
	return channels, configs, nil
}

func channelConfigViews(
	channels []string, configs map[string]channelConfigInput,
) map[string]channelConfigView {
	views := make(map[string]channelConfigView, len(channels))
	for _, channel := range channels {
		config := configs[channel]
		views[channel] = channelConfigView{
			BotID:               config.BotID,
			BaseURL:             config.BaseURL,
			AllowPrivateNetwork: config.AllowPrivateNetwork,
			SecretConfigured:    config.Secret != "" || config.BotToken != "",
			BotTokenConfigured:  config.BotToken != "",
		}
	}
	return views
}

func rawChannelConfigs(configs map[string]channelConfigInput) (map[string]json.RawMessage, error) {
	result := make(map[string]json.RawMessage, len(configs))
	for channel, config := range configs {
		raw, err := json.Marshal(runtimeChannelConfig(channel, config))
		if err != nil {
			return nil, fmt.Errorf("encode channel %s: %w", channel, err)
		}
		result[channel] = raw
	}
	return result, nil
}

func runtimeChannelConfig(channel string, config channelConfigInput) map[string]string {
	switch channel {
	case driver.ChannelMattermost:
		allowPrivateNetwork := config.AllowPrivateNetwork
		if allowPrivateNetwork == "" {
			allowPrivateNetwork = "false"
		}
		return map[string]string{
			"baseUrl":             config.BaseURL,
			"botToken":            config.BotToken,
			"dmPolicy":            "open",
			"groupPolicy":         "disabled",
			"allowFrom":           "*",
			"allowPrivateNetwork": allowPrivateNetwork,
		}
	case driver.ChannelWeCom:
		return map[string]string{"botId": config.BotID, "secret": config.Secret}
	default:
		return map[string]string{}
	}
}

func decodeDocument(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

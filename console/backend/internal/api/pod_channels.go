package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type channelConfigInput struct {
	BotID  string `json:"botId"`
	Secret string `json:"secret"`
}

type channelConfigView struct {
	BotID            string `json:"botId,omitempty"`
	SecretConfigured bool   `json:"secretConfigured"`
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
			return nil, nil, errors.New("unsupported channel alias")
		}
		if _, exists := seen[channel]; exists {
			return nil, nil, errors.New("duplicate channel alias")
		}
		seen[channel] = struct{}{}
		channels = append(channels, channel)
	}
	if len(channels) == 0 {
		return nil, nil, errors.New("at least one channel is required")
	}
	for channel := range request.ChannelConfigs {
		if _, exists := seen[channel]; !exists {
			return nil, nil, errors.New("channel config does not belong to an enabled channel")
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
	next := channelConfigInput{BotID: strings.TrimSpace(requested.BotID), Secret: strings.TrimSpace(requested.Secret)}
	if next.BotID == "" {
		next.BotID = current.BotID
	}
	if next.Secret == "" {
		next.Secret = current.Secret
	}
	return next
}

func validateChannelInput(channel string, config channelConfigInput) error {
	if len(config.BotID) > 256 || len(config.Secret) > 4096 {
		return errors.New("channel credential is too long")
	}
	if channel == driver.ChannelWeCom && (config.BotID == "" || config.Secret == "") {
		return errors.New("wecom botId and secret are required")
	}
	if channel == driver.ChannelWeChat && (config.BotID != "" || config.Secret != "") {
		return errors.New("wechat does not accept bot credentials")
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
		views[channel] = channelConfigView{BotID: config.BotID, SecretConfigured: config.Secret != ""}
	}
	return views
}

func rawChannelConfigs(configs map[string]channelConfigInput) (map[string]json.RawMessage, error) {
	result := make(map[string]json.RawMessage, len(configs))
	for channel, config := range configs {
		raw, err := json.Marshal(config)
		if err != nil {
			return nil, fmt.Errorf("encode channel %s: %w", channel, err)
		}
		result[channel] = raw
	}
	return result, nil
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

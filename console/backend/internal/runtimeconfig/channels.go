package runtimeconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func (builder *Builder) buildChannels(pod repo.Pod) (driver.RuntimeChannels, error) {
	var enabled []string
	if err := decodeStrictJSON([]byte(pod.Channels), &enabled); err != nil || len(enabled) == 0 {
		return driver.RuntimeChannels{}, wrapInvalid("decode Pod channels", valueOrError(err))
	}
	slices.Sort(enabled)
	configs, err := builder.decryptChannelConfigs(pod.ChannelConfigsEnc)
	if err != nil {
		return driver.RuntimeChannels{}, err
	}
	for _, channel := range enabled {
		if _, exists := configs[channel]; !exists {
			configs[channel] = json.RawMessage(`{}`)
		}
	}
	for channel := range configs {
		if _, exists := slices.BinarySearch(enabled, channel); !exists {
			delete(configs, channel)
		}
	}
	return driver.RuntimeChannels{Enabled: enabled, Configs: configs}, nil
}

func (builder *Builder) decryptChannelConfigs(encrypted string) (map[string]json.RawMessage, error) {
	if encrypted == "" {
		return map[string]json.RawMessage{}, nil
	}
	plain, err := builder.cipher.Decrypt(encrypted)
	if err != nil {
		return nil, wrapInvalid("decrypt channel configs", err)
	}
	configs := map[string]json.RawMessage{}
	if err := decodeStrictJSON([]byte(plain), &configs); err != nil {
		return nil, wrapInvalid("decode channel configs", err)
	}
	for channel, raw := range configs {
		var value map[string]string
		if err := decodeStrictJSON(raw, &value); err != nil || value == nil {
			return nil, wrapInvalid("decode channel config", valueOrError(err))
		}
		canonical, err := json.Marshal(value)
		if err != nil {
			return nil, wrapInvalid("canonicalize channel config", err)
		}
		configs[channel] = canonical
	}
	return configs, nil
}

func decodeStrictJSON(raw []byte, target any) error {
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

package runtimeconfig

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func (builder *Builder) buildPlatforms(input []repo.PlatformConfig) ([]driver.RuntimePlatform, error) {
	platforms := append([]repo.PlatformConfig(nil), input...)
	slices.SortFunc(platforms, func(left, right repo.PlatformConfig) int {
		return strings.Compare(left.Platform, right.Platform)
	})
	result := make([]driver.RuntimePlatform, 0, len(platforms))
	for _, platform := range platforms {
		if !platform.Enabled {
			continue
		}
		config, err := builder.platformConfig(platform.ConfigEnc)
		if err != nil {
			return nil, err
		}
		if platform.Platform == "" || strings.TrimSpace(platform.DisplayName) == "" {
			return nil, ErrInvalidRuntimeSource
		}
		result = append(result, driver.RuntimePlatform{
			ID: platform.Platform, DisplayName: strings.TrimSpace(platform.DisplayName), Config: config,
		})
	}
	return result, nil
}

func (builder *Builder) platformConfig(encrypted string) (json.RawMessage, error) {
	if encrypted == "" {
		return json.RawMessage(`{}`), nil
	}
	plain, err := builder.cipher.Decrypt(encrypted)
	if err != nil {
		return nil, wrapInvalid("decrypt platform config", err)
	}
	decoder := json.NewDecoder(bytes.NewBufferString(plain))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, wrapInvalid("decode platform config", valueOrError(err))
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, wrapInvalid("decode platform config", errors.New("trailing JSON value"))
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, wrapInvalid("canonicalize platform config", err)
	}
	return canonical, nil
}

func finish(config driver.RuntimeConfigV1) (Result, error) {
	if err := config.Validate(); err != nil {
		return Result{}, wrapInvalid("validate runtime config", err)
	}
	canonical, err := json.Marshal(config)
	if err != nil {
		return Result{}, wrapInvalid("marshal runtime config", err)
	}
	sum := sha256.Sum256(canonical)
	return Result{
		Config: config, CanonicalJSON: canonical,
		Hash: "sha256:" + hex.EncodeToString(sum[:]),
	}, nil
}

func valueOrError(err error) error {
	if err != nil {
		return err
	}
	return errors.New("JSON object is required")
}

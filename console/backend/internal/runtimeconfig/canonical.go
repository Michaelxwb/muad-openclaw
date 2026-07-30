package runtimeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
		if platform.Platform == "" || strings.TrimSpace(platform.DisplayName) == "" {
			return nil, ErrInvalidRuntimeSource
		}
		result = append(result, driver.RuntimePlatform{
			ID: platform.Platform, DisplayName: strings.TrimSpace(platform.DisplayName),
			Config: json.RawMessage(`{}`),
		})
	}
	return result, nil
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

// Package driver abstracts the container runtime (docker / k8s) behind a single
// contract so the rest of the console is runtime-agnostic (FEAT-07, §3.5).
package driver

import (
	"context"
	"errors"
	"strings"
	"time"
)

// ErrNotImplemented is returned by drivers that do not yet implement a method
// (e.g. the k8s stub, §3.5 / RISK-05).
var ErrNotImplemented = errors.New("driver: not implemented")

// LlmConfig is an LLM provider configuration (already merged: global ⊕ override).
type LlmConfig struct {
	Provider string
	BaseURL  string
	APIKey   string
	Model    string
}

// UserSpec is the desired state for one user's container.
type UserSpec struct {
	UserID   string
	Channel  string // message channel: "wecom" (企业微信) | "wechat" (微信)
	BotID    string
	Secret   string
	ImageTag string // full image reference
	LLM      LlmConfig
}

// Stats is a one-shot resource sample (no streaming, RULE-06).
type Stats struct {
	CPUPercent float64
	MemMiB     int
}

// ContainerInfo is the aggregated view of one container surfaced to the API.
type ContainerInfo struct {
	UserID           string
	State            string // creating/running/stopped/archived/unhealthy
	ImageTag         string
	CPUPercent       float64
	MemMiB           int
	ChannelConnected bool
	LastActiveAt     time.Time
}

// RuntimeDriver is the runtime-agnostic container control contract.
type RuntimeDriver interface {
	Create(ctx context.Context, spec UserSpec, gatewayToken string) error
	Start(ctx context.Context, userID string) error
	Stop(ctx context.Context, userID string) error
	Restart(ctx context.Context, userID string) error
	Remove(ctx context.Context, userID string, keepState bool) error
	List(ctx context.Context) ([]ContainerInfo, error)
	Stats(ctx context.Context, userID string) (Stats, error)
	// StatsAll samples CPU/MEM for all user containers in one call (collector).
	StatsAll(ctx context.Context) (map[string]Stats, error)
	Logs(ctx context.Context, userID string, tail int) (string, error)
	// Exec runs a command inside a user container (used to query the in-container
	// openclaw CLI for channel/session status — TASK-010).
	Exec(ctx context.Context, userID string, cmd ...string) (string, error)
	Reap(ctx context.Context, userID string) error
	Revive(ctx context.Context, userID string) error
}

// MergeLLM overlays per-user override on top of the global default. Any
// non-empty override field wins; empty fields inherit the global value.
func MergeLLM(global, override LlmConfig) LlmConfig {
	out := global
	if v := strings.TrimSpace(override.Provider); v != "" {
		out.Provider = v
	}
	if v := strings.TrimSpace(override.BaseURL); v != "" {
		out.BaseURL = v
	}
	if v := strings.TrimSpace(override.APIKey); v != "" {
		out.APIKey = v
	}
	if v := strings.TrimSpace(override.Model); v != "" {
		out.Model = v
	}
	return out
}

// BuildEnv renders the container environment contract consumed by the image's
// entrypoint / inject-env.mjs. Only non-empty values are emitted so the image
// baseline defaults stay in effect.
func BuildEnv(spec UserSpec, gatewayToken string) map[string]string {
	env := map[string]string{
		"PC_USER":      spec.UserID,
		"CHANNEL":      NormalizeChannel(spec.Channel),
		"WECOM_BOT_ID": spec.BotID,
		"WECOM_SECRET": spec.Secret,
	}
	putIf(env, "OPENCLAW_GATEWAY_TOKEN", gatewayToken)
	putIf(env, "LLM_PROVIDER", spec.LLM.Provider)
	putIf(env, "LLM_API_KEY", spec.LLM.APIKey)
	putIf(env, "LLM_BASE_URL", spec.LLM.BaseURL)
	putIf(env, "LLM_MODEL", spec.LLM.Model)
	return env
}

func putIf(m map[string]string, k, v string) {
	if strings.TrimSpace(v) != "" {
		m[k] = v
	}
}

// Channel values (message channels supported by the openclaw image).
const (
	ChannelWeCom   = "wecom"  // 企业微信
	ChannelWeChat  = "wechat" // 微信
	DefaultChannel = ChannelWeCom
)

// validChannels is the set of accepted channel identifiers.
var validChannels = map[string]bool{ChannelWeCom: true, ChannelWeChat: true}

// IsValidChannel reports whether c is a supported channel.
func IsValidChannel(c string) bool { return validChannels[c] }

// NormalizeChannel returns c when valid, otherwise the default channel (keeps
// legacy records without a channel working as 企业微信).
func NormalizeChannel(c string) string {
	c = strings.TrimSpace(c)
	if validChannels[c] {
		return c
	}
	return DefaultChannel
}

// ContainerName returns the deterministic container/host name for a user, used
// for in-network gateway access (muad-oc-<id>:18789, §3.2).
func ContainerName(userID string) string { return "muad-oc-" + userID }

// GatewayPort is the fixed in-container gateway port (uniform across all users;
// no host publishing, §3.2).
const GatewayPort = 18789

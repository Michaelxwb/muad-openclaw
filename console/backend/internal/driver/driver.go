// Package driver abstracts the container runtime (docker / k8s) behind a single
// contract so the rest of the console is runtime-agnostic (FEAT-07, §3.5).
package driver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

var (
	// ErrNotImplemented is returned by drivers that do not yet implement a method.
	ErrNotImplemented = errors.New("driver: not implemented")
	// ErrRuntimeNotReady indicates that the workload exists but cannot accept exec calls yet.
	ErrRuntimeNotReady = errors.New("driver: runtime not ready")
	// ErrWorkloadMissing indicates the runtime workload (e.g. k8s Deployment) does
	// not exist at all — the action caller may fall back to recreating it.
	ErrWorkloadMissing = errors.New("driver: workload missing")
)

// WorkloadBlockedChecker reports whether a workload can never become Ready
// (e.g. persistent ImagePullBackOff on an unusable image) rather than merely
// not-ready-yet. K8sDriver implements it so the upgrade health wait fails fast
// and rolls back instead of polling until the timeout.
type WorkloadBlockedChecker interface {
	WorkloadBlocked(ctx context.Context, podID string) (bool, error)
}

// Built-in resource defaults are defensive fallbacks only. Deployment defaults
// should come from config.yaml.
const (
	fallbackMemLimit      = "3g"
	fallbackCPULimit      = "2"
	fallbackRestartPolicy = "unless-stopped"
)

var validRestartPolicies = map[string]bool{
	"no": true, "on-failure": true, "always": true, "unless-stopped": true,
}

// IsValidRestartPolicy reports whether p is a supported docker restart policy.
func IsValidRestartPolicy(p string) bool { return validRestartPolicies[p] }

// Stats is a one-shot resource sample (no streaming, RULE-06).
//
// CPU 语义：
//   - CPUm: 绝对毫核数（1 核 = 1000m）。k8s 路径直接填；docker 路径把 `docker stats`
//     的每核百分比换算（100% = 占满 1 核 = 1000m，×10）填入，两条驱动都填。
//   - CPUPercent: 相对该 Pod limit 的百分比，由 collector 统一用 CPUm / limitMilli * 100
//     算出，保证两条路径"已使用/总量"语义一致；驱动层不填最终值（docker 的原始
//     每核百分比仅作为中间量保留在字段里，collector 优先用 CPUm 计算）。
type Stats struct {
	CPUm       int64
	CPUPercent float64
	MemMiB     int
}

// ContainerInfo is the aggregated view of one container surfaced to the API.
type ContainerInfo struct {
	PodID            string
	UserID           string
	State            string // creating/running/stopped/archived/unhealthy
	ImageTag         string
	CPUPercent       float64
	MemMiB           int
	ChannelConnected bool
	LastActiveAt     time.Time
}

// PublicSkillsStorageStatus describes the shared storage used by public Skills.
type PublicSkillsStorageStatus struct {
	Driver       string
	Name         string
	Namespace    string
	Configured   bool
	Ready        bool
	Phase        string
	AccessMode   string
	StorageClass string
	Size         string
	Message      string
}

// RuntimeOptions contains worker runtime paths and environment values that are
// deployment-specific but must stay consistent across Docker, K8s, and the DTO.
type RuntimeOptions struct {
	Timezone        string
	StateDir        string
	PublicSkillsDir string
}

func (options RuntimeOptions) withDefaults() RuntimeOptions {
	if strings.TrimSpace(options.Timezone) == "" {
		options.Timezone = "Asia/Shanghai"
	}
	if strings.TrimSpace(options.StateDir) == "" {
		options.StateDir = "/home/node/.openclaw"
	}
	if strings.TrimSpace(options.PublicSkillsDir) == "" {
		options.PublicSkillsDir = "/opt/openclaw-skills"
	}
	return options
}

// RuntimeDriver is the runtime-agnostic container control contract.
type RuntimeDriver interface {
	Create(ctx context.Context, spec PodSpec) error
	Start(ctx context.Context, podID string) error
	Stop(ctx context.Context, podID string) error
	Restart(ctx context.Context, podID string) error
	Remove(ctx context.Context, podID string, keepState bool) error
	List(ctx context.Context) ([]ContainerInfo, error)
	// StatsAll samples CPU/MEM for all user containers in one call (collector).
	StatsAll(ctx context.Context) (map[string]Stats, error)
	Logs(ctx context.Context, podID string, tail int) (string, error)
	// Exec runs a command inside a user container (used to query the in-container
	// openclaw CLI for channel/session status — TASK-010).
	Exec(ctx context.Context, podID string, cmd ...string) (string, error)
	// ExecStdin runs a command inside a container, piping stdin from the reader.
	// Used to inject configuration without exposing credentials in command-line args.
	ExecStdin(ctx context.Context, podID string, stdin io.Reader, cmd ...string) (string, error)
	Reap(ctx context.Context, podID string) error
	Revive(ctx context.Context, podID string) error
	// UpdateSpec pushes a new spec (channels, image, runtime config, etc.) to the runtime
	// so a future pod restart (crash, scale, manual) boots with up-to-date
	// configuration. Hot-reload changes (channels/plugins) don't need this for
	// the running pod, but the k8s Secret / docker container env needs to be
	// in sync with DB to survive restarts.
	UpdateSpec(ctx context.Context, podID string, spec PodSpec) error
	// UpdateServiceToken rotates only the fixed secret file/Secret resource.
	UpdateServiceToken(ctx context.Context, podID string, secret SecretFileSpec) error
	// SyncPublicSkillFiles publishes Console-managed public Skill files into
	// the shared runtime-visible storage.
	SyncPublicSkillFiles(ctx context.Context, sourceDir string) error
	// PublicSkillFilesSignature returns the signature published with the
	// currently runtime-visible public Skill files, or an empty string when absent.
	PublicSkillFilesSignature(ctx context.Context) (string, error)
	// EnsurePublicSkillsMount makes the shared public Skill storage visible to
	// one running runtime.
	EnsurePublicSkillsMount(ctx context.Context, podID string) error
	// SyncPublicSkills keeps the old combined operation for direct driver tests.
	SyncPublicSkills(ctx context.Context, podID, sourceDir string) error
	PublicSkillsStorageStatus(ctx context.Context) (PublicSkillsStorageStatus, error)
	EnsurePublicSkillsStorage(ctx context.Context) (PublicSkillsStorageStatus, error)
}

// BuildEnv renders the container environment contract consumed by the image's
// entrypoint / inject-env.mjs. Only non-empty values are emitted so the image
// baseline defaults stay in effect.
func BuildEnv(spec PodSpec) map[string]string {
	env := map[string]string{
		"MUAD_POD_ID": spec.PodID,
		"CHANNELS":    strings.Join(spec.Channels, ","),
	}
	// Multi-channel credentials via JSON env. inject-env.mjs parses this
	// and writes per-channel entries to openclaw.json's channels block.
	if len(spec.ChannelConfigs) > 0 {
		if b, err := json.Marshal(spec.ChannelConfigs); err == nil {
			putIf(env, "CHANNEL_CONFIGS", string(b))
		}
	}
	if spec.MultiUser.Version != 0 {
		if raw, err := json.Marshal(spec.MultiUser); err == nil {
			putIf(env, "MUAD_RUNTIME_CONFIG", string(raw))
		}
		putIf(env, "MUAD_CONSOLE_INTERNAL_URL", spec.MultiUser.ConsoleInternalURL)
	}
	putIf(env, "OPENCLAW_GATEWAY_TOKEN", spec.GatewayToken)
	putIf(env, "MUAD_AUTOMATION_URL", spec.AutomationPlatformURL)
	putIf(env, "MUAD_AUTH_TOKEN", spec.AutomationPlatformToken)
	return env
}

func putIf(m map[string]string, k, v string) {
	if strings.TrimSpace(v) != "" {
		m[k] = v
	}
}

// Channel values (message channels supported by the openclaw image).
const (
	ChannelWeCom      = "wecom"      // 企业微信
	ChannelWeChat     = "wechat"     // 微信
	ChannelMattermost = "mattermost" // Mattermost
	DefaultChannel    = ChannelWeCom
)

// OpenClaw channel IDs used in openclaw.json and CLI output.
const (
	OpenClawChannelWeCom      = "wecom"
	OpenClawChannelWeChat     = "openclaw-weixin"
	OpenClawChannelMattermost = "mattermost"
)

// Non-bundled plugin IDs installed in the worker image.
const (
	PluginWeCom      = "wecom-openclaw-plugin"
	PluginWeChat     = "openclaw-weixin"
	PluginMattermost = "mattermost"
)

// validChannels is the set of accepted channel identifiers.
var validChannels = map[string]bool{
	ChannelWeCom:      true,
	ChannelWeChat:     true,
	ChannelMattermost: true,
}

// IsValidChannel reports whether c is a supported channel.
func IsValidChannel(c string) bool { return validChannels[c] }

// pluginForChannel maps our external channel id (wecom/wechat) to the
// openclaw non-bundled plugin id that implements it. Used to set
// `plugins.allow` on hot-reload so removed channels actually unload.
var pluginForChannel = map[string]string{
	ChannelWeCom:      PluginWeCom,
	ChannelWeChat:     PluginWeChat,
	ChannelMattermost: PluginMattermost,
}

// OpenClawChannelFor maps muad's external channel id to openclaw's channel id.
func OpenClawChannelFor(channel string) string {
	switch channel {
	case ChannelWeCom:
		return OpenClawChannelWeCom
	case ChannelWeChat:
		return OpenClawChannelWeChat
	case ChannelMattermost:
		return OpenClawChannelMattermost
	default:
		return channel
	}
}

// PluginsAllowForChannels returns the explicit `plugins.allow` list for the
// given set of channels. Bundled plugins (e.g. browser/active) load
// automatically and must NOT be listed here. Order matches input.
func PluginsAllowForChannels(channels []string) []string {
	out := make([]string, 0, len(channels))
	seen := map[string]bool{}
	for _, c := range channels {
		if p, ok := pluginForChannel[c]; ok && !seen[p] {
			out = append(out, p)
			seen[p] = true
		}
	}
	return out
}

// PluginForChannelAll exposes the full channel→plugin mapping so callers
// (e.g. PUT /channels handler) can compute "all known non-bundled plugins
// and which channel enables them" — needed to flip `enabled:false` on
// removed channels' plugins so the gateway restart actually unloads them.
func PluginForChannelAll() map[string]string {
	out := make(map[string]string, len(pluginForChannel))
	for k, v := range pluginForChannel {
		out[k] = v
	}
	return out
}

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

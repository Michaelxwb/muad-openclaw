// Package gateway probes an openclaw container's application-layer status by
// running its own CLI (`openclaw channels status --json`) inside the container.
// Reusing openclaw's client avoids reimplementing the WS handshake in Go and
// isolates version-coupled field changes to this one place (TASK-010 / RISK-06).
//
// We use `channels status` (not the broader `openclaw status`): it returns
// per-channel connection + last-activity without requesting `system-presence`,
// which a token-auth connection lacks the `operator.read` scope for — the latter
// floods the gateway log with "missing scope: operator.read" every probe cycle.
package gateway

import (
	"context"
	"encoding/json"
	"time"
)

// Status is the application-layer snapshot for one container.
type Status struct {
	Healthy          bool            // probe responded and parsed
	ChannelConnected bool            // DEPRECATED: true if any channel connected
	ChannelStatuses  map[string]bool // per-channel connected state, e.g. {"wecom":true,"wechat":false}
	LastActiveAt     time.Time       // newest of inbound/outbound/start (display "最后活跃")
	// LastMessageAt is the newest real message time (inbound/outbound only),
	// excluding channel start. It drives the idle/reap countdown: ongoing
	// conversation keeps refreshing it, so an active container never goes idle.
	// Zero when the channel reports no message timestamps (e.g. wecom only
	// exposes lastStartAt) — callers must not treat zero as "idle/reapable".
	LastMessageAt       time.Time
	RuntimeGuardHealthy bool
	RuntimeGeneration   int64
	SkillActive         int
	SkillQueued         int
	BrowserActive       int
	BrowserQueued       int
}

// Execer runs a command inside a Pod (satisfied by each RuntimeDriver).
type Execer interface {
	Exec(ctx context.Context, podID string, cmd ...string) (string, error)
}

// Probe queries one container. A failed exec or unparseable output yields an
// unhealthy status (the caller treats that as the container's health signal).
func Probe(ctx context.Context, ex Execer, podID string) Status {
	out, err := ex.Exec(ctx, podID, "openclaw", "channels", "status", "--json")
	if err != nil {
		return Status{Healthy: false}
	}
	st, err := ParseStatus([]byte(out))
	if err != nil {
		return Status{Healthy: false}
	}
	mergeRuntimeHealth(ctx, ex, podID, &st)
	return st
}

type runtimeHealthJSON struct {
	OK         bool  `json:"ok"`
	Generation int64 `json:"generation"`
	Skill      struct {
		Active int `json:"active"`
		Queued int `json:"queued"`
	} `json:"skill"`
	Browser struct {
		Active int `json:"active"`
		Queued int `json:"queued"`
	} `json:"browser"`
}

func mergeRuntimeHealth(ctx context.Context, ex Execer, podID string, status *Status) {
	out, err := ex.Exec(ctx, podID, "openclaw", "gateway", "call", "muad.runtime.health", "--json")
	if err != nil {
		return
	}
	var health runtimeHealthJSON
	if err := json.Unmarshal([]byte(out), &health); err != nil {
		return
	}
	status.RuntimeGuardHealthy = health.OK
	status.RuntimeGeneration = health.Generation
	status.SkillActive = health.Skill.Active
	status.SkillQueued = health.Skill.Queued
	status.BrowserActive = health.Browser.Active
	status.BrowserQueued = health.Browser.Queued
}

// channelStatusJSON mirrors the relevant parts of `openclaw channels status --json`.
// The per-channel shape varies by plugin: the wecom long-connection bot reports
// running/lastStartAt; the wechat (openclaw-weixin) plugin reports
// lastInboundAt/lastOutboundAt. We read all so both channels surface connection
// and last-activity.
type channelStatusJSON struct {
	Channels map[string]struct {
		Configured     bool   `json:"configured"`
		Running        bool   `json:"running"`
		LastInboundAt  *int64 `json:"lastInboundAt"`
		LastOutboundAt *int64 `json:"lastOutboundAt"`
		LastStartAt    *int64 `json:"lastStartAt"`
	} `json:"channels"`
	ChannelAccounts map[string][]json.RawMessage `json:"channelAccounts"`
}

// ParseStatus extracts health, channel connection, and last-activity from the
// `openclaw channels status --json` output. A container runs exactly one
// channel; "connected" means the channel is running, has a linked account, or
// has configured creds. Last-activity is the newest of inbound/outbound message
// time (wechat) or channel start time (wecom).
func ParseStatus(raw []byte) (Status, error) {
	var s channelStatusJSON
	if err := json.Unmarshal(raw, &s); err != nil {
		return Status{}, err
	}
	st := Status{Healthy: true}

	var maxMs, maxMsgMs int64 // maxMs: any activity incl. start; maxMsgMs: messages only
	for id, c := range s.Channels {
		if c.Running || c.Configured || len(s.ChannelAccounts[id]) > 0 {
			st.ChannelConnected = true
			if st.ChannelStatuses == nil {
				st.ChannelStatuses = map[string]bool{}
			}
			st.ChannelStatuses[id] = true
		}
		for _, t := range []*int64{c.LastInboundAt, c.LastOutboundAt} {
			if t != nil {
				if *t > maxMsgMs {
					maxMsgMs = *t
				}
				if *t > maxMs {
					maxMs = *t
				}
			}
		}
		if c.LastStartAt != nil && *c.LastStartAt > maxMs {
			maxMs = *c.LastStartAt
		}
	}
	if maxMs > 0 {
		st.LastActiveAt = time.UnixMilli(maxMs)
	}
	if maxMsgMs > 0 {
		st.LastMessageAt = time.UnixMilli(maxMsgMs)
	}
	return st, nil
}

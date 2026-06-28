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
	Healthy          bool      // probe responded and parsed
	ChannelConnected bool      // the message channel has a linked account
	LastActiveAt     time.Time // newest inbound/outbound message time
}

// Execer runs a command inside a user's container (satisfied by DockerDriver).
type Execer interface {
	Exec(ctx context.Context, userID string, cmd ...string) (string, error)
}

// Probe queries one container. A failed exec or unparseable output yields an
// unhealthy status (the caller treats that as the container's health signal).
func Probe(ctx context.Context, ex Execer, userID string) Status {
	out, err := ex.Exec(ctx, userID, "openclaw", "channels", "status", "--json")
	if err != nil {
		return Status{Healthy: false}
	}
	st, err := ParseStatus([]byte(out))
	if err != nil {
		return Status{Healthy: false}
	}
	return st
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

	var maxMs int64
	for id, c := range s.Channels {
		if c.Running || c.Configured || len(s.ChannelAccounts[id]) > 0 {
			st.ChannelConnected = true
		}
		for _, t := range []*int64{c.LastInboundAt, c.LastOutboundAt, c.LastStartAt} {
			if t != nil && *t > maxMs {
				maxMs = *t
			}
		}
	}
	if maxMs > 0 {
		st.LastActiveAt = time.UnixMilli(maxMs)
	}
	return st, nil
}

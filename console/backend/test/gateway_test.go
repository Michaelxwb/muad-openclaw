package test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

func TestParseStatus_ConnectedWithAccountAndActivity(t *testing.T) {
	raw := []byte(`{
		"channels": {"openclaw-weixin": {"configured": true, "lastInboundAt": 1782557845792, "lastOutboundAt": 1782557888921}},
		"channelAccounts": {"openclaw-weixin": [{"accountId": "wx-bot"}]},
		"channelDefaultAccountId": {"openclaw-weixin": "wx-bot"}
	}`)
	st, err := gateway.ParseStatus(raw)
	if err != nil {
		t.Fatalf("ParseStatus: %v", err)
	}
	if !st.Healthy {
		t.Error("expected healthy")
	}
	if !st.ChannelConnected {
		t.Error("expected connected (account present)")
	}
	if st.ChannelDefaultAccountIDs["openclaw-weixin"] != "wx-bot" {
		t.Errorf("default account = %q, want wx-bot", st.ChannelDefaultAccountIDs["openclaw-weixin"])
	}
	want := time.UnixMilli(1782557888921) // newest of inbound/outbound
	if !st.LastActiveAt.Equal(want) {
		t.Errorf("LastActiveAt = %v, want %v", st.LastActiveAt, want)
	}
	// real message activity drives the reap countdown
	if !st.LastMessageAt.Equal(want) {
		t.Errorf("LastMessageAt = %v, want %v", st.LastMessageAt, want)
	}
}

func TestParseStatus_WecomRunningWithStartTime(t *testing.T) {
	// wecom long-connection: running + lastStartAt (no inbound/outbound).
	raw := []byte(`{"channels": {"wecom": {"configured": true, "running": true, "lastStartAt": 1782557800000}}, "channelAccounts": {"wecom": []}}`)
	st, err := gateway.ParseStatus(raw)
	if err != nil {
		t.Fatalf("ParseStatus: %v", err)
	}
	if !st.ChannelConnected {
		t.Error("running wecom channel should be connected")
	}
	want := time.UnixMilli(1782557800000)
	if !st.LastActiveAt.Equal(want) {
		t.Errorf("LastActiveAt = %v, want %v (lastStartAt)", st.LastActiveAt, want)
	}
	// wecom has no message timestamps → no message activity → not reapable
	if !st.LastMessageAt.IsZero() {
		t.Errorf("LastMessageAt = %v, want zero (wecom reports no inbound/outbound)", st.LastMessageAt)
	}
}

func TestParseStatus_Disconnected(t *testing.T) {
	raw := []byte(`{"channels": {"openclaw-weixin": {"configured": false, "lastInboundAt": null, "lastOutboundAt": null}}, "channelAccounts": {"openclaw-weixin": []}}`)
	st, err := gateway.ParseStatus(raw)
	if err != nil {
		t.Fatalf("ParseStatus: %v", err)
	}
	if st.ChannelConnected {
		t.Error("no account + not configured → disconnected")
	}
}

func TestParseStatus_Malformed(t *testing.T) {
	if _, err := gateway.ParseStatus([]byte(`not json`)); err == nil {
		t.Error("expected error on malformed json")
	}
}

func TestProbeWithConfigRevisionReportsAppliedState(t *testing.T) {
	execer := probeExecer{
		configGet: `{"configRevisionHash":"rev-2","appliedConfigHash":"rev-2"}`,
	}
	status := gateway.ProbeWithConfigRevision(context.Background(), &execer, "pod-a")
	if !status.Healthy || !status.RuntimeGuardHealthy || !status.ConfigApplied {
		t.Fatalf("status = %+v", status)
	}
	if status.ConfigRevisionHash != "rev-2" || status.AppliedConfigHash != "rev-2" {
		t.Fatalf("revision fields = %+v", status)
	}

	execer.configGet = `{"configRevisionHash":"rev-2","appliedConfigHash":"rev-1"}`
	status = gateway.ProbeWithConfigRevision(context.Background(), &execer, "pod-a")
	if status.ConfigApplied {
		t.Fatalf("stale applied revision reported as applied: %+v", status)
	}
}

func TestProbeWithConfigRevisionFallsBackToRuntimeGeneration(t *testing.T) {
	execer := probeExecer{
		configGet: `{"hash":"sha256:cfg","runtimeConfig":{"plugins":{"entries":{"muad-runtime-guard":{"config":{"generation":7}}}}}}`,
	}
	status := gateway.ProbeWithConfigRevision(context.Background(), &execer, "pod-a")
	if !status.ConfigApplied || status.ConfigGeneration != 7 || status.ConfigRevisionHash != "sha256:cfg" {
		t.Fatalf("status = %+v", status)
	}

	execer.configGet = `{"hash":"sha256:stale","runtimeConfig":{"plugins":{"entries":{"muad-runtime-guard":{"config":{"generation":6}}}}}}`
	status = gateway.ProbeWithConfigRevision(context.Background(), &execer, "pod-a")
	if status.ConfigApplied {
		t.Fatalf("stale generation reported as applied: %+v", status)
	}
}

func TestVerifyRoutesCallsRuntimeGuardVerifier(t *testing.T) {
	execer := &probeExecer{
		routeVerify: `{"ok":true,"generation":8,"checked":2,"failed":0}`,
	}
	result, err := gateway.VerifyRoutes(context.Background(), execer, "pod-a", 8, []gateway.RouteExpectation{
		{AgentID: "alice", Channel: "mattermost", AccountID: "default", PeerKind: "direct", ExternalID: "mm-user-1"},
		{AgentID: "bob", Channel: "wecom", AccountID: "default", PeerKind: "dm", ExternalID: "wx-user-2"},
	})
	if err != nil {
		t.Fatalf("VerifyRoutes: %v", err)
	}
	if !result.OK || result.Generation != 8 || result.Checked != 2 || result.Failed != 0 {
		t.Fatalf("result = %+v", result)
	}
	var payload struct {
		Generation int64                      `json:"generation"`
		Routes     []gateway.RouteExpectation `json:"routes"`
	}
	if err := json.Unmarshal([]byte(execer.lastParams), &payload); err != nil {
		t.Fatalf("params JSON: %v", err)
	}
	if payload.Generation != 8 || len(payload.Routes) != 2 || payload.Routes[0].AgentID != "alice" {
		t.Fatalf("payload = %+v", payload)
	}
}

type probeExecer struct {
	configGet   string
	routeVerify string
	lastParams  string
}

func (execer *probeExecer) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	joined := strings.Join(cmd, " ")
	switch {
	case strings.Contains(joined, "muad.runtime.health"):
		return `{"ok":true,"generation":7}`, nil
	case strings.Contains(joined, "muad.runtime.verify-routes"):
		execer.lastParams = commandParam(cmd, "--params")
		return execer.routeVerify, nil
	case strings.Contains(joined, "config.get"):
		return execer.configGet, nil
	default:
		return `{"channels":{"wecom":{"configured":true,"running":true}}}`, nil
	}
}

func commandParam(cmd []string, name string) string {
	for index, value := range cmd {
		if value == name && index+1 < len(cmd) {
			return cmd[index+1]
		}
	}
	return ""
}

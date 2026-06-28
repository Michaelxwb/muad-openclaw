package test

import (
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

func TestParseStatus_ConnectedWithAccountAndActivity(t *testing.T) {
	raw := []byte(`{
		"channels": {"openclaw-weixin": {"configured": true, "lastInboundAt": 1782557845792, "lastOutboundAt": 1782557888921}},
		"channelAccounts": {"openclaw-weixin": [{"id": "x"}]}
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

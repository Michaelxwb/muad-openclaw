package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// SessionCancel S-04/E-05 [integration] 真实边界：真实 gateway 适配器 + fake Exec；
// argv/JSON 安全传递、context deadline、Worker 包络与稳定错误映射。

type recordingSessionExecer struct {
	calls       [][]string
	out         string
	err         error
	block       bool
	hasDeadline bool
	deadline    time.Time
}

func (ex *recordingSessionExecer) Exec(ctx context.Context, _ string, cmd ...string) (string, error) {
	ex.calls = append(ex.calls, append([]string(nil), cmd...))
	ex.deadline, ex.hasDeadline = ctx.Deadline()
	if ex.block {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return ex.out, ex.err
}

func TestSessionCancelE05PreviewUsesBoundedExecAndParsesResult(t *testing.T) {
	ex := &recordingSessionExecer{out: `{"ok":true,"sessionKey":"agent:john-24c84418:wecom:direct:john-24c84418","agentId":"john-24c84418","activeRun":{"active":true,"sessionId":"run-1"},"processes":[{"pid":4028,"pgid":4028,"startTime":1234567,"uid":1000,"leader":true,"ageSeconds":131,"cmdline":"sh -c run.py","fingerprint":"9f2c1a7b3d4e5f60"}],"skipped":{"notOwner":0,"envMismatch":3,"permissionDenied":0}}`}

	result, err := PreviewSessionCancel(context.Background(), ex, "pod-a", "agent:john-24c84418:wecom:direct:john-24c84418", "admin-1")
	if err != nil {
		t.Fatalf("PreviewSessionCancel: %v", err)
	}
	if result.SessionKey != "agent:john-24c84418:wecom:direct:john-24c84418" || result.AgentID != "john-24c84418" {
		t.Fatalf("preview identity = %+v", result)
	}
	if !result.ActiveRun.Active || result.ActiveRun.SessionID != "run-1" {
		t.Fatalf("active run = %+v", result.ActiveRun)
	}
	if len(result.Processes) != 1 {
		t.Fatalf("processes = %+v", result.Processes)
	}
	process := result.Processes[0]
	if process.PID != 4028 || process.PGID != 4028 || process.StartTime != 1234567 ||
		process.UID != 1000 || !process.Leader || process.AgeSeconds != 131 ||
		process.Fingerprint != "9f2c1a7b3d4e5f60" {
		t.Fatalf("process = %+v", process)
	}
	if result.Skipped.EnvMismatch != 3 {
		t.Fatalf("skipped = %+v", result.Skipped)
	}
	want := []string{
		"openclaw", "gateway", "call", "muad.session.preview",
		"--params", `{"sessionKey":"agent:john-24c84418:wecom:direct:john-24c84418","requestedBy":"admin-1"}`, "--json",
	}
	if !reflect.DeepEqual(ex.calls[0], want) {
		t.Fatalf("exec argv = %#v, want %#v", ex.calls[0], want)
	}
	if !ex.hasDeadline {
		t.Fatalf("preview call must run under a bounded context deadline")
	}
	if remaining := time.Until(ex.deadline); remaining > 10*time.Second || remaining < 9*time.Second {
		t.Fatalf("preview deadline = %v, want ~10s", remaining)
	}
}

func TestSessionCancelE05CancelUsesBoundedExecAndParsesResult(t *testing.T) {
	ex := &recordingSessionExecer{out: `{"ok":true,"aborted":true,"drained":true,"confirmed":true,"killed":1,"remaining":[],"processes":[{"pid":4028,"outcome":"killed","reason":""}]}`}

	expected := []SessionCancelExpected{{PID: 4028, Fingerprint: "9f2c1a7b3d4e5f60"}}
	result, err := CancelSessionCancel(context.Background(), ex, "pod-a", "agent:john:wecom:direct:john", "admin-1", expected)
	if err != nil {
		t.Fatalf("CancelSessionCancel: %v", err)
	}
	if !result.Aborted || !result.Drained || !result.Confirmed || result.Killed != 1 {
		t.Fatalf("cancel result = %+v", result)
	}
	if len(result.Processes) != 1 || result.Processes[0].PID != 4028 || result.Processes[0].Outcome != "killed" {
		t.Fatalf("cancel processes = %+v", result.Processes)
	}
	want := []string{
		"openclaw", "gateway", "call", "muad.session.cancel",
		"--params", `{"sessionKey":"agent:john:wecom:direct:john","requestedBy":"admin-1","expected":[{"pid":4028,"fingerprint":"9f2c1a7b3d4e5f60"}]}`, "--json",
	}
	if !reflect.DeepEqual(ex.calls[0], want) {
		t.Fatalf("exec argv = %#v, want %#v", ex.calls[0], want)
	}
	if !ex.hasDeadline {
		t.Fatalf("cancel call must run under a bounded context deadline")
	}
	if remaining := time.Until(ex.deadline); remaining > 20*time.Second || remaining < 19*time.Second {
		t.Fatalf("cancel deadline = %v, want ~20s", remaining)
	}
}

func TestSessionCancelAllowsEmptyExpectedToAbortOnly(t *testing.T) {
	ex := &recordingSessionExecer{out: `{"ok":true,"aborted":true,"drained":true,"confirmed":true,"killed":0,"remaining":[],"processes":[]}`}
	result, err := CancelSessionCancel(context.Background(), ex, "pod-a", "agent:john:wecom:direct:john", "admin-1", nil)
	if err != nil {
		t.Fatalf("empty expected must be accepted: %v", err)
	}
	if !result.Aborted || !result.Drained || result.Killed != 0 {
		t.Fatalf("empty expected result = %+v, want abort-only", result)
	}
	if len(ex.calls) != 1 {
		t.Fatalf("expected one cancel RPC, got %#v", ex.calls)
	}
	joined := strings.Join(ex.calls[0], " ")
	if !strings.Contains(joined, `"expected":[]`) {
		t.Fatalf("empty expected must be forwarded, call = %s", joined)
	}
}

func TestSessionCancelE05MapsTransportAndPayloadFailures(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		execErr error
		wantErr error
	}{
		{name: "malformed JSON", out: `{not json`, wantErr: ErrSessionCancelFailed},
		{name: "transport failure", execErr: errors.New("exec failed: connection refused"), wantErr: ErrSessionCancelFailed},
		{name: "unknown method on legacy runtime", execErr: errors.New("Error: unknown method: muad.session.preview"), wantErr: ErrSessionCancelUnsupported},
		{name: "worker not found", out: `{"ok":false,"reason":"not_found"}`, wantErr: ErrSessionCancelNotFound},
		{name: "worker unsupported", out: `{"ok":false,"reason":"cancel_unavailable"}`, wantErr: ErrSessionCancelUnsupported},
		{name: "worker handler error", out: `{"ok":false,"reason":"handler_error"}`, wantErr: ErrSessionCancelFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ex := &recordingSessionExecer{out: tc.out, err: tc.execErr}
			_, err := PreviewSessionCancel(context.Background(), ex, "pod-a", "agent:john:wecom:direct:john", "admin-1")
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error = %v, want wrapped %v", err, tc.wantErr)
			}
			if tc.execErr != nil && !errors.Is(err, tc.execErr) {
				t.Fatalf("original error chain must be preserved: %v", err)
			}
		})
	}
}

func TestSessionCancelE05RPCDeadlineIsInterruptible(t *testing.T) {
	ex := &recordingSessionExecer{block: true}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := PreviewSessionCancel(ctx, ex, "pod-a", "agent:john:wecom:direct:john", "admin-1")
	if time.Since(start) > 2*time.Second {
		t.Fatalf("preview was not interrupted by the deadline")
	}
	if !errors.Is(err, ErrSessionCancelFailed) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want ErrSessionCancelFailed wrapping DeadlineExceeded", err)
	}
	if !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("diagnostic should carry the deadline cause: %v", err)
	}
}

func TestSessionCancelE05AcceptsNestedDataEnvelope(t *testing.T) {
	ex := &recordingSessionExecer{out: `{"ok":true,"data":{"sessionKey":"agent:john:wecom:direct:john","agentId":"john","activeRun":{"active":false},"processes":[],"skipped":{"notOwner":1,"envMismatch":0,"permissionDenied":0}}}`}
	result, err := PreviewSessionCancel(context.Background(), ex, "pod-a", "agent:john:wecom:direct:john", "admin-1")
	if err != nil {
		t.Fatalf("PreviewSessionCancel: %v", err)
	}
	if result.AgentID != "john" || result.Skipped.NotOwner != 1 || result.ActiveRun.Active {
		t.Fatalf("nested data result = %+v", result)
	}
}

func TestSessionCancelS04CapabilityCacheKeepsBothCapabilities(t *testing.T) {
	cache := NewCancelCapabilityCache(50 * time.Millisecond)
	now := time.Now()
	cache.now = func() time.Time { return now }

	if _, ok := cache.Lookup("pod-a"); ok {
		t.Fatalf("unknown Pod must be conservatively unknown")
	}
	cache.Update("pod-a", CancelCapability{
		LongTask:      LongTaskCancelCapability{Available: true, Version: 3},
		SessionCancel: SessionCancelCapability{Available: true, Version: 1},
	})
	capability, ok := cache.Lookup("pod-a")
	if !ok {
		t.Fatalf("expected cached capability")
	}
	if !capability.LongTask.Available || capability.LongTask.Version != 3 {
		t.Fatalf("long task capability regression = %+v", capability.LongTask)
	}
	if !capability.SessionCancel.Available || capability.SessionCancel.Version != 1 {
		t.Fatalf("session cancel capability = %+v", capability.SessionCancel)
	}

	// 已知不支持同样是一个确定结论，而不是未知。
	cache.Update("pod-b", CancelCapability{SessionCancel: SessionCancelCapability{Available: false, Version: 0}})
	if capability, ok := cache.Lookup("pod-b"); !ok || capability.SessionCancel.Available {
		t.Fatalf("known-unsupported Pod = %+v ok=%v", capability, ok)
	}

	// 过期后保守回到未知，两个能力一起失效。
	now = now.Add(60 * time.Millisecond)
	if _, ok := cache.Lookup("pod-a"); ok {
		t.Fatalf("expired capability must be treated as unknown")
	}
}

func TestSessionCancelS04ProbeParsesHealthCapability(t *testing.T) {
	ex := probeExecerWithDefaults(map[string]string{
		"openclaw gateway call muad.runtime.health --json": `{"ok":true,"generation":7,"skill":{"active":0,"queued":0},"browser":{"active":0,"queued":0},"sessionCancel":{"available":true,"version":1}}`,
	}, nil)
	status := Probe(context.Background(), ex, "pod-a")
	if !status.Healthy {
		t.Fatalf("probe must be healthy: %+v", status)
	}
	if !status.SessionCancelAvailable || status.SessionCancelVersion != 1 {
		t.Fatalf("session cancel status = %+v, want available version 1", status)
	}
}

func TestSessionCancelS04HealthCapabilityPayloadIsPreserved(t *testing.T) {
	// 显式确保 preview/cancel 参数中的恶意字符保持为单个 JSON argv，不拼接 Shell。
	ex := &recordingSessionExecer{out: `{"ok":true,"aborted":true,"drained":true,"confirmed":true,"killed":0,"remaining":[],"processes":[]}`}
	_, err := CancelSessionCancel(context.Background(), ex, "pod-a", `agent:x:wecom:direct:x"; touch /tmp/pwned; "`, `op$(whoami)`, []SessionCancelExpected{{PID: 42, Fingerprint: `fp"; rm -rf /`}})
	if err != nil {
		t.Fatalf("CancelSessionCancel hostile input: %v", err)
	}
	if len(ex.calls[0]) != 7 {
		t.Fatalf("hostile input changed argv length: %#v", ex.calls[0])
	}
	var payload struct {
		SessionKey  string `json:"sessionKey"`
		RequestedBy string `json:"requestedBy"`
		Expected    []struct {
			PID         int    `json:"pid"`
			Fingerprint string `json:"fingerprint"`
		} `json:"expected"`
	}
	if err := json.Unmarshal([]byte(ex.calls[0][5]), &payload); err != nil {
		t.Fatalf("params is not JSON: %v", err)
	}
	if payload.SessionKey != `agent:x:wecom:direct:x"; touch /tmp/pwned; "` ||
		payload.RequestedBy != `op$(whoami)` ||
		len(payload.Expected) != 1 || payload.Expected[0].PID != 42 ||
		payload.Expected[0].Fingerprint != `fp"; rm -rf /` {
		t.Fatalf("payload not preserved exactly: %+v", payload)
	}
}

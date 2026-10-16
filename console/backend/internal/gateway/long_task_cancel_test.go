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

// LongTaskControlS22 [integration] 真实边界：真实 Go Gateway 适配器与 fake Driver；
// argv/JSON 安全传递、context 超时可中断、worker 包络校验与错误分类。

type recordingCancelExecer struct {
	calls       [][]string
	out         string
	err         error
	block       bool
	hasDeadline bool
}

func (ex *recordingCancelExecer) Exec(ctx context.Context, _ string, cmd ...string) (string, error) {
	ex.calls = append(ex.calls, append([]string(nil), cmd...))
	_, ex.hasDeadline = ctx.Deadline()
	if ex.block {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return ex.out, ex.err
}

func TestLongTaskControlS22CancelUsesSingleArgvJSONAndBoundedContext(t *testing.T) {
	ex := &recordingCancelExecer{
		out: `{"ok":true,"outcome":"cancel_requested","status":"cancelling","stateRevision":3}`,
	}
	result, err := CancelLongTask(context.Background(), ex, "pod-a", "task-1", "admin-1")
	if err != nil {
		t.Fatalf("CancelLongTask: %v", err)
	}
	if result.Outcome != "cancel_requested" || result.Status != "cancelling" || result.StateRevision != 3 || result.AlreadyTerminal {
		t.Fatalf("cancel result = %+v", result)
	}
	want := []string{
		"openclaw", "gateway", "call", "muad.long-task.cancel",
		"--params", `{"taskId":"task-1","requestedBy":"admin-1"}`, "--json",
	}
	if !reflect.DeepEqual(ex.calls[0], want) {
		t.Fatalf("exec argv = %#v, want %#v", ex.calls[0], want)
	}
	if !ex.hasDeadline {
		t.Fatalf("cancel call must run under a bounded context deadline")
	}

	// 含引号/替换字符的输入保持在单个 argv 内且 JSON 可精确还原，不构成额外参数。
	ex2 := &recordingCancelExecer{out: `{"ok":true,"outcome":"cancelled","status":"cancelled","stateRevision":2}`}
	if _, err := CancelLongTask(context.Background(), ex2, "pod-a", `x"; touch /tmp/pwned; "`, `op$(whoami)`); err != nil {
		t.Fatalf("CancelLongTask hostile input: %v", err)
	}
	if len(ex2.calls[0]) != 7 {
		t.Fatalf("hostile input changed argv length: %#v", ex2.calls[0])
	}
	var payload struct {
		TaskID      string `json:"taskId"`
		RequestedBy string `json:"requestedBy"`
	}
	if err := json.Unmarshal([]byte(ex2.calls[0][5]), &payload); err != nil {
		t.Fatalf("params is not JSON: %v", err)
	}
	if payload.TaskID != `x"; touch /tmp/pwned; "` || payload.RequestedBy != `op$(whoami)` {
		t.Fatalf("payload not preserved exactly: %+v", payload)
	}
}

func TestLongTaskControlS22MapsWorkerEnvelopesDistinctly(t *testing.T) {
	notFound := errors.New("exec failed: connection refused")
	cases := []struct {
		name    string
		out     string
		execErr error
		wantErr error
		want    LongTaskCancelResult
	}{
		{
			name: "accepted", out: `{"ok":true,"outcome":"cancel_requested","status":"cancelling","stateRevision":2}`,
			want: LongTaskCancelResult{Outcome: "cancel_requested", Status: "cancelling", StateRevision: 2},
		},
		{
			name: "cancelled", out: `{"ok":true,"outcome":"cancelled","status":"cancelled","stateRevision":4}`,
			want: LongTaskCancelResult{Outcome: "cancelled", Status: "cancelled", StateRevision: 4},
		},
		{
			name: "already terminal", out: `{"ok":false,"reason":"already_terminal","status":"succeeded","stateRevision":5}`,
			want: LongTaskCancelResult{Status: "succeeded", StateRevision: 5, AlreadyTerminal: true},
		},
		{
			name: "identity unknown", out: `{"ok":false,"reason":"not_found"}`,
			wantErr: ErrLongTaskCancelNotFound,
		},
		{
			name: "old worker", out: `{"ok":false,"reason":"cancel_unavailable"}`,
			wantErr: ErrLongTaskCancelUnsupported,
		},
		{
			name: "state write failed", out: `{"ok":false,"reason":"state_unavailable"}`,
			wantErr: ErrLongTaskCancelStateFailed,
		},
		{
			name: "invalid request", out: `{"ok":false,"reason":"invalid_request"}`,
			wantErr: ErrLongTaskCancelRejected,
		},
		{
			name: "malformed envelope", out: `{not json`,
			wantErr: ErrLongTaskCancelRPC,
		},
		{
			name: "transport failure", execErr: notFound,
			wantErr: ErrLongTaskCancelRPC,
		},
		{
			name: "unknown method on legacy runtime", execErr: errors.New("Error: unknown method: muad.long-task.cancel"),
			wantErr: ErrLongTaskCancelUnsupported,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ex := &recordingCancelExecer{out: tc.out, err: tc.execErr}
			result, err := CancelLongTask(context.Background(), ex, "pod-a", "task-9", "admin-1")
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("error = %v, want wrapped %v", err, tc.wantErr)
				}
				if tc.execErr != nil && errors.Is(err, tc.execErr) == false {
					t.Fatalf("original error chain must be preserved: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result != tc.want {
				t.Fatalf("result = %+v, want %+v", result, tc.want)
			}
		})
	}
}

func TestLongTaskControlS22CancelIsInterruptibleByCallerDeadline(t *testing.T) {
	ex := &recordingCancelExecer{block: true}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := CancelLongTask(ctx, ex, "pod-a", "task-1", "admin-1")
	if time.Since(start) > 2*time.Second {
		t.Fatalf("cancel was not interrupted by the deadline")
	}
	if !errors.Is(err, ErrLongTaskCancelRPC) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want ErrLongTaskCancelRPC wrapping DeadlineExceeded", err)
	}
	if !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("diagnostic should carry the deadline cause: %v", err)
	}
}

func TestLongTaskControlS22CapabilityCacheStaysConservative(t *testing.T) {
	cache := NewLongTaskCapabilityCache(50 * time.Millisecond)
	now := time.Now()
	cache.now = func() time.Time { return now }

	if _, ok := cache.Lookup("pod-a"); ok {
		t.Fatalf("unknown Pod must be conservatively not cancellable")
	}
	cache.Update("pod-a", LongTaskCancelCapability{Available: true, Version: 1})
	capability, ok := cache.Lookup("pod-a")
	if !ok || !capability.Available || capability.Version != 1 {
		t.Fatalf("expected cached available capability, got %+v ok=%v", capability, ok)
	}
	// 已知不支持同样是一个确定结论（可用但不可取消），而不是未知。
	cache.Update("pod-b", LongTaskCancelCapability{Available: false, Version: 0})
	if capability, ok := cache.Lookup("pod-b"); !ok || capability.Available {
		t.Fatalf("known-unsupported Pod = %+v ok=%v", capability, ok)
	}
	// 过期后保守回到未知。
	now = now.Add(60 * time.Millisecond)
	if _, ok := cache.Lookup("pod-a"); ok {
		t.Fatalf("expired capability must be treated as unknown")
	}
	cache.Update("pod-c", LongTaskCancelCapability{Available: true, Version: 1})
	cache.Invalidate("pod-c")
	if _, ok := cache.Lookup("pod-c"); ok {
		t.Fatalf("invalidated capability must be treated as unknown")
	}
}

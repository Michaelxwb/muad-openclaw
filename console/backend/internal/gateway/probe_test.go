package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeProbeExecer struct {
	out string
	err error
}

func (ex *fakeProbeExecer) Exec(_ context.Context, _ string, _ ...string) (string, error) {
	return ex.out, ex.err
}

var probeRoutes = []RouteExpectation{{
	AgentID: "alice", Channel: "mattermost", AccountID: "default",
	PeerKind: "direct", ExternalID: "mm-user-1",
}}

func TestVerifyRoutes_MapsRPCFailureToUnknownError(t *testing.T) {
	ex := &fakeProbeExecer{err: errors.New("exec failed: connection refused")}
	_, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, probeRoutes)
	if !errors.Is(err, ErrRouteVerificationRPC) {
		t.Fatalf("VerifyRoutes RPC failure error = %v, want ErrRouteVerificationRPC", err)
	}
}

func TestVerifyRoutes_MapsUnparseableResponseToUnknownError(t *testing.T) {
	ex := &fakeProbeExecer{out: "not-json"}
	_, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, probeRoutes)
	if !errors.Is(err, ErrRouteVerificationRPC) {
		t.Fatalf("VerifyRoutes decode failure error = %v, want ErrRouteVerificationRPC", err)
	}
}

func TestVerifyRoutes_DeterministicFailureIsNotAnError(t *testing.T) {
	ex := &fakeProbeExecer{out: `{"ok":false,"generation":7,"checked":1,"failed":1,"error":"agent_mismatch"}`}
	result, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, probeRoutes)
	if err != nil {
		t.Fatalf("deterministic verification failure must not be an error, got %v", err)
	}
	if result.OK || result.Failed != 1 || !strings.Contains(result.Error, "agent_mismatch") {
		t.Fatalf("verification result = %+v, want OK=false with one failure", result)
	}
}

func TestVerifyRoutes_EmptyRoutesAreImmediatelyOK(t *testing.T) {
	ex := &fakeProbeExecer{err: errors.New("must not be called")}
	result, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, nil)
	if err != nil || !result.OK || result.Generation != 7 {
		t.Fatalf("empty routes result = %+v, %v; want OK with matching generation", result, err)
	}
}

// verifyRoutesRecorder 记录每个 verify-routes RPC 的批大小，并可让指定批次失败。
type verifyRoutesRecorder struct {
	mu          sync.Mutex
	batchSizes  []int
	failBatch   int
	failureMode string // "rpc" | "deterministic"
}

func (ex *verifyRoutesRecorder) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	params := ""
	for i, item := range cmd {
		if item == "--params" && i+1 < len(cmd) {
			params = cmd[i+1]
		}
	}
	var payload struct {
		Generation int64             `json:"generation"`
		Routes     []RouteExpectation `json:"routes"`
	}
	if err := json.Unmarshal([]byte(params), &payload); err != nil {
		return "", err
	}
	ex.mu.Lock()
	ex.batchSizes = append(ex.batchSizes, len(payload.Routes))
	batch := len(ex.batchSizes)
	fail := ex.failBatch == batch
	mode := ex.failureMode
	ex.mu.Unlock()
	if fail && mode == "rpc" {
		return "", errors.New("exec failed: connection refused")
	}
	if fail && mode == "deterministic" {
		return fmt.Sprintf(
			`{"ok":false,"generation":%d,"checked":%d,"failed":1,"error":"agent_mismatch"}`,
			payload.Generation, len(payload.Routes),
		), nil
	}
	return fmt.Sprintf(
		`{"ok":true,"generation":%d,"checked":%d,"failed":0}`,
		payload.Generation, len(payload.Routes),
	), nil
}

func makeProbeRoutes(count int) []RouteExpectation {
	routes := make([]RouteExpectation, 0, count)
	for i := 0; i < count; i++ {
		routes = append(routes, RouteExpectation{
			AgentID: "alice", Channel: "mattermost", AccountID: "default",
			PeerKind: "direct", ExternalID: fmt.Sprintf("mm-user-%d", i),
		})
	}
	return routes
}

func TestVerifyRoutes_BatchesAboveSingleCallLimit(t *testing.T) {
	ex := &verifyRoutesRecorder{}
	result, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, makeProbeRoutes(1001))
	if err != nil {
		t.Fatalf("VerifyRoutes: %v", err)
	}
	if len(ex.batchSizes) != 2 || ex.batchSizes[0] != 1000 || ex.batchSizes[1] != 1 {
		t.Fatalf("batch sizes = %v, want [1000 1]", ex.batchSizes)
	}
	if !result.OK || result.Checked != 1001 || result.Failed != 0 || result.Generation != 7 {
		t.Fatalf("aggregated result = %+v, want 1001 checked without truncation", result)
	}
}

func TestVerifyRoutes_BatchRPCFailureIsUnknown(t *testing.T) {
	ex := &verifyRoutesRecorder{failBatch: 2, failureMode: "rpc"}
	_, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, makeProbeRoutes(1001))
	if !errors.Is(err, ErrRouteVerificationRPC) {
		t.Fatalf("second-batch RPC failure error = %v, want ErrRouteVerificationRPC", err)
	}
}

func TestVerifyRoutes_AggregatesDeterministicFailures(t *testing.T) {
	ex := &verifyRoutesRecorder{failBatch: 1, failureMode: "deterministic"}
	result, err := VerifyRoutes(context.Background(), ex, "pod-a", 7, makeProbeRoutes(1001))
	if err != nil {
		t.Fatalf("deterministic failures must not be RPC errors: %v", err)
	}
	if result.OK || result.Checked != 1001 || result.Failed != 1 {
		t.Fatalf("aggregated result = %+v, want OK=false checked=1001 failed=1", result)
	}
	if len(ex.batchSizes) != 2 {
		t.Fatalf("batch sizes = %v, want two batches", ex.batchSizes)
	}
}

// perCommandExecer 按命令返回不同结果，可注入延迟，用于验证 probe 的并发行为。
type perCommandExecer struct {
	outputs map[string]string
	errs    map[string]error
	delays  map[string]time.Duration
	mu      sync.Mutex
	calls   []string
}

func (ex *perCommandExecer) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	key := strings.Join(cmd, " ")
	ex.mu.Lock()
	ex.calls = append(ex.calls, key)
	ex.mu.Unlock()
	if delay := ex.delays[key]; delay > 0 {
		time.Sleep(delay)
	}
	if err := ex.errs[key]; err != nil {
		return "", err
	}
	return ex.outputs[key], nil
}

func (ex *perCommandExecer) callCount(key string) int {
	ex.mu.Lock()
	defer ex.mu.Unlock()
	n := 0
	for _, call := range ex.calls {
		if call == key {
			n++
		}
	}
	return n
}

func probeExecerWithDefaults(overrides map[string]string, errs map[string]error) *perCommandExecer {
	outputs := map[string]string{
		"openclaw channels status --json":                  `{"channels":{}}`,
		"openclaw gateway call muad.runtime.health --json": `{"ok":true,"generation":7,"skill":{"active":1,"queued":0},"browser":{"active":0,"queued":0}}`,
		"openclaw gateway call config.get --json":          `{"configRevisionHash":"revision-7","appliedConfigHash":"revision-7"}`,
	}
	for k, v := range overrides {
		outputs[k] = v
	}
	return &perCommandExecer{outputs: outputs, errs: errs}
}

// channels status 与 guard health RPC 必须并发执行：总耗时接近最慢的一个，
// 而不是串行之和（openclaw CLI 每次 ~1.75s，串行会翻倍）。
func TestProbe_RunsChannelsAndHealthConcurrently(t *testing.T) {
	ex := probeExecerWithDefaults(nil, nil)
	ex.delays = map[string]time.Duration{
		"openclaw channels status --json":                  300 * time.Millisecond,
		"openclaw gateway call muad.runtime.health --json": 300 * time.Millisecond,
	}
	start := time.Now()
	status := Probe(context.Background(), ex, "pod-a")
	elapsed := time.Since(start)
	if !status.Healthy || !status.RuntimeGuardHealthy || status.RuntimeGeneration != 7 {
		t.Fatalf("probe status = %+v", status)
	}
	// 并行应 ≈ 300ms；串行会 ≈ 600ms。阈值取 500ms 区分。
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("probe took %v, expected parallel (~300ms) not serial (~600ms)", elapsed)
	}
	if ex.callCount("openclaw channels status --json") != 1 || ex.callCount("openclaw gateway call muad.runtime.health --json") != 1 {
		t.Fatalf("calls = %v", ex.calls)
	}
}

// channels 失败时即使 health 正常也返回 unhealthy（基础存活信号优先）。
func TestProbe_ChannelsFailureReturnsUnhealthy(t *testing.T) {
	ex := probeExecerWithDefaults(nil, map[string]error{
		"openclaw channels status --json": errors.New("exec failed: connection refused"),
	})
	status := Probe(context.Background(), ex, "pod-a")
	if status.Healthy {
		t.Fatalf("channels failure must yield unhealthy, got %+v", status)
	}
}

// TASK-006: quiesce 依赖真实 guard health 的 longTask 计数。
func TestProbe_ParsesLongTaskCounts(t *testing.T) {
	ex := probeExecerWithDefaults(map[string]string{
		"openclaw gateway call muad.runtime.health --json": `{"ok":true,"generation":7,"skill":{"active":0,"queued":0},"browser":{"active":0,"queued":0},"longTask":{"active":2,"queued":1}}`,
	}, nil)
	status := Probe(context.Background(), ex, "pod-a")
	if status.LongTaskActive != 2 || status.LongTaskQueued != 1 {
		t.Fatalf("long task counts = %d/%d, want 2/1", status.LongTaskActive, status.LongTaskQueued)
	}
}

// ProbeWithConfigRevision 并发合并三个 CLI 输出。
func TestProbeWithConfigRevision_MergesAllThree(t *testing.T) {	ex := probeExecerWithDefaults(nil, nil)
	status := ProbeWithConfigRevision(context.Background(), ex, "pod-a")
	if !status.Healthy || !status.RuntimeGuardHealthy || status.RuntimeGeneration != 7 {
		t.Fatalf("base health fields = %+v", status)
	}
	if status.ConfigRevisionHash != "revision-7" || !status.ConfigApplied {
		t.Fatalf("config revision fields = %+v", status)
	}
}

package runtimeapply

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

func TestApplyGatewayRestartSuccess(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	applier := newTestApplier(t, driver)
	result, err := applier.Apply(context.Background(), testRequest(false))
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.RestartMode != RestartGateway || result.ConfigHash != "sha256:test" {
		t.Fatalf("result = %+v", result)
	}
	if driver.gatewayRestarts != 1 || driver.podRestarts != 0 || !driver.committed {
		t.Fatalf("driver state = %+v", driver)
	}
	if driver.routeVerifyCalls == 0 {
		t.Fatal("expected route verification")
	}
}

func TestApplyRestartNoneSuccess(t *testing.T) {
	driver := newFakeDriver(RestartNone)
	applier := newTestApplier(t, driver)
	result, err := applier.Apply(context.Background(), testRequest(false))
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.RestartMode != RestartNone || driver.gatewayRestarts != 0 || driver.podRestarts != 0 || !driver.committed {
		t.Fatalf("result=%+v driver=%+v", result, driver)
	}
	if driver.routeVerifyCalls == 0 {
		t.Fatal("expected route verification")
	}
}

func TestApplyRestartNoneWaitsForConfigRevisionApplied(t *testing.T) {
	driver := newFakeDriver(RestartNone)
	driver.configApplyLag = 1
	applier := newTestApplier(t, driver)
	result, err := applier.Apply(context.Background(), testRequest(false))
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.RestartMode != RestartNone || driver.configGetCalls < 2 {
		t.Fatalf("result=%+v configGetCalls=%d", result, driver.configGetCalls)
	}
}

func TestApplyHonorsForcePodRestartOverride(t *testing.T) {
	for _, force := range []bool{false, true} {
		t.Run(fmt.Sprintf("force=%t", force), func(t *testing.T) {
			mode := RestartPod
			if force {
				mode = RestartGateway
			}
			driver := newFakeDriver(mode)
			applier := newTestApplier(t, driver)
			result, err := applier.Apply(context.Background(), testRequest(force))
			if err != nil || result.RestartMode != RestartPod || driver.podRestarts != 1 {
				t.Fatalf("result=%+v restarts=%d err=%v", result, driver.podRestarts, err)
			}
		})
	}
}

func TestApplyValidationFailureAbortsWithoutReplacingConfig(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.failValidate = true
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageValidate)
	if !driver.aborted || driver.committed || driver.gatewayRestarts != 0 || driver.rolledBack {
		t.Fatalf("validation failure state = %+v", driver)
	}
}

func TestApplyHealthFailureRestoresPreviousGeneration(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.appliedHealthGeneration = 6
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageHealth)
	if !driver.rolledBack || driver.gatewayRestarts != 2 {
		t.Fatalf("health rollback state = %+v", driver)
	}
	var applyErr *ApplyError
	if !errors.As(err, &applyErr) || applyErr.RecoveryError != nil {
		t.Fatalf("recovery error = %v", applyErr.RecoveryError)
	}
}

func TestApplyHealthFailureForRestartNoneRollsBackWithoutRestart(t *testing.T) {
	driver := newFakeDriver(RestartNone)
	driver.appliedHealthGeneration = 6
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageHealth)
	if !driver.rolledBack || driver.gatewayRestarts != 0 || driver.podRestarts != 0 {
		t.Fatalf("health rollback state = %+v", driver)
	}
	var applyErr *ApplyError
	if !errors.As(err, &applyErr) || applyErr.RecoveryError != nil {
		t.Fatalf("recovery error = %v", applyErr.RecoveryError)
	}
}

func TestApplyRouteVerificationFailureRollsBack(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.routeVerifyFailure = true
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageHealth)
	if !driver.rolledBack || driver.gatewayRestarts != 2 || driver.routeVerifyCalls == 0 {
		t.Fatalf("route verification failure state = %+v", driver)
	}
	if !strings.Contains(err.Error(), "L5_route_not_applied") {
		t.Fatalf("error should include L5 diagnostic: %v", err)
	}
}

func TestRouteHealthExtensionDecision(t *testing.T) {
	tests := []struct {
		name     string
		status   gateway.Status
		extended bool
		want     bool
	}{
		{name: "unknown not yet extended", status: gateway.Status{Healthy: true, RouteUnknown: true}, want: true},
		{name: "unknown already extended", status: gateway.Status{Healthy: true, RouteUnknown: true}, extended: true, want: false},
		{name: "gateway unhealthy never extends", status: gateway.Status{Healthy: false, RouteUnknown: true}, want: false},
		{name: "deterministic failure never extends", status: gateway.Status{Healthy: true, RouteVerified: false}, want: false},
		{name: "verified never extends", status: gateway.Status{Healthy: true, RouteVerified: true}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := routeHealthExtension(tt.status, tt.extended); got != tt.want {
				t.Fatalf("routeHealthExtension(%+v, %t) = %v, want %v", tt.status, tt.extended, got, tt.want)
			}
		})
	}
}

// 路由验证 RPC 瞬时失败（状态未知）不算确定性失败：健康等待继续轮询直到 RPC
// 恢复，不触发回滚。
func TestApplyRouteVerificationRPCFailureRecoversAfterExtension(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.routeVerifyRPCTemporaryFails = 3
	applier, err := New(driver, Options{HealthTimeout: 10 * time.Millisecond, PollInterval: 5 * time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	result, err := applier.Apply(context.Background(), testRequest(false))
	if err != nil {
		t.Fatalf("Apply with temporary RPC failures: %v", err)
	}
	if result.RestartMode != RestartGateway || driver.rolledBack {
		t.Fatalf("apply should succeed without rollback, result=%+v rolledBack=%t", result, driver.rolledBack)
	}
	if driver.routeVerifyCalls <= driver.routeVerifyRPCTemporaryFails {
		t.Fatalf("expected verification retries beyond the RPC failures, calls=%d", driver.routeVerifyCalls)
	}
}

// RPC 持续失败（未知）最终超时：诊断是 L5_route_unknown，与确定性失败区分。
func TestApplyRouteVerificationRPCFailureTimesOutWithUnknownDiagnostic(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.routeVerifyRPCTemporaryFails = 1 << 20
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageHealth)
	if !driver.rolledBack {
		t.Fatal("persistent unknown route state should eventually roll back")
	}
	if !strings.Contains(err.Error(), "L5_route_unknown") {
		t.Fatalf("error should include L5_route_unknown diagnostic: %v", err)
	}
}

// 路由验证结果是旧 generation 的 OK：applyReady 必须拒绝（RouteGeneration 参与判定）。
func TestApplyRouteVerificationStaleGenerationIsNotReady(t *testing.T) {
	driver := newFakeDriver(RestartGateway)
	driver.routeVerifyGeneration = 6 // 旧 generation 的验证结果
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageHealth)
	if !strings.Contains(err.Error(), "L5_route_generation_mismatch") {
		t.Fatalf("error should include L5_route_generation_mismatch diagnostic: %v", err)
	}
}

func TestHealthFailureCodeReportsLayeredDiagnostics(t *testing.T) {
	tests := []struct {
		name   string
		status gateway.Status
		config bool
		routes bool
		want   string
	}{
		{name: "gateway", want: "L1_gateway_unreachable"},
		{
			name:   "config",
			status: gateway.Status{Healthy: true, RuntimeGuardHealthy: true, RuntimeGeneration: 7},
			config: true, want: "L3_config_not_applied",
		},
		{
			name:   "guard",
			status: gateway.Status{Healthy: true, RuntimeGeneration: 6, ConfigApplied: true},
			config: true, want: "L4_guard_unready",
		},
		{
			name: "route",
			status: gateway.Status{
				Healthy: true, RuntimeGuardHealthy: true, RuntimeGeneration: 7, ConfigApplied: true,
			},
			config: true, routes: true, want: "L5_route_not_applied",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := healthFailureCode(tt.status, 7, tt.config, tt.routes)
			if got != tt.want {
				t.Fatalf("healthFailureCode = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestApplyRestartFailureRestartsRestoredPod(t *testing.T) {
	driver := newFakeDriver(RestartPod)
	driver.failFirstPodRestart = true
	applier := newTestApplier(t, driver)
	_, err := applier.Apply(context.Background(), testRequest(false))
	assertApplyStage(t, err, StageRestart)
	if !driver.rolledBack || driver.podRestarts != 2 {
		t.Fatalf("restart rollback state = %+v", driver)
	}
}

type fakeDriver struct {
	prepareMode                 RestartMode
	appliedHealthGeneration     int64
	failValidate                bool
	failFirstPodRestart         bool
	committed                   bool
	aborted                     bool
	rolledBack                  bool
	gatewayRestarts              int
	podRestarts                  int
	configApplyLag               int
	configGetCalls               int
	routeVerifyCalls             int
	routeVerifyFailure           bool
	routeVerifyRPCTemporaryFails int
	routeVerifyGeneration        int64
}

func newFakeDriver(mode RestartMode) *fakeDriver {
	return &fakeDriver{prepareMode: mode, appliedHealthGeneration: 7}
}

func (driver *fakeDriver) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	joined := strings.Join(cmd, " ")
	switch {
	case strings.HasSuffix(joined, " validate"):
		if driver.failValidate {
			return "", errors.New("schema rejected")
		}
		return `{"valid":true}`, nil
	case strings.HasSuffix(joined, " abort"):
		driver.aborted = true
		return `{"aborted":true}`, nil
	case strings.HasSuffix(joined, " rollback"):
		driver.rolledBack = true
		return `{"generation":6}`, nil
	case joined == "kill -USR1 1":
		driver.gatewayRestarts++
		return `{}`, nil
	case strings.Contains(joined, "channels status"):
		return `{"channels":{}}`, nil
	case strings.Contains(joined, "muad.runtime.health"):
		generation := driver.appliedHealthGeneration
		if driver.rolledBack {
			generation = 6
		}
		return fmt.Sprintf(`{"ok":true,"generation":%d}`, generation), nil
	case strings.Contains(joined, "muad.runtime.verify-routes"):
		driver.routeVerifyCalls++
		if driver.routeVerifyRPCTemporaryFails > 0 {
			driver.routeVerifyRPCTemporaryFails--
			return "", errors.New("exec failed: gateway is restarting")
		}
		generation := driver.routeVerifyGeneration
		if generation == 0 {
			generation = driver.appliedHealthGeneration
		}
		if driver.routeVerifyFailure {
			return fmt.Sprintf(`{"ok":false,"generation":%d,"checked":1,"failed":1,"error":"agent_mismatch"}`, generation), nil
		}
		return fmt.Sprintf(`{"ok":true,"generation":%d,"checked":1,"failed":0}`, generation), nil
	case strings.Contains(joined, "config.get"):
		driver.configGetCalls++
		revision := driver.currentRevision()
		applied := revision
		if !driver.rolledBack && driver.configApplyLag > 0 {
			driver.configApplyLag--
			applied = "revision-6"
		}
		return fmt.Sprintf(`{"configRevisionHash":%q,"appliedConfigHash":%q}`, revision, applied), nil
	default:
		return "", fmt.Errorf("unexpected command: %s", joined)
	}
}

func (driver *fakeDriver) currentRevision() string {
	if driver.rolledBack {
		return "revision-6"
	}
	return "revision-7"
}

func (driver *fakeDriver) ExecStdin(
	_ context.Context, _ string, input io.Reader, cmd ...string,
) (string, error) {
	if _, err := io.ReadAll(input); err != nil {
		return "", err
	}
	joined := strings.Join(cmd, " ")
	if strings.HasSuffix(joined, " prepare") {
		return fmt.Sprintf(`{"generation":7,"configHash":"sha256:test","restartMode":%q}`, driver.prepareMode), nil
	}
	if strings.HasSuffix(joined, " commit") {
		driver.committed = true
		return `{"generation":7}`, nil
	}
	return "", fmt.Errorf("unexpected stdin command: %s", joined)
}

func (driver *fakeDriver) Restart(_ context.Context, _ string) error {
	driver.podRestarts++
	if driver.failFirstPodRestart && driver.podRestarts == 1 {
		return errors.New("rollout failed")
	}
	return nil
}

func newTestApplier(t *testing.T, driver Driver) *Applier {
	t.Helper()
	applier, err := New(driver, Options{HealthTimeout: 10 * time.Millisecond, PollInterval: time.Millisecond})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return applier
}

func testRequest(force bool) Request {
	return Request{
		PodID: "pod-a", Generation: 7, ForcePodRestart: force,
		RuntimeJSON: []byte(`{
			"podId":"pod-a",
			"generation":7,
			"routes":[{
				"agentId":"alice",
				"channel":"mattermost",
				"accountId":"default",
				"peerKind":"direct",
				"externalId":"mm-user-1"
			}]
		}`),
	}
}

func assertApplyStage(t *testing.T, err error, stage Stage) {
	t.Helper()
	var applyErr *ApplyError
	if !errors.As(err, &applyErr) || applyErr.Stage != stage {
		t.Fatalf("error = %v, want stage %s", err, stage)
	}
}

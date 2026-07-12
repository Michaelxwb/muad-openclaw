package runtimeapply

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
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
}

func TestApplyUsesPodRestartForBrowserOrResourceChange(t *testing.T) {
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
	prepareMode             RestartMode
	appliedHealthGeneration int64
	failValidate            bool
	failFirstPodRestart     bool
	committed               bool
	aborted                 bool
	rolledBack              bool
	gatewayRestarts         int
	podRestarts             int
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
	default:
		return "", fmt.Errorf("unexpected command: %s", joined)
	}
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
		RuntimeJSON: []byte(`{"podId":"pod-a","generation":7}`),
	}
}

func assertApplyStage(t *testing.T, err error, stage Stage) {
	t.Helper()
	var applyErr *ApplyError
	if !errors.As(err, &applyErr) || applyErr.Stage != stage {
		t.Fatalf("error = %v, want stage %s", err, stage)
	}
}

package test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func (f *fakeDriver) SnapshotStartupConfig(_ context.Context, podID string) (driver.RuntimeStartupSnapshot, error) {
	payload, err := driver.BuildRuntimeStartupPayload(f.created[podID])
	if err != nil {
		return driver.RuntimeStartupSnapshot{}, err
	}
	return driver.RuntimeStartupSnapshot{Mode: driver.RuntimeStartupFile, RuntimeJSON: payload.RuntimeJSON, Environment: payload.Environment}, nil
}
func (f *fakeDriver) SyncStartupConfig(context.Context, driver.PodSpec) error { return nil }
func (f *fakeDriver) RestoreRuntime(ctx context.Context, spec driver.PodSpec, _ driver.RuntimeStartupSnapshot) error {
	return f.ReplaceRuntime(ctx, spec)
}

type inputRecoveryDriver struct {
	*fakeDriver
	mode              driver.RuntimeStartupMode
	restored          []driver.RuntimeStartupSnapshot
	restoreErr        error
	syncErr           error
	unhealthyUpgrade  bool
	unhealthyRecovery bool
}

func (d *inputRecoveryDriver) SnapshotStartupConfig(ctx context.Context, id string) (driver.RuntimeStartupSnapshot, error) {
	snapshot, err := d.fakeDriver.SnapshotStartupConfig(ctx, id)
	snapshot.Mode = d.mode
	return snapshot, err
}
func (d *inputRecoveryDriver) RestoreRuntime(ctx context.Context, spec driver.PodSpec, snapshot driver.RuntimeStartupSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	d.restored = append(d.restored, snapshot)
	if d.restoreErr != nil {
		return d.restoreErr
	}
	return d.fakeDriver.RestoreRuntime(ctx, spec, snapshot)
}
func (d *inputRecoveryDriver) SyncStartupConfig(context.Context, driver.PodSpec) error {
	return d.syncErr
}
func (d *inputRecoveryDriver) WorkloadBlocked(context.Context, string) (bool, error) {
	return (d.unhealthyUpgrade && len(d.restored) == 0) || (d.unhealthyRecovery && len(d.restored) > 0), nil
}

func runtimeUpgradeEnv(t *testing.T, mode driver.RuntimeStartupMode) (*testEnv, *inputRecoveryDriver) {
	t.Helper()
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	d := &inputRecoveryDriver{fakeDriver: e.drv, mode: mode}
	e.h = api.NewServer(e.cfg, e.store, e.cipher, d, e.cache, e.syncer, e.reconcile).Handler()
	return e, d
}

func TestRuntimeFileUpgrade_FailureStopsForward(t *testing.T) {
	for _, mode := range []driver.RuntimeStartupMode{driver.RuntimeStartupEnv, driver.RuntimeStartupFile} {
		t.Run(string(mode), func(t *testing.T) {
			e, d := runtimeUpgradeEnv(t, mode)
			before, err := e.store.GetPod("pod-a")
			if err != nil {
				t.Fatal(err)
			}
			d.replaceErrors = []error{errors.New("api_key=private-upgrade-key")}
			rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:bad"}`)
			if !strings.Contains(rr.Body.String(), `"code":50216`) {
				t.Fatalf("fail-forward code missing: %s", rr.Body.String())
			}
			// 无回退：不得恢复旧启动输入。
			if len(d.restored) != 0 {
				t.Fatalf("no rollback may restore startup input: %+v", d.restored)
			}
			after, err := e.store.GetPod("pod-a")
			if err != nil {
				t.Fatal(err)
			}
			if after.State != repo.PodStateError || after.LastApplyStatus != repo.ApplyStatusFailed {
				t.Fatalf("pod must stop in error: %+v", after)
			}
			if after.ImageTag != "img:bad" || after.ConfigGeneration <= before.ConfigGeneration {
				t.Fatalf("target image must be kept: %+v", after)
			}
			if strings.Contains(after.LastApplyError+rr.Body.String(), "private-upgrade-key") {
				t.Fatal("secret exposed")
			}
		})
	}
}

func TestRuntimeFileUpgrade_E03HealthAndRecoveryFailures(t *testing.T) {
	for _, scenario := range []string{"health", "source", "restore", "recovery-health", "cancel", "timeout"} {
		t.Run(scenario, func(t *testing.T) { assertUpgradeFailure(t, scenario) })
	}
}

func assertUpgradeFailure(t *testing.T, scenario string) {
	t.Helper()
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	switch scenario {
	case "health":
		d.unhealthyUpgrade = true
	case "source":
		d.syncErr = errors.New("source publish failed")
	case "restore":
		d.replaceErrors = []error{errors.New("upgrade failed")}
		d.restoreErr = errors.New("token=private-rollback-token")
	case "recovery-health":
		d.unhealthyUpgrade = true
		d.unhealthyRecovery = true
	case "cancel":
		d.replaceErrors = []error{context.Canceled}
	case "timeout":
		d.replaceErrors = []error{context.DeadlineExceeded}
	}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:bad"}`)
	if !strings.Contains(rr.Body.String(), `"code":50216`) {
		t.Fatalf("fail-forward response missing: %s", rr.Body.String())
	}
	if len(d.restored) != 0 {
		t.Fatal("fail-forward must never restore startup input")
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatal(err)
	}
	if pod.State != repo.PodStateError || pod.LastApplyStatus != repo.ApplyStatusFailed {
		t.Fatalf("pod must stop in terminal error state: %+v", pod)
	}
	if strings.Contains(pod.LastApplyError+rr.Body.String(), "private-rollback-token") {
		t.Fatal("failure secret exposed")
	}
}

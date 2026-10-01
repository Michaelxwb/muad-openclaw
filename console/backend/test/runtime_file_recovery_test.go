package test

import (
	"context"
	"net/http"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
)

func TestRuntimeFileRecovery_S19RestartPreservesInput(t *testing.T) {
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	d.restartErrors["pod-a"] = driver.ErrWorkloadMissing
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/restart", `{"action":"restart"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("restart failed: %s", rr.Body.String())
	}
	if len(d.restored) != 1 || d.restored[0].Mode != driver.RuntimeStartupEnv {
		t.Fatal("missing workload rebuilt through ordinary file Create")
	}
}

func TestRuntimeFileRecovery_S19RestartUnavailableFails(t *testing.T) {
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	d.restartErrors["pod-a"] = driver.ErrWorkloadMissing
	d.restoreErr = context.DeadlineExceeded
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/actions/restart", `{"action":"restart"}`)
	if rr.Code < http.StatusBadRequest {
		t.Fatal("failed recovery claimed healthy rebuild")
	}
}

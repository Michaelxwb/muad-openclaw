package gateway

import (
	"context"
	"errors"
	"strings"
	"testing"
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

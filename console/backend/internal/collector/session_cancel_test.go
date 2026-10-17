package collector

import (
	"context"
	"strings"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
)

type sessionCancelProbeExecer struct {
	health string
}

func (ex *sessionCancelProbeExecer) Exec(_ context.Context, _ string, cmd ...string) (string, error) {
	joined := strings.Join(cmd, " ")
	switch {
	case joined == "openclaw channels status --json":
		return `{"channels":{}}`, nil
	case joined == "openclaw gateway call muad.runtime.health --json":
		return ex.health, nil
	default:
		return "", nil
	}
}

// SessionCancel S-04 [integration] 真实边界：health probe JSON → collector 写入
// → 能力缓存查询；两类能力必须同时更新且互不覆盖。
func TestSessionCancelS04ProbeHealthFeedsCapabilityCache(t *testing.T) {
	ex := &sessionCancelProbeExecer{
		health: `{"ok":true,"generation":7,"skill":{"active":0,"queued":0},"browser":{"active":0,"queued":0},"longTaskCancel":{"available":true,"version":2},"sessionCancel":{"available":true,"version":1}}`,
	}
	status := gateway.Probe(context.Background(), ex, "pod-a")
	if !status.Healthy || !status.RuntimeGuardHealthy {
		t.Fatalf("probe status = %+v", status)
	}

	cache := gateway.NewCancelCapabilityCache(0)
	collector := &Collector{capabilities: cache, cache: monitor.NewCache()}
	collector.updateCapabilities("pod-a", status)

	capability, ok := cache.Lookup("pod-a")
	if !ok {
		t.Fatalf("probe must publish a capability snapshot")
	}
	if !capability.LongTask.Available || capability.LongTask.Version != 2 {
		t.Fatalf("long task capability regression = %+v", capability.LongTask)
	}
	if !capability.SessionCancel.Available || capability.SessionCancel.Version != 1 {
		t.Fatalf("session cancel capability = %+v", capability.SessionCancel)
	}
}

// 旧 Worker 不上报 sessionCancel：缓存记录“已知不支持”，而不是未知。
func TestSessionCancelS04LegacyWorkerIsKnownUnsupported(t *testing.T) {
	ex := &sessionCancelProbeExecer{
		health: `{"ok":true,"generation":7,"skill":{"active":0,"queued":0},"browser":{"active":0,"queued":0},"longTaskCancel":{"available":true,"version":2}}`,
	}
	status := gateway.Probe(context.Background(), ex, "pod-a")
	cache := gateway.NewCancelCapabilityCache(0)
	collector := &Collector{capabilities: cache}
	collector.updateCapabilities("pod-a", status)

	capability, ok := cache.Lookup("pod-a")
	if !ok {
		t.Fatalf("legacy Worker capability must be known")
	}
	if capability.SessionCancel.Available {
		t.Fatalf("legacy Worker must be reported unsupported, got %+v", capability.SessionCancel)
	}
	if !capability.LongTask.Available {
		t.Fatalf("long task capability must be preserved, got %+v", capability.LongTask)
	}
}

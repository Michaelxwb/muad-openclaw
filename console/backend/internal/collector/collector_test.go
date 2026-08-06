package collector

import (
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
)

func TestMergeResourceStats_DockerPathComputesPercentFromLimit(t *testing.T) {
	// docker path 由 ParseStats 把每核百分比换算成 CPUm（7.7% × 10 = 77m）。
	// mergeResourceStats 用 CPUm / limitMilli * 100 计算，与 k8s 路径"已使用/总量"一致。
	snapshots := map[string]monitor.Snapshot{
		"pod-01": {PodID: "pod-01", EffectiveCPULimit: "6"},
	}
	stats := map[string]driver.Stats{
		"pod-01": {CPUm: 77, CPUPercent: 7.7, MemMiB: 541},
	}
	mergeResourceStats(snapshots, stats)
	snap := snapshots["pod-01"]
	if snap.CPUm != 77 {
		t.Errorf("CPUm mismatch: %d", snap.CPUm)
	}
	const want = 77.0 / 6000.0 * 100
	if snap.CPUPercent < want-0.01 || snap.CPUPercent > want+0.01 {
		t.Errorf("CPUPercent = %f, want ~%.4f", snap.CPUPercent, want)
	}
	if snap.MemMiB != 541 {
		t.Errorf("MemMiB mismatch: %d", snap.MemMiB)
	}
}

func TestMergeResourceStats_K8sPathComputesPercentFromLimit(t *testing.T) {
	// k8s path emits CPUm (absolute milli-cores). With EffectiveCPULimit=6 (6000m)
	// and CPUm=464, expect 464/6000*100 = 7.733...%.
	snapshots := map[string]monitor.Snapshot{
		"pod-01": {PodID: "pod-01", EffectiveCPULimit: "6"},
	}
	stats := map[string]driver.Stats{
		"pod-01": {CPUm: 464, MemMiB: 541},
	}
	mergeResourceStats(snapshots, stats)
	snap := snapshots["pod-01"]
	if snap.CPUm != 464 {
		t.Errorf("CPUm mismatch: %d", snap.CPUm)
	}
	const want = 464.0 / 6000.0 * 100
	if snap.CPUPercent < want-0.01 || snap.CPUPercent > want+0.01 {
		t.Errorf("CPUPercent = %f, want ~%.4f", snap.CPUPercent, want)
	}
}

func TestMergeResourceStats_InvalidLimitLeavesPercentZero(t *testing.T) {
	// If EffectiveCPULimit is empty/unparseable, percent stays 0 (no fallback to /10 bug).
	snapshots := map[string]monitor.Snapshot{
		"pod-01": {PodID: "pod-01", EffectiveCPULimit: ""},
	}
	stats := map[string]driver.Stats{
		"pod-01": {CPUm: 464, MemMiB: 541},
	}
	mergeResourceStats(snapshots, stats)
	if snapshots["pod-01"].CPUPercent != 0 {
		t.Errorf("expected 0 percent when limit unparseable, got %f", snapshots["pod-01"].CPUPercent)
	}
}

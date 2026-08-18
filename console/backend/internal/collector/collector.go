// Package collector samples every managed Pod and publishes one atomic cache.
package collector

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

const (
	defaultWorkers = 16
	// A K8s probe runs two execs (`channels status` and runtime health). Each
	// exec often takes ~1s under kubectl/SPDY, so 3s causes false runtime guard
	// alerts on normal cluster jitter. Keep 12s headroom: on isolated (offline)
	// networks the `openclaw` CLI→gateway RPC can take ~9-10s (gateway-side
	// response latency, not CLI CPU), and a probe timing out marks the whole
	// snapshot unhealthy — grey channel tags plus "Pod down or unreachable"
	// alerts on perfectly healthy Pods. 12s still surfaces genuinely dead Pods
	// within one collector cycle.
	probeTimeout = 12 * time.Second
)

// Collector samples runtime state on an interval.
type Collector struct {
	drv      driver.RuntimeDriver
	source   PodSource
	cache    *monitor.Cache
	defaults driver.ResourceSpec
	interval time.Duration
	workers  int
}

// PodSource provides the control-plane state included in each snapshot.
type PodSource interface {
	ListPods(filter repo.PodListFilter) ([]repo.PodSummary, int, error)
	GetResourceGlobal() (repo.ResourceConfig, error)
}

// New builds a Pod collector.
func New(drv driver.RuntimeDriver, source PodSource, cache *monitor.Cache, defaults driver.ResourceSpec, interval time.Duration) *Collector {
	return &Collector{
		drv: drv, source: source, cache: cache, defaults: defaults,
		interval: interval, workers: defaultWorkers,
	}
}

// Run collects immediately, then every interval until ctx is cancelled.
func (c *Collector) Run(ctx context.Context) {
	c.CollectOnce(ctx)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.CollectOnce(ctx)
		}
	}
}

// CollectOnce runs one full sampling cycle and atomically swaps the cache.
func (c *Collector) CollectOnce(ctx context.Context) {
	infos, err := c.drv.List(ctx)
	if err != nil {
		// Never fail silently: log the redacted error and publish control-plane
		// snapshots marked unhealthy so alerting does not keep serving the
		// previous (possibly Healthy=true) snapshot as fresh state.
		log.Printf("collector_list_failed error=%s", auditlog.RedactDiagnostic(err.Error()))
		c.publishStaleSnapshots(err)
		return
	}
	snaps, err := c.baseSnapshots()
	if err != nil {
		log.Printf("collector_source_failed error=%s", auditlog.RedactDiagnostic(err.Error()))
		return
	}
	stats, _ := c.drv.StatsAll(ctx)
	states := runtimeStates(infos)
	mergeResourceStats(snaps, stats)
	c.probeRunningPods(ctx, snaps, states)
	c.cache.Replace(snaps)
}

// publishStaleSnapshots replaces the cache with the control-plane snapshot set
// whose Pods are all marked unhealthy after the driver probe failed.
func (c *Collector) publishStaleSnapshots(cause error) {
	snaps, err := c.baseSnapshots()
	if err != nil {
		log.Printf("collector_stale_snapshot_failed error=%s", auditlog.RedactDiagnostic(err.Error()))
		return
	}
	for podID, snapshot := range snaps {
		snapshot.Healthy = false
		snaps[podID] = snapshot
	}
	c.cache.Replace(snaps)
}

func (c *Collector) probeRunningPods(ctx context.Context, snaps map[string]monitor.Snapshot, states map[string]string) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, c.workers)
	results := make(map[string]monitor.Snapshot, len(snaps))
	for podID, snapshot := range snaps {
		if states[podID] != "running" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id string, base monitor.Snapshot) {
			defer wg.Done()
			defer func() { <-sem }()
			pctx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			mergeGatewayStatus(&base, gateway.Probe(pctx, c.drv, id))
			mu.Lock()
			results[id] = base
			mu.Unlock()
		}(podID, snapshot)
	}
	wg.Wait()
	for podID, snapshot := range results {
		snaps[podID] = snapshot
	}
}

func (c *Collector) baseSnapshots() (map[string]monitor.Snapshot, error) {
	pods, _, err := c.source.ListPods(repo.PodListFilter{})
	if err != nil {
		return nil, err
	}
	global, err := c.source.GetResourceGlobal()
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		return nil, err
	}
	snapshots := make(map[string]monitor.Snapshot, len(pods))
	for _, item := range pods {
		effective := driver.ResolveResourceSpec(podResources(item.Pod), globalResources(global), c.defaults)
		snapshots[item.PodID] = newSnapshot(item, effective)
	}
	return snapshots, nil
}

func newSnapshot(item repo.PodSummary, effective driver.ResourceSpec) monitor.Snapshot {
	memMiB, _ := driver.MemoryLimitMiB(effective.MemLimit)
	lag := max(int64(0), item.ConfigGeneration-item.AppliedGeneration)
	return monitor.Snapshot{
		PodID: item.PodID, UserCount: item.UserCount, MaxUsers: item.MaxUsers,
		AvailableSlots: item.AvailableSlots, Healthy: true, Updated: time.Now(),
		EffectiveMemLimit: effective.MemLimit, EffectiveMemLimitMiB: memMiB,
		MemAlertThresholdMiB: memMiB * 85 / 100, EffectiveCPULimit: effective.CPULimit,
		EffectiveRestartPolicy: effective.RestartPolicy,
		MaxSkillConcurrency:    effective.MaxSkillConcurrency,
		MaxBrowserConcurrency:  effective.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: effective.MaxLongTaskConcurrency,
		ConfigGeneration:       item.ConfigGeneration, AppliedGeneration: item.AppliedGeneration,
		GenerationLag: lag,
	}
}

func podResources(pod repo.Pod) driver.ResourceSpec {
	return driver.ResourceSpec{
		MemLimit: pod.MemLimit, CPULimit: pod.CPULimit, RestartPolicy: pod.RestartPolicy,
		MaxSkillConcurrency: pod.MaxSkillConcurrency, MaxBrowserConcurrency: pod.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: pod.MaxLongTaskConcurrency,
	}
}

func globalResources(global repo.ResourceConfig) driver.ResourceSpec {
	return driver.ResourceSpec{
		MemLimit: global.MemLimit, CPULimit: global.CPULimit, RestartPolicy: global.RestartPolicy,
		MaxSkillConcurrency: global.MaxSkillConcurrency, MaxBrowserConcurrency: global.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: global.MaxLongTaskConcurrency,
	}
}

func runtimeStates(infos []driver.ContainerInfo) map[string]string {
	states := make(map[string]string, len(infos))
	for _, info := range infos {
		states[info.PodID] = info.State
	}
	return states
}

func mergeResourceStats(snapshots map[string]monitor.Snapshot, stats map[string]driver.Stats) {
	for podID, sample := range stats {
		snapshot, exists := snapshots[podID]
		if !exists {
			continue
		}
		snapshot.CPUm = sample.CPUm
		snapshot.MemMiB = sample.MemMiB
		if sample.CPUm > 0 {
			if limitMilli, err := driver.CPULimitMilli(snapshot.EffectiveCPULimit); err == nil && limitMilli > 0 {
				snapshot.CPUPercent = float64(sample.CPUm) / float64(limitMilli) * 100
			}
		} else if sample.CPUPercent > 0 {
			snapshot.CPUPercent = sample.CPUPercent
		}
		snapshots[podID] = snapshot
	}
}

func mergeGatewayStatus(snapshot *monitor.Snapshot, status gateway.Status) {
	snapshot.Healthy = status.Healthy
	snapshot.ChannelConnected = status.ChannelConnected
	snapshot.ChannelStatuses = status.ChannelStatuses
	snapshot.ChannelDefaultAccountIDs = status.ChannelDefaultAccountIDs
	snapshot.LastActiveAt = status.LastActiveAt
	snapshot.LastMessageAt = status.LastMessageAt
	snapshot.RuntimeGuardHealthy = status.RuntimeGuardHealthy
	snapshot.RuntimeGeneration = status.RuntimeGeneration
	snapshot.SkillActive = status.SkillActive
	snapshot.SkillQueued = status.SkillQueued
	snapshot.BrowserActive = status.BrowserActive
	snapshot.BrowserQueued = status.BrowserQueued
}

// Package collector periodically samples every container's resources and
// application status and publishes a snapshot to the monitor cache (TASK-011).
// It probes concurrently with per-container timeouts and isolates failures so
// one stuck container never blocks the cycle (NFR-PERF-01 / NFR-REL-01).
package collector

import (
	"context"
	"sync"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
)

const (
	defaultWorkers = 16
	probeTimeout   = 3 * time.Second
)

// Collector samples runtime state on an interval.
type Collector struct {
	drv      driver.RuntimeDriver
	cache    *monitor.Cache
	interval time.Duration
	workers  int
}

// New builds a Collector.
func New(drv driver.RuntimeDriver, cache *monitor.Cache, interval time.Duration) *Collector {
	return &Collector{drv: drv, cache: cache, interval: interval, workers: defaultWorkers}
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
		return // leave the previous snapshot in place
	}
	stats, _ := c.drv.StatsAll(ctx) // best-effort; missing → zero metrics

	snaps := make(map[string]monitor.Snapshot, len(infos))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, c.workers)

	for _, info := range infos {
		st := monitor.Snapshot{Updated: time.Now(), Healthy: true}
		if s, ok := stats[info.UserID]; ok {
			st.CPUPercent = s.CPUPercent
			st.MemMiB = s.MemMiB
		}

		// Only probe running containers; stopped/archived ones are intentionally
		// down, not unhealthy.
		if info.State != "running" {
			mu.Lock()
			snaps[info.UserID] = st
			mu.Unlock()
			continue
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(userID string, base monitor.Snapshot) {
			defer wg.Done()
			defer func() { <-sem }()

			pctx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			status := gateway.Probe(pctx, c.drv, userID)

			base.Healthy = status.Healthy
			base.ChannelConnected = status.ChannelConnected
			base.LastActiveAt = status.LastActiveAt

			mu.Lock()
			snaps[userID] = base
			mu.Unlock()
		}(info.UserID, st)
	}

	wg.Wait()
	c.cache.Replace(snaps)
}

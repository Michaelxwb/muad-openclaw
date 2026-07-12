// Package monitor holds the in-memory snapshot of per-Pod runtime metrics.
// The collector writes it; Pod APIs and alerting read it.
// Monitoring data is intentionally not persisted (§3.3).
package monitor

import (
	"sync"
	"time"
)

// Snapshot is the latest sampled runtime and control-plane state for one Pod.
type Snapshot struct {
	PodID                  string
	UserCount              int
	MaxUsers               int
	AvailableSlots         int
	CPUPercent             float64
	MemMiB                 int
	EffectiveMemLimit      string
	EffectiveMemLimitMiB   int
	MemAlertThresholdMiB   int
	EffectiveCPULimit      string
	EffectiveRestartPolicy string
	MaxSkillConcurrency    int
	MaxBrowserConcurrency  int
	SkillActive            int
	SkillQueued            int
	BrowserActive          int
	BrowserQueued          int
	ConfigGeneration       int64
	AppliedGeneration      int64
	GenerationLag          int64
	RuntimeGeneration      int64
	RuntimeGuardHealthy    bool
	ChannelConnected       bool
	ChannelStatuses        map[string]bool // per-channel connected state
	LastActiveAt           time.Time       // display "最后活跃" (incl. channel start)
	LastMessageAt          time.Time       // real message activity; drives idle/reap countdown
	Healthy                bool            // false when the last probe failed (→ unhealthy)
	Updated                time.Time
}

// Cache is a concurrency-safe map of podID to Snapshot.
type Cache struct {
	mu   sync.RWMutex
	data map[string]Snapshot
}

// NewCache returns an empty cache.
func NewCache() *Cache {
	return &Cache{data: make(map[string]Snapshot)}
}

// Get returns a detached snapshot for a Pod and whether it exists.
func (c *Cache) Get(podID string) (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshot, ok := c.data[podID]
	return cloneSnapshot(snapshot), ok
}

// Replace atomically swaps the entire snapshot set (one collector cycle).
func (c *Cache) Replace(snaps map[string]Snapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data = make(map[string]Snapshot, len(snaps))
	for podID, snapshot := range snaps {
		c.data[podID] = cloneSnapshot(snapshot)
	}
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	if snapshot.ChannelStatuses == nil {
		return snapshot
	}
	statuses := make(map[string]bool, len(snapshot.ChannelStatuses))
	for channel, connected := range snapshot.ChannelStatuses {
		statuses[channel] = connected
	}
	snapshot.ChannelStatuses = statuses
	return snapshot
}

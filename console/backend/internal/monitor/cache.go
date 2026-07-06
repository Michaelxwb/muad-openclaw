// Package monitor holds the in-memory snapshot of per-container runtime metrics.
// The collector (TASK-011) writes it; the container list API (TASK-012) reads it.
// Monitoring data is intentionally not persisted (§3.3).
package monitor

import (
	"sync"
	"time"
)

// Snapshot is the latest sampled runtime state for one container.
type Snapshot struct {
	CPUPercent       float64
	MemMiB           int
	ChannelConnected bool
	ChannelStatuses  map[string]bool // per-channel connected state
	LastActiveAt     time.Time // display "最后活跃" (incl. channel start)
	LastMessageAt    time.Time // real message activity; drives idle/reap countdown
	Healthy          bool      // false when the last probe failed (→ unhealthy)
	Updated          time.Time
}

// Cache is a concurrency-safe map of userID → Snapshot.
type Cache struct {
	mu   sync.RWMutex
	data map[string]Snapshot
}

// NewCache returns an empty cache.
func NewCache() *Cache {
	return &Cache{data: make(map[string]Snapshot)}
}

// Get returns the snapshot for a user and whether it exists.
func (c *Cache) Get(userID string) (Snapshot, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	s, ok := c.data[userID]
	return s, ok
}

// Replace atomically swaps the entire snapshot set (one collector cycle).
func (c *Cache) Replace(snaps map[string]Snapshot) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data = snaps
}

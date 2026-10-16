package gateway

import (
	"sync"
	"time"
)

// 按 Pod 的长任务取消能力缓存：由既有 health probe 周期性更新，列表与取消入口只读
// 查询（纯内存，不产生逐行 RPC）。未知与过期一律保守视为不可取消。

// LongTaskCancelCapability 是某 Pod 的取消能力快照。
type LongTaskCancelCapability struct {
	Available bool
	Version   int
}

type longTaskCapabilityEntry struct {
	capability LongTaskCancelCapability
	seenAt     time.Time
}

// LongTaskCapabilityCache 并发安全的能力缓存。
type LongTaskCapabilityCache struct {
	mu      sync.RWMutex
	entries map[string]longTaskCapabilityEntry
	ttl     time.Duration
	now     func() time.Time
}

func NewLongTaskCapabilityCache(ttl time.Duration) *LongTaskCapabilityCache {
	if ttl <= 0 {
		ttl = time.Minute
	}
	return &LongTaskCapabilityCache{
		entries: make(map[string]longTaskCapabilityEntry),
		ttl:     ttl,
		now:     time.Now,
	}
}

// Update 由 health probe 在每次探活后写入；空 podID 忽略。
func (c *LongTaskCapabilityCache) Update(podID string, capability LongTaskCancelCapability) {
	if c == nil || podID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[podID] = longTaskCapabilityEntry{capability: capability, seenAt: c.now()}
}

// Lookup 返回已知且未过期的能力；未知/过期返回 ok=false，调用方必须按不可取消处理。
func (c *LongTaskCapabilityCache) Lookup(podID string) (LongTaskCancelCapability, bool) {
	if c == nil || podID == "" {
		return LongTaskCancelCapability{}, false
	}
	c.mu.RLock()
	entry, exists := c.entries[podID]
	c.mu.RUnlock()
	if !exists {
		return LongTaskCancelCapability{}, false
	}
	if c.now().Sub(entry.seenAt) > c.ttl {
		return LongTaskCancelCapability{}, false
	}
	return entry.capability, true
}

// Invalidate 在 Pod 重建/重启、配置代次变化等归属变化后显式失效。
func (c *LongTaskCapabilityCache) Invalidate(podID string) {
	if c == nil || podID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, podID)
}

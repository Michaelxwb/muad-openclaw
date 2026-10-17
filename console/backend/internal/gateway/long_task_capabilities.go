package gateway

import (
	"sync"
	"time"
)

// 按 Pod 的取消能力缓存：由既有 health probe 周期性更新，列表与取消入口只读
// 查询（纯内存，不产生逐行 RPC）。未知与过期一律保守视为不可取消。缓存同时
// 承载长任务与会话终止两类能力，二者共享同一次探活快照与 TTL。

// LongTaskCancelCapability 是某 Pod 的长任务取消能力快照。
type LongTaskCancelCapability struct {
	Available bool
	Version   int
}

// SessionCancelCapability 是某 Pod 的会话终止能力快照。
type SessionCancelCapability struct {
	Available bool
	Version   int
}

// CancelCapability 是某 Pod 的取消能力快照，同时包含长任务与会话终止能力。
type CancelCapability struct {
	LongTask      LongTaskCancelCapability
	SessionCancel SessionCancelCapability
}

type cancelCapabilityEntry struct {
	capability CancelCapability
	seenAt     time.Time
}

// CancelCapabilityCache 并发安全的取消能力缓存。
type CancelCapabilityCache struct {
	mu      sync.RWMutex
	entries map[string]cancelCapabilityEntry
	ttl     time.Duration
	now     func() time.Time
}

func NewCancelCapabilityCache(ttl time.Duration) *CancelCapabilityCache {
	if ttl <= 0 {
		ttl = time.Minute
	}
	return &CancelCapabilityCache{
		entries: make(map[string]cancelCapabilityEntry),
		ttl:     ttl,
		now:     time.Now,
	}
}

// Update 由 health probe 在每次探活后写入完整快照；空 podID 忽略。
func (c *CancelCapabilityCache) Update(podID string, capability CancelCapability) {
	if c == nil || podID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[podID] = cancelCapabilityEntry{capability: capability, seenAt: c.now()}
}

// Lookup 返回已知且未过期的能力；未知/过期返回 ok=false，调用方必须按不可取消处理。
func (c *CancelCapabilityCache) Lookup(podID string) (CancelCapability, bool) {
	if c == nil || podID == "" {
		return CancelCapability{}, false
	}
	c.mu.RLock()
	entry, exists := c.entries[podID]
	c.mu.RUnlock()
	if !exists {
		return CancelCapability{}, false
	}
	if c.now().Sub(entry.seenAt) > c.ttl {
		return CancelCapability{}, false
	}
	return entry.capability, true
}

// Invalidate 在 Pod 重建/重启、配置代次变化等归属变化后显式失效。
func (c *CancelCapabilityCache) Invalidate(podID string) {
	if c == nil || podID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, podID)
}

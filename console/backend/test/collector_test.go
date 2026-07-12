package test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/collector"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type collectorSource struct {
	pods   []repo.PodSummary
	global repo.ResourceConfig
}

func (source collectorSource) ListPods(repo.PodListFilter) ([]repo.PodSummary, int, error) {
	return source.pods, len(source.pods), nil
}

func (source collectorSource) GetResourceGlobal() (repo.ResourceConfig, error) {
	if source.global == (repo.ResourceConfig{}) {
		return repo.ResourceConfig{}, repo.ErrNotFound
	}
	return source.global, nil
}

func TestCollector_CollectOnce_PopulatesCache(t *testing.T) {
	fd := newFakeDriver()
	// two running containers via fake (Create records them)
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "alice"})
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "bob"})

	source := collectorSource{pods: []repo.PodSummary{
		{Pod: repo.Pod{PodID: "alice", MaxUsers: 10, MemLimit: "3g", ConfigGeneration: 5, AppliedGeneration: 3}, UserCount: 2, AvailableSlots: 8},
		{Pod: repo.Pod{PodID: "bob", MaxUsers: 10}, UserCount: 1, AvailableSlots: 9},
	}, global: repo.ResourceConfig{MemLimit: "2g", CPULimit: "2", RestartPolicy: "always"}}
	defaults := driver.ResourceSpec{
		MemLimit: "1g", CPULimit: "1", RestartPolicy: "unless-stopped",
		MaxSkillConcurrency: 3, MaxBrowserConcurrency: 2,
	}
	cache := monitor.NewCache()
	c := collector.New(fd, source, cache, defaults, time.Minute)
	c.CollectOnce(context.Background())

	snap, ok := cache.Get("alice")
	if !ok {
		t.Fatal("alice missing from cache")
	}
	if snap.MemMiB != 200 || snap.CPUPercent != 1.5 {
		t.Errorf("stats not applied: %+v", snap)
	}
	if !snap.ChannelConnected {
		t.Error("wecom connection not probed from exec")
	}
	if !snap.Healthy {
		t.Error("expected healthy")
	}
	if snap.LastActiveAt.IsZero() {
		t.Error("expected last activity from session updatedAt")
	}
	if snap.UserCount != 2 || snap.AvailableSlots != 8 || snap.GenerationLag != 2 {
		t.Errorf("control-plane metrics not aggregated: %+v", snap)
	}
	if snap.EffectiveMemLimit != "3g" || snap.EffectiveMemLimitMiB != 3072 || snap.EffectiveCPULimit != "2" {
		t.Errorf("effective resources not resolved: %+v", snap)
	}
	if snap.MaxSkillConcurrency != 3 || snap.MaxBrowserConcurrency != 2 {
		t.Errorf("runtime defaults not inherited: %+v", snap)
	}
	if !snap.RuntimeGuardHealthy || snap.SkillActive != 1 || snap.SkillQueued != 2 || snap.RuntimeGeneration != 3 {
		t.Errorf("runtime health not aggregated: %+v", snap)
	}

	bob, ok := cache.Get("bob")
	if !ok || bob.EffectiveMemLimit != "2g" {
		t.Errorf("bob should inherit global memory limit: %+v", bob)
	}
}

func TestMonitorCache_DetachesPerPodChannelMaps(t *testing.T) {
	cache := monitor.NewCache()
	original := map[string]monitor.Snapshot{
		"alice": {PodID: "alice", ChannelStatuses: map[string]bool{"wecom": true}},
		"bob":   {PodID: "bob", ChannelStatuses: map[string]bool{"wechat": true}},
	}
	cache.Replace(original)
	original["alice"].ChannelStatuses["wecom"] = false
	alice, _ := cache.Get("alice")
	alice.ChannelStatuses["wecom"] = false
	storedAlice, _ := cache.Get("alice")
	storedBob, _ := cache.Get("bob")
	if !storedAlice.ChannelStatuses["wecom"] || !storedBob.ChannelStatuses["wechat"] {
		t.Fatal(errors.New("cache snapshots share mutable channel state"))
	}
}

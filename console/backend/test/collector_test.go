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
	pods          []repo.PodSummary
	global        repo.ResourceConfig
	users         map[string][]repo.HumanUser
	reconciled    map[string][]repo.LongTaskTask
	reconcileErr  error
	humanUsersErr error
}

func (source *collectorSource) ListPods(repo.PodListFilter) ([]repo.PodSummary, int, error) {
	return source.pods, len(source.pods), nil
}

func (source *collectorSource) GetResourceGlobal() (repo.ResourceConfig, error) {
	if source.global == (repo.ResourceConfig{}) {
		return repo.ResourceConfig{}, repo.ErrNotFound
	}
	return source.global, nil
}

func (source *collectorSource) ListHumanUsersByPod(
	podID string, _ repo.HumanUserListFilter,
) ([]repo.HumanUser, int, error) {
	if source.humanUsersErr != nil {
		return nil, 0, source.humanUsersErr
	}
	users := append([]repo.HumanUser(nil), source.users[podID]...)
	return users, len(users), nil
}

func (source *collectorSource) ReconcileLongTaskTasks(podID string, tasks []repo.LongTaskTask) error {
	if source.reconcileErr != nil {
		return source.reconcileErr
	}
	if source.reconciled == nil {
		source.reconciled = map[string][]repo.LongTaskTask{}
	}
	source.reconciled[podID] = append([]repo.LongTaskTask(nil), tasks...)
	return nil
}

func TestCollector_CollectOnce_PopulatesCache(t *testing.T) {
	fd := newFakeDriver()
	// two running containers via fake (Create records them)
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "alice"})
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "bob"})

	source := collectorSource{pods: []repo.PodSummary{
		{Pod: repo.Pod{PodID: "alice", MaxUsers: 10, MemLimit: "3g", ConfigGeneration: 5, AppliedGeneration: 3}, UserCount: 2, AvailableSlots: 8},
		{Pod: repo.Pod{PodID: "bob", MaxUsers: 10}, UserCount: 1, AvailableSlots: 9},
	}, global: repo.ResourceConfig{
		MemLimit: "2g", CPULimit: "2", RestartPolicy: "always",
		MaxBrowserConcurrency: 4, MaxLongTaskConcurrency: 6,
	}}
	defaults := driver.ResourceSpec{
		MemLimit: "1g", CPULimit: "1", RestartPolicy: "unless-stopped",
		MaxSkillConcurrency: 3, MaxBrowserConcurrency: 2, MaxLongTaskConcurrency: 2,
	}
	cache := monitor.NewCache()
	c := collector.New(fd, &source, cache, defaults, time.Minute)
	c.CollectOnce(context.Background())

	snap, ok := cache.Get("alice")
	if !ok {
		t.Fatal("alice missing from cache")
	}
	if snap.MemMiB != 200 || snap.CPUm != 1500 || snap.CPUPercent != 75 {
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
	if snap.MaxSkillConcurrency != 3 || snap.MaxBrowserConcurrency != 4 ||
		snap.MaxLongTaskConcurrency != 6 {
		t.Errorf("runtime defaults not inherited: %+v", snap)
	}
	if !snap.RuntimeGuardHealthy || snap.SkillActive != 1 || snap.SkillQueued != 2 ||
		snap.RuntimeGeneration != 3 || snap.BrowserActive != 1 || snap.BrowserQueued != 0 {
		t.Errorf("runtime health not aggregated: %+v", snap)
	}

	bob, ok := cache.Get("bob")
	if !ok || bob.EffectiveMemLimit != "2g" {
		t.Errorf("bob should inherit global memory limit: %+v", bob)
	}
}

func TestCollector_CollectOnce_ReconcilesLongTaskSnapshot(t *testing.T) {
	fd := newFakeDriver()
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "alice"})
	fd.longTasksOutput = `{"pools":[{"poolKey":"agent:alice:wecom:direct:wx-1","queued":4,"active":2,"limit":2,` +
		`"agentId":"alice","peerId":"wx-1","tasks":[` +
		`{"taskId":"task-a","skillName":"report-customer","skillRoot":"/skills/report",` +
		`"status":"running","submittedAt":"2026-08-09T10:00:00.000Z",` +
		`"startedAt":"2026-08-09T10:00:01.000Z","updatedAt":"2026-08-09T10:00:01.000Z"}]},` +
		`{"agentId":"bob","peerId":"wx-2","queued":1,"active":0,"tasks":[` +
		`{"id":"task-b","skill":"xdr-query","rootPath":"/skills/xdr",` +
		`"status":"queued","submittedAt":"2026-08-09T10:02:00.000Z",` +
		`"updatedAt":"2026-08-09T10:02:00.000Z"}]}]}`
	source := collectorSource{
		pods: []repo.PodSummary{{Pod: repo.Pod{PodID: "alice", MaxUsers: 10}}},
		users: map[string][]repo.HumanUser{"alice": {
			{HumanUserID: "human-alice", AgentID: "alice"},
			{HumanUserID: "human-bob", AgentID: "bob"},
		}},
	}
	cache := monitor.NewCache()
	defaults := driver.ResourceSpec{
		MemLimit: "1g", CPULimit: "1", RestartPolicy: "unless-stopped",
		MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1, MaxLongTaskConcurrency: 2,
	}

	collector.New(fd, &source, cache, defaults, time.Minute).CollectOnce(context.Background())

	tasks := source.reconciled["alice"]
	if len(tasks) != 2 {
		t.Fatalf("reconciled Long Tasks = %+v", tasks)
	}
	if tasks[0].TaskID != "task-a" || tasks[0].HumanUserID != "human-alice" ||
		tasks[0].PoolKey != "agent:alice:wecom:direct:wx-1" ||
		tasks[0].PoolQueued != 4 || tasks[0].PoolRunning != 2 ||
		tasks[0].PoolLimit != 2 || tasks[0].StartedAt.IsZero() {
		t.Fatalf("primary Long Task not mapped from snapshot: %+v", tasks[0])
	}
	if tasks[1].TaskID != "task-b" || tasks[1].SkillName != "xdr-query" ||
		tasks[1].SkillRoot != "/skills/xdr" || tasks[1].HumanUserID != "human-bob" ||
		tasks[1].PoolKey != "agent:bob:unknown:direct:wx-2" ||
		tasks[1].PoolQueued != 1 || tasks[1].PoolRunning != 0 {
		t.Fatalf("compat Long Task not mapped from snapshot: %+v", tasks[1])
	}
}

func TestCollector_CollectOnce_ReconcilesEmptyLongTaskSnapshot(t *testing.T) {
	fd := newFakeDriver()
	_ = fd.Create(context.Background(), driver.PodSpec{PodID: "alice"})
	source := collectorSource{
		pods: []repo.PodSummary{{Pod: repo.Pod{PodID: "alice", MaxUsers: 10}}},
	}
	defaults := driver.ResourceSpec{
		MemLimit: "1g", CPULimit: "1", RestartPolicy: "unless-stopped",
		MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1, MaxLongTaskConcurrency: 2,
	}

	collector.New(fd, &source, monitor.NewCache(), defaults, time.Minute).CollectOnce(context.Background())

	if tasks, ok := source.reconciled["alice"]; !ok || len(tasks) != 0 {
		t.Fatalf("empty Long Task snapshot should reconcile an empty list: ok=%v tasks=%+v", ok, tasks)
	}
}

func TestMonitorCache_DetachesPerPodChannelMaps(t *testing.T) {
	cache := monitor.NewCache()
	original := map[string]monitor.Snapshot{
		"alice": {
			PodID: "alice", ChannelStatuses: map[string]bool{"wecom": true},
			ChannelDefaultAccountIDs: map[string]string{"wecom": "default"},
		},
		"bob": {
			PodID: "bob", ChannelStatuses: map[string]bool{"wechat": true},
			ChannelDefaultAccountIDs: map[string]string{"wechat": "wx-bot"},
		},
	}
	cache.Replace(original)
	original["alice"].ChannelStatuses["wecom"] = false
	original["alice"].ChannelDefaultAccountIDs["wecom"] = "mutated"
	alice, _ := cache.Get("alice")
	alice.ChannelStatuses["wecom"] = false
	alice.ChannelDefaultAccountIDs["wecom"] = "mutated-again"
	storedAlice, _ := cache.Get("alice")
	storedBob, _ := cache.Get("bob")
	if !storedAlice.ChannelStatuses["wecom"] || !storedBob.ChannelStatuses["wechat"] ||
		storedAlice.ChannelDefaultAccountIDs["wecom"] != "default" ||
		storedBob.ChannelDefaultAccountIDs["wechat"] != "wx-bot" {
		t.Fatal(errors.New("cache snapshots share mutable channel state"))
	}
}

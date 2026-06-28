package test

import (
	"context"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/collector"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/monitor"
)

func TestCollector_CollectOnce_PopulatesCache(t *testing.T) {
	fd := newFakeDriver()
	// two running containers via fake (Create records them)
	_ = fd.Create(context.Background(), driver.UserSpec{UserID: "alice"}, "")
	_ = fd.Create(context.Background(), driver.UserSpec{UserID: "bob"}, "")

	cache := monitor.NewCache()
	c := collector.New(fd, cache, time.Minute)
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
}

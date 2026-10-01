package test

import (
	"context"
	"net/http"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/api"
)

type delayedRuntimeQueue struct {
	*fakeReconcileQueue
	before func()
	calls  int
}

func (q *delayedRuntimeQueue) RunExclusive(ctx context.Context, id string, operation func(context.Context) error) error {
	q.calls++
	if q.before != nil {
		before := q.before
		q.before = nil
		before()
	}
	return q.fakeReconcileQueue.RunExclusive(ctx, id, operation)
}

func TestRuntimeFileConcurrency_S18UpgradeReadsLatest(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	queue := &delayedRuntimeQueue{fakeReconcileQueue: e.reconcile}
	queue.before = func() {
		pod, err := e.store.GetPod("pod-a")
		if err != nil {
			t.Fatal(err)
		}
		update := podUpdateFrom(pod, pod.MaxUsers)
		update.DisplayName = "updated-before-exclusive"
		if err := e.store.UpdatePod("pod-a", update); err != nil {
			t.Fatal(err)
		}
	}
	e.h = api.NewServer(e.cfg, e.store, e.cipher, e.drv, e.cache, e.syncer, queue).Handler()
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:new"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("upgrade failed: %s", rr.Body.String())
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatal(err)
	}
	if pod.DisplayName != "updated-before-exclusive" || pod.ImageTag != "img:new" {
		t.Fatal("queued upgrade overwrote latest metadata")
	}
}

func TestRuntimeFileConcurrency_S18MetadataUsesSameLock(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	queue := &delayedRuntimeQueue{fakeReconcileQueue: e.reconcile}
	queue.before = func() {
		pod, err := e.store.GetPod("pod-a")
		if err != nil {
			t.Fatal(err)
		}
		update := podUpdateFrom(pod, pod.MaxUsers)
		update.ImageTag = "img:upgraded-before-patch"
		if err := e.store.UpdatePod("pod-a", update); err != nil {
			t.Fatal(err)
		}
	}
	e.h = api.NewServer(e.cfg, e.store, e.cipher, e.drv, e.cache, e.syncer, queue).Handler()
	rr := e.do(http.MethodPatch, "/api/v1/containers/pod-a", `{"displayName":"new name"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch failed: %s", rr.Body.String())
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatal(err)
	}
	if queue.calls != 1 || pod.ImageTag != "img:upgraded-before-patch" || pod.DisplayName != "new name" {
		t.Fatal("metadata patch bypassed lifecycle lock or replaced image")
	}
}

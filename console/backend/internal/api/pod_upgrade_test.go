package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

// blockedRuntime implements gateway.Execer（让 Probe 可调用）+ driver.WorkloadBlockedChecker。
type blockedRuntime struct {
	blocked bool
}

func (b *blockedRuntime) Exec(context.Context, string, ...string) (string, error) {
	return "", errors.New("container not running")
}

func (b *blockedRuntime) WorkloadBlocked(context.Context, string) (bool, error) {
	return b.blocked, nil
}

// execOnlyRuntime 只实现 gateway.Execer，不实现 WorkloadBlockedChecker。
type execOnlyRuntime struct{}

func (execOnlyRuntime) Exec(context.Context, string, ...string) (string, error) {
	return "", errors.New("container not running")
}

func TestWaitForPodHealthFailsFastOnBlockedWorkload(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	err := waitForPodHealth(ctx, &blockedRuntime{blocked: true}, "pod-a", 1)
	if err == nil {
		t.Fatal("expected error for blocked workload")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("waitForPodHealth did not fail fast on blocked workload: took %v", elapsed)
	}
}

func TestWaitForPodHealthFallsThroughForNonBlockerRuntime(t *testing.T) {
	// 非 blocker 的 runtime 走原有轮询逻辑（Probe 一直不健康 → ctx 超时返回错误）。
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := waitForPodHealth(ctx, execOnlyRuntime{}, "pod-a", 1); err == nil {
		t.Fatal("expected timeout error for non-blocked runtime")
	}
}

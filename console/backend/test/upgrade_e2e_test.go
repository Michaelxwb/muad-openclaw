package test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// S-01: 默认（allowRollback=true）升级成功，受保护绑定逐条一致。
// 真实边界：管理 HTTP → 临时 SQLite → 真实 builder/renderer（Driver fake）。
func TestUpgradeE2E_S01ProtectedBindingsUnchanged(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	modelID := createLLMModelForAPI(t, e, "alice-model")
	body := `{"displayName":"Alice","agentId":"alice","modelConfigId":"` + modelID + `","identity":{` +
		`"channel":"wecom","accountId":"default","externalId":"XuWenBin","externalIdType":"corp_userid"}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", body), http.StatusCreated)

	before, err := e.store.SnapshotProtectedBindings("pod-a")
	if err != nil {
		t.Fatalf("snapshot before: %v", err)
	}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:new"}`)
	assertStatus(t, rr, http.StatusOK)
	after, err := e.store.SnapshotProtectedBindings("pod-a")
	if err != nil {
		t.Fatalf("snapshot after: %v", err)
	}
	if diff := repo.DiffProtectedBindings(before, after); len(diff) != 0 {
		t.Fatalf("protected bindings changed: %v", diff)
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil || pod.ImageTag != "img:new" || pod.State != repo.PodStateRunning {
		t.Fatalf("upgrade did not converge: %+v err=%v", pod, err)
	}
}

// E-01: 受保护字段在升级过程中被替换 → 必须停 error，不得报绑定完整。
func TestUpgradeE2E_E01BindingDriftStops(t *testing.T) {
	e, user := createDirectHumanUser(t)
	identities, err := e.store.ListIdentitiesByHumanUser(user.HumanUserID)
	if err != nil || len(identities) == 0 {
		t.Fatalf("identity fixture: %v %v", identities, err)
	}
	identityID := identities[0].IdentityID
	e.drv.onReplace = func() {
		_ = e.store.UpdateIdentityStatus(identityID, repo.IdentityStatusDisabled)
	}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade",
		`{"imageTag":"img:bad","allowRollback":false}`)
	assertStatus(t, rr, http.StatusBadGateway)
	if !strings.Contains(rr.Body.String(), `"code":50216`) ||
		!strings.Contains(rr.Body.String(), "protected bindings changed") {
		t.Fatalf("drift must fail closed with a binding diagnostic: %s", rr.Body.String())
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil || pod.State != repo.PodStateError {
		t.Fatalf("pod must stop in error: %+v err=%v", pod, err)
	}
}

// S-09: 升级进行中相关写入口被冻结（40905），完成后恢复。
func TestUpgradeE2E_S09MaintenanceFreezesWrites(t *testing.T) {
	e, user := createDirectHumanUser(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	e.drv.onReplace = func() {
		close(entered)
		<-release
	}
	done := make(chan int, 1)
	go func() {
		rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:new"}`)
		done <- rr.Code
	}()
	<-entered
	frozen := e.do(http.MethodPost, "/api/v1/human-users/"+user.HumanUserID+"/identities",
		`{"channel":"wecom","externalId":"blocked","externalIdType":"corp_userid"}`)
	if !strings.Contains(frozen.Body.String(), `"code":40905`) {
		t.Fatalf("write during maintenance must be frozen: %s", frozen.Body.String())
	}
	close(release)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("upgrade status = %d, want 200", code)
	}
	allowed := e.do(http.MethodPost, "/api/v1/human-users/"+user.HumanUserID+"/identities",
		`{"channel":"wecom","externalId":"allowed","externalIdType":"corp_userid"}`)
	assertStatus(t, allowed, http.StatusCreated)
}

// 跨版本迁移 opt-out：allowRollback=false 时失败停 error、保留目标镜像、不回滚。
func TestUpgradeFailForward_OptOutStopsInError(t *testing.T) {
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	d.replaceErrors = []error{errors.New("migration failed")}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade",
		`{"imageTag":"img:bad","allowRollback":false}`)
	if !strings.Contains(rr.Body.String(), `"code":50216`) {
		t.Fatalf("response = %s, want fail-forward 50216", rr.Body.String())
	}
	if len(d.restored) != 0 {
		t.Fatalf("fail-forward must not restore startup input: %+v", d.restored)
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil || pod.State != repo.PodStateError || pod.ImageTag != "img:bad" {
		t.Fatalf("pod must keep the target image and stop in error: %+v err=%v", pod, err)
	}
	if pod.LastApplyStatus != repo.ApplyStatusFailed {
		t.Fatalf("last_apply_status = %q, want failed", pod.LastApplyStatus)
	}
}

func TestUpgradeFailForward_DoesNotRollback(t *testing.T) {
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	// 第二个错误（本可被回滚消费）必须保持未使用。
	d.replaceErrors = []error{errors.New("migration failed"), nil}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade",
		`{"imageTag":"img:bad","allowRollback":false}`)
	if !strings.Contains(rr.Body.String(), `"code":50216`) {
		t.Fatalf("response = %s, want 50216", rr.Body.String())
	}
	if len(d.replaced) != 0 || len(d.replaceErrors) != 1 {
		t.Fatalf("rollback must not run: replaced=%d unconsumed=%d", len(d.replaced), len(d.replaceErrors))
	}
}

// 原有默认回滚功能保持：不带 allowRollback 时失败仍自动回滚（50205）。
func TestUpgradeRollback_DefaultBehaviorKept(t *testing.T) {
	e, d := runtimeUpgradeEnv(t, driver.RuntimeStartupEnv)
	d.replaceErrors = []error{errors.New("replace failed")}
	rr := e.do(http.MethodPost, "/api/v1/containers/pod-a/upgrade", `{"imageTag":"img:bad"}`)
	if !strings.Contains(rr.Body.String(), `"code":50205`) {
		t.Fatalf("default upgrade must keep automatic rollback: %s", rr.Body.String())
	}
	if len(d.restored) != 1 {
		t.Fatalf("rollback must restore the original startup input: %+v", d.restored)
	}
	pod, err := e.store.GetPod("pod-a")
	if err != nil || pod.State != repo.PodStateRunning || pod.ImageTag != "img:test" {
		t.Fatalf("rollback did not converge: %+v err=%v", pod, err)
	}
}

// 排空边界（2026-10-07 pod02 演练修正）：error 态 Pod 没有可排空的任务，
// drain 必须立即放行——这是"error 态改镜像"修复出口的必经路径。
func TestUpgradeDrain_SkipsForErrorPod(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	if err := e.store.UpdatePodState("pod-a", repo.PodStateError); err != nil {
		t.Fatalf("set pod error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	if err := e.server.WaitForQuiesce(ctx, "pod-a"); err != nil {
		t.Fatalf("error-state drain must be skipped: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("error-state drain skip took %s, want immediate", elapsed)
	}
}

// 无法排空时必须有界退出（不允许无限等待）：fake 探活返回非零在飞任务，
// 排空在 ctx 到期时返回错误。
func TestUpgradeDrain_BoundedWhenNotDrained(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	if err := e.server.WaitForQuiesce(ctx, "pod-a"); err == nil {
		t.Fatal("expected bounded drain failure while tasks are in flight")
	}
}

package driver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRuntimeFileTask010_S15RestoreModes(t *testing.T) {
	for _, mode := range []RuntimeStartupMode{RuntimeStartupEnv, RuntimeStartupFile} {
		t.Run(string(mode), func(t *testing.T) { assertK8sInputRestore(t, mode) })
	}
}

func assertK8sInputRestore(t *testing.T, mode RuntimeStartupMode) {
	t.Helper()
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	if mode == RuntimeStartupEnv {
		snapshot := RuntimeStartupSnapshot{Mode: mode, Environment: BuildEnv(spec)}
		if err := d.RestoreRuntime(ctx, spec, snapshot); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || snapshot.Mode != mode {
		t.Fatalf("snapshot: %v %v", snapshot.Mode, err)
	}
	spec.ImageTag = "worker:broken"
	spec.MultiUser.Generation++
	if err := d.ReplaceRuntime(ctx, spec); err != nil {
		t.Fatal(err)
	}
	spec.ImageTag = "worker:original"
	spec.MultiUser.Generation++
	if err := d.RestoreRuntime(ctx, spec, snapshot); err != nil {
		t.Fatal(err)
	}
	after, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || after.Mode != mode || after.Environment["OPENCLAW_GATEWAY_TOKEN"] != snapshot.Environment["OPENCLAW_GATEWAY_TOKEN"] {
		t.Fatalf("input/token not restored: %v", err)
	}
	var config RuntimeConfigV1
	if err := json.Unmarshal(after.RuntimeJSON, &config); err != nil || config.Generation != spec.MultiUser.Generation {
		t.Fatal("rollback generation did not advance")
	}
	dep, err := d.client.AppsV1().Deployments(d.namespace).Get(ctx, ContainerName(spec.PodID), metav1.GetOptions{})
	if err != nil || dep.Spec.Template.Spec.Containers[0].Image != "worker:original" {
		t.Fatal("wrong restored image")
	}
	if _, err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Get(ctx, ContainerName(spec.PodID)+"-state", metav1.GetOptions{}); err != nil {
		t.Fatal("workspace removed")
	}
}

func TestRuntimeFileTask010_S15DeferredPublicationAndLegacyMaintenance(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	before, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil {
		t.Fatal(err)
	}
	spec.MultiUser.Generation++
	if err := d.UpdateSpec(ctx, spec.PodID, spec); err != nil {
		t.Fatal(err)
	}
	after, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || string(after.RuntimeJSON) != string(before.RuntimeJSON) {
		t.Fatal("UpdateSpec published unverified candidate")
	}
	before.Mode = RuntimeStartupEnv
	if err := d.RestoreRuntime(ctx, spec, before); err != nil {
		t.Fatal(err)
	}
	spec.MultiUser.Generation++
	if err := d.SyncRuntimeConfig(ctx, spec.PodID, spec.MultiUser); err != nil {
		t.Fatal(err)
	}
	after, err = d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || after.Mode != RuntimeStartupEnv || after.Environment["MUAD_RUNTIME_CONFIG"] == "" {
		t.Fatal("legacy maintenance removed env DTO")
	}
}

func TestRuntimeFileTask010_S15OversizedLegacyRecoveryFails(t *testing.T) {
	d := newFakeK8s(t)
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	snapshot, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Mode = RuntimeStartupEnv
	snapshot.Environment["EXISTING_LEGACY_VALUE"] = strings.Repeat("x", 128*1024)
	if err := d.RestoreRuntime(ctx, spec, snapshot); err == nil {
		t.Fatal("unbootable legacy env reported restored")
	}
}

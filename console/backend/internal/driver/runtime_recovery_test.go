package driver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRuntimeFileRecovery_S19MissingK8sWorkload(t *testing.T) {
	for _, mode := range []RuntimeStartupMode{RuntimeStartupEnv, RuntimeStartupFile} {
		t.Run(string(mode), func(t *testing.T) {
			d := newFakeK8s(t)
			ctx := context.Background()
			spec := fileRuntimeSpec(t, "alice")
			if err := d.Create(ctx, spec); err != nil {
				t.Fatal(err)
			}
			if mode == RuntimeStartupEnv {
				if err := d.RestoreRuntime(ctx, spec, RuntimeStartupSnapshot{Mode: mode, Environment: BuildEnv(spec)}); err != nil {
					t.Fatal(err)
				}
			}
			if err := d.client.AppsV1().Deployments(d.namespace).Delete(ctx, ContainerName(spec.PodID), metav1.DeleteOptions{}); err != nil {
				t.Fatal(err)
			}
			snapshot, err := d.SnapshotStartupConfig(ctx, spec.PodID)
			if err != nil || snapshot.Mode != mode {
				t.Fatalf("missing workload lost original mode: %v", err)
			}
			if err := d.RestoreRuntime(ctx, spec, snapshot); err != nil {
				t.Fatal(err)
			}
			after, err := d.SnapshotStartupConfig(ctx, spec.PodID)
			if err != nil || after.Mode != mode {
				t.Fatal("rebuild switched input mode")
			}
		})
	}
}

func TestRuntimeFileRecovery_S19DockerDurableSnapshot(t *testing.T) {
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	d := &DockerDriver{secretDir: t.TempDir()}
	env := BuildEnv(spec)
	entries := []string{}
	for key, value := range env {
		entries = append(entries, key+"="+value)
	}
	raw, err := json.Marshal([]map[string]any{{"Config": map[string]any{"Env": entries, "Image": spec.ImageTag}}})
	if err != nil {
		t.Fatal(err)
	}
	d.runHook = func(context.Context, []string) (string, error) { return string(raw), nil }
	before, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil {
		t.Fatal(err)
	}
	d.runHook = func(context.Context, []string) (string, error) { return "", errors.New("No such container") }
	after, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || after.Mode != RuntimeStartupEnv || string(before.RuntimeJSON) != string(after.RuntimeJSON) {
		t.Fatalf("lost persisted original input: %v", err)
	}
	if after.ImageTag != spec.ImageTag {
		t.Fatal("original image missing from durable snapshot")
	}
	file := filepath.Join(d.secretDir, spec.PodID, "startup-recovery.json")
	assertFileMode(t, file, 0o600)
	if err := os.WriteFile(file, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SnapshotStartupConfig(ctx, spec.PodID); err == nil {
		t.Fatal("corrupt recovery data silently accepted")
	}
}

func TestRuntimeFileRecovery_S19DockerNewContainerMissing(t *testing.T) {
	spec := fileRuntimeSpec(t, "alice")
	spec.ServiceToken.UID, spec.ServiceToken.GID = int64(os.Getuid()), int64(os.Getgid())
	d := &DockerDriver{secretDir: t.TempDir(), runHook: (&dockerCallRecorder{}).run}
	if err := d.Create(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	d.runHook = func(context.Context, []string) (string, error) { return "", errors.New("No such container") }
	snapshot, err := d.SnapshotStartupConfig(context.Background(), spec.PodID)
	if err != nil || snapshot.Mode != RuntimeStartupFile || snapshot.ImageTag != spec.ImageTag {
		t.Fatalf("new file container recovery unavailable: %v", err)
	}
	if err := d.saveStartupRecovery("bob", snapshot); !errors.Is(err, ErrInvalidPodSpec) {
		t.Fatal("cross-Pod recovery source accepted")
	}
	file := filepath.Join(d.secretDir, spec.PodID, "startup-recovery.json")
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SnapshotStartupConfig(context.Background(), spec.PodID); err == nil {
		t.Fatal("world-readable recovery accepted")
	}
}

func TestRuntimeFileRecovery_S19MissingMaterialsFail(t *testing.T) {
	d := &DockerDriver{secretDir: t.TempDir(), runHook: func(context.Context, []string) (string, error) { return "", errors.New("No such container") }}
	if _, err := d.SnapshotStartupConfig(context.Background(), "alice"); err == nil {
		t.Fatal("missing input silently guessed")
	}
	if _, err := d.SnapshotStartupConfig(context.Background(), "../escape"); !errors.Is(err, ErrInvalidPodSpec) {
		t.Fatal("invalid recovery Pod ID accepted")
	}
}

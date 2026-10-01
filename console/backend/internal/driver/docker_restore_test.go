package driver

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestRuntimeFileTask011_S16RestoreModes(t *testing.T) {
	for _, mode := range []RuntimeStartupMode{RuntimeStartupEnv, RuntimeStartupFile} {
		t.Run(string(mode), func(t *testing.T) { assertDockerRecovery(t, mode) })
	}
}

func assertDockerRecovery(t *testing.T, mode RuntimeStartupMode) {
	t.Helper()
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	spec.ServiceToken.UID, spec.ServiceToken.GID = int64(os.Getuid()), int64(os.Getgid())
	d := &DockerDriver{secretDir: t.TempDir(), skillsDir: t.TempDir()}
	recorder := &dockerCallRecorder{}
	d.runHook = recorder.run
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := dockerRecoveryFixture(mode, spec, payload)
	spec.ImageTag = "worker:previous"
	spec.MultiUser.Generation++
	var actualEnv string
	var actualArgs []string
	d.runHook = func(ctx context.Context, args []string) (string, error) {
		if args[0] == "run" {
			actualArgs = append([]string(nil), args...)
			i := slices.Index(args, "--env-file")
			raw, err := os.ReadFile(args[i+1])
			if err != nil {
				return "", err
			}
			actualEnv = string(raw)
		}
		return recorder.run(ctx, args)
	}
	if err := d.RestoreRuntime(ctx, spec, snapshot); err != nil {
		t.Fatal(err)
	}
	assertDockerRestoredInput(t, d, mode, spec, snapshot, actualArgs, actualEnv)
	for _, call := range recorder.calls {
		if len(call) > 1 && call[0] == "volume" && call[1] == "rm" {
			t.Fatal("workspace removed")
		}
	}
}

func TestRuntimeFileTask011_S16SnapshotAndSourceSync(t *testing.T) {
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	spec.ServiceToken.UID, spec.ServiceToken.GID = int64(os.Getuid()), int64(os.Getgid())
	d := &DockerDriver{secretDir: t.TempDir(), skillsDir: t.TempDir()}
	r := &dockerCallRecorder{}
	d.runHook = r.run
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		t.Fatal(err)
	}
	d.runHook = func(ctx context.Context, args []string) (string, error) {
		if args[0] == "inspect" {
			env := []string{}
			for k, v := range payload.Environment {
				env = append(env, k+"="+v)
			}
			raw, err := json.Marshal([]map[string]any{{"Config": map[string]any{"Env": env}, "Mounts": []map[string]any{{"Source": d.runtimeConfigDir(spec.PodID), "Destination": RuntimeConfigDirectory, "RW": false}}}})
			return string(raw), err
		}
		return r.run(ctx, args)
	}
	before, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || before.Mode != RuntimeStartupFile {
		t.Fatalf("snapshot failed: %v", err)
	}
	spec.MultiUser.Generation++
	if err := d.SyncRuntimeConfig(ctx, spec.PodID, spec.MultiUser); err != nil {
		t.Fatal(err)
	}
	after, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || string(after.RuntimeJSON) == string(before.RuntimeJSON) {
		t.Fatal("source not updated")
	}
	if err := d.RestoreStartupConfig(ctx, spec.PodID, before); err != nil {
		t.Fatal(err)
	}
	restored, err := d.SnapshotStartupConfig(ctx, spec.PodID)
	if err != nil || string(restored.RuntimeJSON) != string(before.RuntimeJSON) {
		t.Fatal("last-good source not restored")
	}
}

func TestRuntimeFileTask011_S16RecoveryFailure(t *testing.T) {
	ctx := context.Background()
	spec := fileRuntimeSpec(t, "alice")
	spec.ServiceToken.UID, spec.ServiceToken.GID = int64(os.Getuid()), int64(os.Getgid())
	d := &DockerDriver{secretDir: t.TempDir(), skillsDir: t.TempDir()}
	r := &dockerCallRecorder{}
	d.runHook = r.run
	if err := d.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := RuntimeStartupSnapshot{Mode: RuntimeStartupFile, RuntimeJSON: payload.RuntimeJSON, Environment: payload.Environment}
	d.runHook = func(ctx context.Context, args []string) (string, error) {
		if args[0] == "rename" {
			return "", errors.New("rename rejected")
		}
		return r.run(ctx, args)
	}
	if err := d.RestoreRuntime(ctx, spec, snapshot); err == nil {
		t.Fatal("recovery failure hidden")
	}
	found := false
	for _, call := range r.calls {
		if slices.Equal(call, []string{"rm", "-f", ContainerName(spec.PodID) + ".new"}) {
			found = true
		}
	}
	if !found {
		t.Fatal("temporary container leaked")
	}
}

func dockerRecoveryFixture(mode RuntimeStartupMode, spec PodSpec, payload RuntimeStartupPayload) RuntimeStartupSnapshot {
	env := payload.Environment
	if mode == RuntimeStartupEnv {
		env = BuildEnv(spec)
	}
	return RuntimeStartupSnapshot{Mode: mode, Environment: env, RuntimeJSON: payload.RuntimeJSON}
}

func assertDockerRestoredInput(t *testing.T, d *DockerDriver, mode RuntimeStartupMode, spec PodSpec, snapshot RuntimeStartupSnapshot, actualArgs []string, actualEnv string) {
	t.Helper()
	if actualArgs[len(actualArgs)-1] != "worker:previous" || !slices.Contains(actualArgs, stateVolume(spec.PodID)+":"+d.runtime.withDefaults().StateDir) {
		t.Fatal("image/state not paired")
	}
	if !strings.Contains(actualEnv, "OPENCLAW_GATEWAY_TOKEN="+snapshot.Environment["OPENCLAW_GATEWAY_TOKEN"]) {
		t.Fatal("token rotated")
	}
	if mode == RuntimeStartupFile && (strings.Contains(actualEnv, "MUAD_RUNTIME_CONFIG=") || !slices.Contains(actualArgs, d.runtimeConfigDir(spec.PodID)+":"+RuntimeConfigDirectory+":ro")) {
		t.Fatal("file input not restored")
	}
	if mode == RuntimeStartupEnv && (!strings.Contains(actualEnv, "MUAD_RUNTIME_CONFIG=") || strings.Contains(actualEnv, "MUAD_RUNTIME_CONFIG_FILE=")) {
		t.Fatal("legacy input not restored")
	}
}

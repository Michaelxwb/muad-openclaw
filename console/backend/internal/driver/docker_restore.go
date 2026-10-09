package driver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type dockerStartupInspection struct {
	Config struct {
		Env   []string
		Image string
	}
	Mounts []struct {
		Source, Destination string
		RW                  bool
	}
}

func (d *DockerDriver) SnapshotStartupConfig(ctx context.Context, podID string) (RuntimeStartupSnapshot, error) {
	if !podIDPattern.MatchString(podID) {
		return RuntimeStartupSnapshot{}, ErrInvalidPodSpec
	}
	out, err := d.run(ctx, "inspect", ContainerName(podID))
	if err != nil {
		if isAbsentErr(err) {
			return d.readStartupRecovery(podID)
		}
		return RuntimeStartupSnapshot{}, err
	}
	var inspections []dockerStartupInspection
	if err := json.Unmarshal([]byte(out), &inspections); err != nil {
		return RuntimeStartupSnapshot{}, fmt.Errorf("invalid Docker startup inspection")
	}
	if len(inspections) != 1 {
		return RuntimeStartupSnapshot{}, fmt.Errorf("Docker startup inspection requires one container")
	}
	snapshot, err := d.inspectedStartupConfig(podID, inspections[0])
	if err != nil {
		return RuntimeStartupSnapshot{}, err
	}
	if err := d.saveStartupRecovery(podID, snapshot); err != nil {
		return RuntimeStartupSnapshot{}, err
	}
	return snapshot, nil
}

func (d *DockerDriver) inspectedStartupConfig(podID string, inspection dockerStartupInspection) (RuntimeStartupSnapshot, error) {
	snapshot := RuntimeStartupSnapshot{Mode: RuntimeStartupEnv, ImageTag: inspection.Config.Image, Environment: make(map[string]string)}
	for _, entry := range inspection.Config.Env {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			snapshot.Environment[key] = value
		}
	}
	snapshot.RuntimeJSON = []byte(snapshot.Environment["MUAD_RUNTIME_CONFIG"])
	if snapshot.Environment["MUAD_RUNTIME_CONFIG_FILE"] != "" {
		if snapshot.Environment["MUAD_RUNTIME_CONFIG_FILE"] != RuntimeConfigFilePath {
			return RuntimeStartupSnapshot{}, fmt.Errorf("unexpected Docker runtime config path")
		}
		mounted := false
		for _, mount := range inspection.Mounts {
			if mount.Destination == RuntimeConfigDirectory && sameDockerHostPath(mount.Source, d.runtimeConfigDir(podID)) && !mount.RW {
				mounted = true
			}
		}
		if !mounted {
			return RuntimeStartupSnapshot{}, fmt.Errorf("Docker runtime config mount missing")
		}
		snapshot.Mode = RuntimeStartupFile
		raw, err := os.ReadFile(filepath.Join(d.runtimeConfigDir(podID), RuntimeConfigFileName))
		if err != nil {
			return RuntimeStartupSnapshot{}, fmt.Errorf("read Docker startup source: %w", err)
		}
		snapshot.RuntimeJSON = raw
	}
	return snapshot, nil
}

func (d *DockerDriver) SyncRuntimeConfig(ctx context.Context, podID string, config RuntimeConfigV1) error {
	if config.PodID != podID {
		return ErrInvalidPodSpec
	}
	if err := config.Validate(); err != nil {
		return err
	}
	snapshot, err := d.SnapshotStartupConfig(ctx, podID)
	if err != nil {
		return err
	}
	// Existing Docker environment is immutable; migration requires image upgrade.
	if snapshot.Mode == RuntimeStartupEnv {
		return nil
	}
	uid, gid, err := d.runtimeFileOwner(podID)
	if err != nil {
		return err
	}
	return writeRuntimeFile(d.runtimeConfigDir(podID), config, uid, gid)
}

func (d *DockerDriver) runtimeFileOwner(podID string) (int, int, error) {
	info, err := os.Lstat(filepath.Join(d.runtimeConfigDir(podID), RuntimeConfigFileName))
	if err != nil {
		return 0, 0, fmt.Errorf("inspect Docker startup file owner: %w", err)
	}
	if !info.Mode().IsRegular() {
		return 0, 0, fmt.Errorf("Docker startup source must be a regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, fmt.Errorf("Docker startup file ownership unavailable")
	}
	return int(stat.Uid), int(stat.Gid), nil
}

func (d *DockerDriver) RestoreStartupConfig(ctx context.Context, podID string, snapshot RuntimeStartupSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !podIDPattern.MatchString(podID) {
		return ErrInvalidPodSpec
	}
	if _, err := startupSnapshotEnvironment(snapshot); err != nil {
		return err
	}
	if snapshot.Mode == RuntimeStartupEnv {
		return nil
	}
	uid, gid, err := d.runtimeFileOwner(podID)
	if err != nil {
		return err
	}
	return atomicRuntimeWrite(filepath.Join(d.runtimeConfigDir(podID), RuntimeConfigFileName), snapshot.RuntimeJSON, uid, gid)
}

func (d *DockerDriver) RestoreRuntime(ctx context.Context, spec PodSpec, snapshot RuntimeStartupSnapshot) error {
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		return err
	}
	snapshot.RuntimeJSON = payload.RuntimeJSON
	env, err := startupSnapshotEnvironment(snapshot)
	if err != nil {
		return err
	}
	if err := d.ensureStateVolume(ctx, spec.PodID, true); err != nil {
		return err
	}
	if err := d.ensurePublicSkillsDir(); err != nil {
		return err
	}
	secretPath, err := d.writeServiceToken(spec)
	if err != nil {
		return err
	}
	if snapshot.Mode == RuntimeStartupFile {
		if err := d.writeStartupConfig(ctx, spec); err != nil {
			return err
		}
	} else {
		// Only the recovery path may rebuild an existing env workload.
		spec.MultiUser = RuntimeConfigV1{}
	}
	envFile, cleanup, err := writeEnvFile(env)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := d.replacePreparedContainer(ctx, spec, envFile, secretPath); err != nil {
		return err
	}
	snapshot.ImageTag = spec.ImageTag
	snapshot.Environment = env
	return d.saveStartupRecovery(spec.PodID, snapshot)
}

// Docker Desktop exposes shared macOS paths below /host_mnt.
func sameDockerHostPath(actual, expected string) bool {
	return actual == expected || (strings.HasPrefix(actual, "/host_mnt/") && strings.TrimPrefix(actual, "/host_mnt") == expected)
}

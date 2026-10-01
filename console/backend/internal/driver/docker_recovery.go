package driver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func (d *DockerDriver) saveCreatedStartup(spec PodSpec) error {
	if spec.MultiUser.Version == 0 {
		return nil
	}
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		return err
	}
	return d.saveStartupRecovery(spec.PodID, RuntimeStartupSnapshot{Mode: RuntimeStartupFile, ImageTag: spec.ImageTag, RuntimeJSON: payload.RuntimeJSON, Environment: payload.Environment})
}

func validateStartupRecovery(podID string, snapshot RuntimeStartupSnapshot) error {
	if !podIDPattern.MatchString(podID) {
		return ErrInvalidPodSpec
	}
	if snapshot.Mode != RuntimeStartupEnv && snapshot.Mode != RuntimeStartupFile {
		return fmt.Errorf("invalid startup recovery mode")
	}
	config, err := DecodeRuntimeConfig(bytes.NewReader(snapshot.RuntimeJSON))
	if err != nil {
		return fmt.Errorf("invalid startup recovery DTO")
	}
	if config.PodID != podID {
		return ErrInvalidPodSpec
	}
	return nil
}

func (d *DockerDriver) saveStartupRecovery(podID string, snapshot RuntimeStartupSnapshot) error {
	if err := validateStartupRecovery(podID, snapshot); err != nil {
		return err
	}
	directory := filepath.Join(d.secretDir, podID)
	if err := prepareRuntimeDirectory(directory, os.Getuid(), os.Getgid()); err != nil {
		return err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("serialize startup recovery: %w", err)
	}
	return atomicRuntimeWrite(filepath.Join(directory, "startup-recovery.json"), raw, os.Getuid(), os.Getgid())
}

func (d *DockerDriver) readStartupRecovery(podID string) (RuntimeStartupSnapshot, error) {
	file := filepath.Join(d.secretDir, podID, "startup-recovery.json")
	info, err := os.Lstat(file)
	if err != nil {
		return RuntimeStartupSnapshot{}, fmt.Errorf("startup recovery unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return RuntimeStartupSnapshot{}, fmt.Errorf("startup recovery permissions invalid")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return RuntimeStartupSnapshot{}, fmt.Errorf("read startup recovery: %w", err)
	}
	var snapshot RuntimeStartupSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return snapshot, fmt.Errorf("invalid startup recovery material")
	}
	if err := validateStartupRecovery(podID, snapshot); err != nil {
		return snapshot, err
	}
	return snapshot, nil
}

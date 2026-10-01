package driver

import (
	"context"
	"encoding/json"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func (d *K8sDriver) SnapshotStartupConfig(ctx context.Context, podID string) (RuntimeStartupSnapshot, error) {
	if !podIDPattern.MatchString(podID) {
		return RuntimeStartupSnapshot{}, ErrInvalidPodSpec
	}
	name := ContainerName(podID)
	dep, err := d.client.AppsV1().Deployments(d.namespace).Get(ctx, name, metav1.GetOptions{})
	missing := apierrors.IsNotFound(err)
	if err != nil && !missing {
		return RuntimeStartupSnapshot{}, err
	}
	secret, err := d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-env", metav1.GetOptions{})
	if err != nil {
		return RuntimeStartupSnapshot{}, err
	}
	snapshot := RuntimeStartupSnapshot{Mode: RuntimeStartupEnv, Environment: secretEnvironment(secret)}
	snapshot.RuntimeJSON = []byte(snapshot.Environment["MUAD_RUNTIME_CONFIG"])
	fileMode := !missing && runtimeFileDeployment(dep)
	if missing {
		// A retained legacy env key takes precedence over a partially prepared
		// file Secret. Successful migration removes this key.
		fileMode = snapshot.Environment["MUAD_RUNTIME_CONFIG"] == ""
	}
	if fileMode {
		secret, err = d.client.CoreV1().Secrets(d.namespace).Get(ctx, name+"-runtime-config", metav1.GetOptions{})
		if err != nil {
			return RuntimeStartupSnapshot{}, err
		}
		snapshot.Mode = RuntimeStartupFile
		snapshot.RuntimeJSON = []byte(secretValue(secret, RuntimeConfigFileName))
	}
	if !json.Valid(snapshot.RuntimeJSON) {
		return RuntimeStartupSnapshot{}, fmt.Errorf("runtime recovery source is missing or invalid")
	}
	return snapshot, nil
}

func secretEnvironment(secret *corev1.Secret) map[string]string {
	env := make(map[string]string, len(secret.Data)+len(secret.StringData))
	for key, value := range secret.Data {
		env[key] = string(value)
	}
	for key, value := range secret.StringData {
		env[key] = value
	}
	return env
}

func (d *K8sDriver) SyncRuntimeConfig(ctx context.Context, podID string, config RuntimeConfigV1) error {
	if config.PodID != podID {
		return ErrInvalidPodSpec
	}
	if err := config.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("serialize runtime startup config: %w", err)
	}
	snapshot, err := d.SnapshotStartupConfig(ctx, podID)
	if err != nil {
		return err
	}
	snapshot.RuntimeJSON = raw
	return d.RestoreStartupConfig(ctx, podID, snapshot)
}

func (d *K8sDriver) RestoreStartupConfig(ctx context.Context, podID string, snapshot RuntimeStartupSnapshot) error {
	if !podIDPattern.MatchString(podID) {
		return ErrInvalidPodSpec
	}
	env, err := startupSnapshotEnvironment(snapshot)
	if err != nil {
		return err
	}
	if snapshot.Mode == RuntimeStartupFile {
		if err := d.upsertRuntimeSecret(ctx, podID, snapshot.RuntimeJSON); err != nil {
			return err
		}
	}
	return d.upsertSecret(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: ContainerName(podID) + "-env", Namespace: d.namespace, Labels: d.labels(podID)},
		StringData: env,
	})
}

func startupSnapshotEnvironment(snapshot RuntimeStartupSnapshot) (map[string]string, error) {
	if !json.Valid(snapshot.RuntimeJSON) {
		return nil, fmt.Errorf("invalid runtime startup snapshot JSON")
	}
	env := cloneStringMap(snapshot.Environment)
	if env == nil {
		env = make(map[string]string)
	}
	switch snapshot.Mode {
	case RuntimeStartupFile:
		delete(env, "MUAD_RUNTIME_CONFIG")
		env["MUAD_RUNTIME_CONFIG_FILE"] = RuntimeConfigFilePath
	case RuntimeStartupEnv:
		delete(env, "MUAD_RUNTIME_CONFIG_FILE")
		env["MUAD_RUNTIME_CONFIG"] = string(snapshot.RuntimeJSON)
		if err := validateLegacyRuntimeEnvironment(env); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported runtime startup snapshot mode")
	}
	return env, nil
}

// Linux workers cannot exec a single environment string of 128 KiB or more.
// This limit applies only to restoration of existing env workloads.
func validateLegacyRuntimeEnvironment(env map[string]string) error {
	for key, value := range env {
		if len(key)+len(value)+2 >= 128*1024 {
			return fmt.Errorf("legacy runtime environment cannot be restored: entry exceeds exec limit")
		}
	}
	return nil
}

func (d *K8sDriver) RestoreRuntime(ctx context.Context, spec PodSpec, snapshot RuntimeStartupSnapshot) error {
	payload, err := BuildRuntimeStartupPayload(spec)
	if err != nil {
		return err
	}
	snapshot.RuntimeJSON = payload.RuntimeJSON
	if _, err := startupSnapshotEnvironment(snapshot); err != nil {
		return err
	}
	if err := d.ensureStatePVC(ctx, spec.PodID, true); err != nil {
		return err
	}
	if err := d.RestoreStartupConfig(ctx, spec.PodID, snapshot); err != nil {
		return err
	}
	if err := d.upsertServiceTokenSecret(ctx, spec); err != nil {
		return err
	}
	dep := d.deployment(spec, ContainerName(spec.PodID))
	if snapshot.Mode == RuntimeStartupEnv {
		configureLegacyRuntimeDeployment(dep)
	}
	return d.upsertRuntimeDeployment(ctx, dep)
}

func configureLegacyRuntimeDeployment(dep *appsv1.Deployment) {
	pod := &dep.Spec.Template.Spec
	volumes := pod.Volumes[:0]
	for _, volume := range pod.Volumes {
		if volume.Name != "runtime-config" {
			volumes = append(volumes, volume)
		}
	}
	pod.Volumes = volumes
	c := &pod.Containers[0]
	mounts := c.VolumeMounts[:0]
	for _, mount := range c.VolumeMounts {
		if mount.Name != "runtime-config" {
			mounts = append(mounts, mount)
		}
	}
	c.VolumeMounts = mounts
	env := c.Env[:0]
	for _, value := range c.Env {
		if value.Name != "MUAD_RUNTIME_CONFIG_FILE" && value.ValueFrom == nil {
			env = append(env, value)
		}
	}
	c.Env = env
	c.EnvFrom = []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{
		LocalObjectReference: corev1.LocalObjectReference{Name: dep.Name + "-env"},
	}}}
}

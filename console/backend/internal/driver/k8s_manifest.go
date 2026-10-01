package driver

import (
	"strings"
	"unicode"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func configureRuntimeFileDeployment(dep *appsv1.Deployment, name string) {
	mode := int32(0o440)
	pod := &dep.Spec.Template.Spec
	pod.Volumes = append(pod.Volumes, corev1.Volume{Name: "runtime-config", VolumeSource: corev1.VolumeSource{
		Secret: &corev1.SecretVolumeSource{SecretName: name + "-runtime-config", DefaultMode: &mode,
			Items: []corev1.KeyToPath{{Key: RuntimeConfigFileName, Path: RuntimeConfigFileName, Mode: &mode}}},
	}})
	c := &pod.Containers[0]
	c.VolumeMounts = append(c.VolumeMounts, corev1.VolumeMount{Name: "runtime-config", MountPath: RuntimeConfigDirectory, ReadOnly: true})
	c.EnvFrom = nil
	c.Env = append(c.Env, corev1.EnvVar{Name: "MUAD_RUNTIME_CONFIG_FILE", Value: RuntimeConfigFilePath})
	for _, key := range []string{"MUAD_POD_ID", "CHANNELS", "CHANNEL_CONFIGS", "MUAD_CONSOLE_INTERNAL_URL", "OPENCLAW_GATEWAY_TOKEN", "MUAD_AUTOMATION_URL", "MUAD_AUTH_TOKEN"} {
		c.Env = append(c.Env, corev1.EnvVar{Name: key, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
			LocalObjectReference: corev1.LocalObjectReference{Name: name + "-env"}, Key: key, Optional: ptr(true),
		}}})
	}
}

func serviceTokenVolumes(name string) []corev1.Volume {
	mode := int32(0o440)
	return []corev1.Volume{
		{
			Name: "service-token-runtime",
			VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
				SecretName: name + "-service-token", DefaultMode: &mode,
				Items: []corev1.KeyToPath{{Key: "pod-service-token", Path: "pod-service-token", Mode: &mode}},
			}},
		},
	}
}

// resourceReqs maps the Pod limits to conservative requests and hard limits.
// Requests default to 3 CPU / 8Gi but are clamped down to the resolved limits, so
// requests never exceed limits — Kubernetes rejects any Deployment write with
// requests > limits (e.g. a small pod limited to 2 CPU / 3Gi must request no more).
func resourceReqs(spec PodSpec) corev1.ResourceRequirements {
	cpuRequest := resource.MustParse("3")
	memRequest := resource.MustParse("8Gi")
	limits := corev1.ResourceList{}
	if cpu, err := resource.ParseQuantity(orDefault(spec.Resource.CPULimit, fallbackCPULimit)); err == nil {
		limits[corev1.ResourceCPU] = cpu
		if cpu.Cmp(cpuRequest) < 0 {
			cpuRequest = cpu
		}
	}
	if memory := toK8sMem(orDefault(spec.Resource.MemLimit, fallbackMemLimit)); memory != "" {
		if quantity, err := resource.ParseQuantity(memory); err == nil {
			limits[corev1.ResourceMemory] = quantity
			if quantity.Cmp(memRequest) < 0 {
				memRequest = quantity
			}
		}
	}
	return corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    cpuRequest,
			corev1.ResourceMemory: memRequest,
		},
		Limits: limits,
	}
}

func toK8sMem(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	unitIndex := len(value) - 1
	switch unicode.ToLower(rune(value[unitIndex])) {
	case 'g':
		return value[:unitIndex] + "Gi"
	case 'm':
		return value[:unitIndex] + "Mi"
	case 'k':
		return value[:unitIndex] + "Ki"
	case 'b':
		return value[:unitIndex]
	default:
		return value
	}
}

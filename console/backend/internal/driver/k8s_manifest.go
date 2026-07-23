package driver

import (
	"strings"
	"unicode"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

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
func resourceReqs(spec PodSpec) corev1.ResourceRequirements {
	requests := corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("100m"),
		corev1.ResourceMemory: resource.MustParse("512Mi"),
	}
	limits := corev1.ResourceList{}
	if cpu, err := resource.ParseQuantity(orDefault(spec.Resource.CPULimit, fallbackCPULimit)); err == nil {
		limits[corev1.ResourceCPU] = cpu
	}
	if memory := toK8sMem(orDefault(spec.Resource.MemLimit, fallbackMemLimit)); memory != "" {
		if quantity, err := resource.ParseQuantity(memory); err == nil {
			limits[corev1.ResourceMemory] = quantity
		}
	}
	return corev1.ResourceRequirements{Requests: requests, Limits: limits}
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

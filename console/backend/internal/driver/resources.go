package driver

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ResolveResourceSpec applies Pod override > global > built-in/default limits.
func ResolveResourceSpec(pod, global, fallback ResourceSpec) ResourceSpec {
	return ResourceSpec{
		MemLimit:              firstNonEmpty(pod.MemLimit, global.MemLimit, fallback.MemLimit),
		CPULimit:              firstNonEmpty(pod.CPULimit, global.CPULimit, fallback.CPULimit),
		RestartPolicy:         firstNonEmpty(pod.RestartPolicy, global.RestartPolicy, fallback.RestartPolicy),
		MaxSkillConcurrency:   firstPositive(pod.MaxSkillConcurrency, global.MaxSkillConcurrency, fallback.MaxSkillConcurrency),
		MaxBrowserConcurrency: firstPositive(pod.MaxBrowserConcurrency, global.MaxBrowserConcurrency, fallback.MaxBrowserConcurrency),
	}
}

// MemoryLimitMiB converts a Docker-style binary memory limit to MiB.
func MemoryLimitMiB(value string) (int, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	if len(value) < 2 {
		return 0, fmt.Errorf("invalid memory limit %q", value)
	}
	number, err := strconv.ParseFloat(value[:len(value)-1], 64)
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("invalid memory limit %q", value)
	}
	multiplier, ok := memoryUnitMiB[value[len(value)-1]]
	if !ok {
		return 0, fmt.Errorf("invalid memory unit in %q", value)
	}
	return int(math.Ceil(number * multiplier)), nil
}

var memoryUnitMiB = map[byte]float64{
	'b': 1.0 / 1024 / 1024,
	'k': 1.0 / 1024,
	'm': 1,
	'g': 1024,
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

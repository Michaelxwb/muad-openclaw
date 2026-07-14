package driver

import "fmt"

// New selects a RuntimeDriver by kind ("docker" or "k8s"). For k8s the driver
// connects to the cluster (in-cluster config, else kubeconfig).
func New(
	kind, network, skillsDir string, k8s K8sOptions, runtime RuntimeOptions,
) (RuntimeDriver, error) {
	switch kind {
	case "docker":
		return NewDockerDriver(network, skillsDir, runtime), nil
	case "k8s":
		k8s.Runtime = runtime
		return NewK8sDriver(k8s)
	default:
		return nil, fmt.Errorf("driver: unknown kind %q", kind)
	}
}

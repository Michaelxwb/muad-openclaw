package driver

import "fmt"

// New selects a RuntimeDriver by kind ("docker" or "k8s"). The k8s driver is a
// stub until P1 (RISK-05).
func New(kind, network, skillsDir string) (RuntimeDriver, error) {
	switch kind {
	case "docker":
		return NewDockerDriver(network, skillsDir), nil
	case "k8s":
		return NewK8sDriver(), nil
	default:
		return nil, fmt.Errorf("driver: unknown kind %q", kind)
	}
}

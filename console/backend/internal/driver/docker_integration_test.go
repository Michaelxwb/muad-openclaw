//go:build integration

package driver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDockerIntegration_RetainedStateAndTokenLifecycle(t *testing.T) {
	image := os.Getenv("MUAD_DOCKER_TEST_IMAGE")
	if image == "" {
		t.Skip("MUAD_DOCKER_TEST_IMAGE is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	driver := NewDockerDriver("", "")
	driver.secretDir = t.TempDir()
	podID := "contract-retain-" + time.Now().UTC().Format("150405")
	spec := integrationPodSpec(podID, image, "token-one")
	defer func() { _ = driver.Remove(context.Background(), podID, false) }()

	if err := driver.Create(ctx, spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	assertIntegrationToken(t, driver.secretDir, podID, "token-one")
	if err := driver.UpdateServiceToken(ctx, podID, integrationSecret("token-two")); err != nil {
		t.Fatalf("UpdateServiceToken: %v", err)
	}
	assertIntegrationToken(t, driver.secretDir, podID, "token-two")
	if err := driver.Remove(ctx, podID, true); err != nil {
		t.Fatalf("Remove keepState: %v", err)
	}
	if err := driver.Create(ctx, spec); !errors.Is(err, ErrRetainedState) {
		t.Fatalf("Create retained state error = %v", err)
	}
	spec.AdoptState = true
	if err := driver.Create(ctx, spec); err != nil {
		t.Fatalf("Create adopt state: %v", err)
	}
}

func integrationPodSpec(podID, image, token string) PodSpec {
	return PodSpec{
		PodID: podID, ImageTag: image, ServiceToken: integrationSecret(token),
		Resource: ResourceSpec{RestartPolicy: "no"},
	}
}

func integrationSecret(value string) SecretFileSpec {
	return SecretFileSpec{ContainerPath: PodServiceTokenPath, Value: value, Mode: 0o400, UID: -1, GID: -1}
}

func assertIntegrationToken(t *testing.T, root, podID, expected string) {
	t.Helper()
	path := filepath.Join(root, podID, "pod-service-token")
	content, err := os.ReadFile(path)
	if err != nil || string(content) != expected {
		t.Fatalf("token content error=%v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o400 {
		t.Fatalf("token mode=%v error=%v", infoMode(info), err)
	}
}

func infoMode(info os.FileInfo) os.FileMode {
	if info == nil {
		return 0
	}
	return info.Mode().Perm()
}

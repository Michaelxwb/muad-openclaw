package driver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type dockerCallRecorder struct {
	calls        [][]string
	volumeExists bool
}

func (r *dockerCallRecorder) run(_ context.Context, args []string) (string, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	if len(args) >= 2 && args[0] == "volume" && args[1] == "inspect" {
		if r.volumeExists {
			return "{}", nil
		}
		return "", errors.New("docker volume inspect: no such volume")
	}
	if len(args) >= 2 && args[0] == "volume" && args[1] == "create" {
		r.volumeExists = true
	}
	return "ok", nil
}

func TestDockerCreate_UsesPrivateSecretFileAndReadOnlyMount(t *testing.T) {
	recorder := &dockerCallRecorder{}
	driver := &DockerDriver{
		network: "muad-net", skillsDir: "/skills", secretDir: t.TempDir(), runHook: recorder.run,
	}
	spec := dockerTestPodSpec("pod-a", "token-value")
	if err := driver.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	secretPath := filepath.Join(driver.secretDir, "pod-a", "pod-service-token")
	content, err := os.ReadFile(secretPath)
	if err != nil || string(content) != "token-value" {
		t.Fatalf("read secret = %q, %v", content, err)
	}
	info, err := os.Stat(secretPath)
	if err != nil {
		t.Fatalf("stat secret: %v", err)
	}
	if info.Mode().Perm() != 0o400 {
		t.Fatalf("secret mode = %v, want 0400", info.Mode().Perm())
	}
	runArgs := findDockerCall(t, recorder.calls, "run")
	joined := strings.Join(runArgs, " ")
	if strings.Contains(joined, "token-value") {
		t.Fatalf("docker argv leaked token: %s", joined)
	}
	wantMount := secretPath + ":" + PodServiceTokenPath + ":ro"
	if !slices.Contains(runArgs, wantMount) {
		t.Fatalf("docker run missing read-only token mount %q: %v", wantMount, runArgs)
	}
}

func TestDockerUpdateAndRemove_RotatesThenCleansSecret(t *testing.T) {
	recorder := &dockerCallRecorder{}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "old-token")
	if _, err := driver.writeServiceToken(spec); err != nil {
		t.Fatalf("write initial token: %v", err)
	}
	spec.ServiceToken.Value = "new-token"
	if err := driver.UpdateServiceToken(context.Background(), "pod-a", spec.ServiceToken); err != nil {
		t.Fatalf("UpdateServiceToken: %v", err)
	}
	path := filepath.Join(driver.secretDir, "pod-a", "pod-service-token")
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "new-token" {
		t.Fatalf("rotated secret = %q, %v", content, err)
	}
	if err := driver.Remove(context.Background(), "pod-a", true); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("secret still exists after Remove: %v", err)
	}
}

func TestDockerCreate_RetainedVolumeRequiresExplicitAdopt(t *testing.T) {
	recorder := &dockerCallRecorder{volumeExists: true}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	if err := driver.Create(context.Background(), spec); !errors.Is(err, ErrRetainedState) {
		t.Fatalf("Create without adopt = %v, want ErrRetainedState", err)
	}
	spec.AdoptState = true
	if err := driver.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create with adopt: %v", err)
	}
}

func dockerTestPodSpec(podID, token string) PodSpec {
	return PodSpec{
		PodID: podID, ImageTag: "image:test", GatewayToken: "gateway-token",
		Resource: ResourceSpec{
			MemLimit: "4g", CPULimit: "2", RestartPolicy: DefaultRestartPolicy,
			MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1,
		},
		ServiceToken: SecretFileSpec{
			ContainerPath: PodServiceTokenPath, Value: token, Mode: 0o400,
			UID: int64(os.Getuid()), GID: int64(os.Getgid()),
		},
	}
}

func findDockerCall(t *testing.T, calls [][]string, command string) []string {
	t.Helper()
	for _, call := range calls {
		if len(call) > 0 && call[0] == command {
			return call
		}
	}
	t.Fatalf("docker command %q not found in %v", command, calls)
	return nil
}

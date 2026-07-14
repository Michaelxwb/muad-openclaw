package driver

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
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
	skillsRoot := t.TempDir()
	driver := &DockerDriver{
		network: "muad-net", skillsDir: skillsRoot, secretDir: t.TempDir(), runHook: recorder.run,
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
	wantSkillsMount := filepath.Join(skillsRoot, dockerActivePublicSkillsDir) + ":/opt/openclaw-skills:ro"
	if !slices.Contains(runArgs, wantSkillsMount) {
		t.Fatalf("docker run missing active-only public Skill mount %q: %v", wantSkillsMount, runArgs)
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, dockerActivePublicSkillsDir)); err != nil {
		t.Fatalf("active-only public Skill directory was not created: %v", err)
	}
}

func TestDockerSyncPublicSkills_MirrorsActiveSkillsOnly(t *testing.T) {
	skillsRoot := t.TempDir()
	source := t.TempDir()
	driver := &DockerDriver{skillsDir: skillsRoot}
	writeDockerSkillFile(t, source, "enabled-skill", "SKILL.md", "# enabled\n")
	activeRoot := filepath.Join(skillsRoot, dockerActivePublicSkillsDir)
	writeDockerSkillFile(t, activeRoot, "stale-skill", "SKILL.md", "# stale\n")
	before, err := os.Stat(activeRoot)
	if err != nil {
		t.Fatalf("stat active root before sync: %v", err)
	}

	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	after, err := os.Stat(activeRoot)
	if err != nil {
		t.Fatalf("stat active root after sync: %v", err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("runtime mount directory was replaced instead of updated in place")
	}
	if _, err := os.Stat(filepath.Join(activeRoot, "enabled-skill", "SKILL.md")); err != nil {
		t.Fatalf("enabled Skill was not mirrored: %v", err)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, "stale-skill")); !os.IsNotExist(err) {
		t.Fatalf("stale Skill should be removed from runtime mount: %v", err)
	}
	if _, err := os.Stat(filepath.Join(source, "enabled-skill", "SKILL.md")); err != nil {
		t.Fatalf("source Skill should stay intact: %v", err)
	}
}

func TestBuildPublicSkillsArchive_KeepsManagedIndexSeparateFromActiveFiles(t *testing.T) {
	source := t.TempDir()
	writeDockerSkillFile(t, source, "enabled-skill", "SKILL.md", "# enabled\n")
	if err := os.WriteFile(
		filepath.Join(source, publicSkillIndexFile),
		[]byte("disabled-skill\nenabled-skill\n"),
		0o600,
	); err != nil {
		t.Fatalf("write managed index: %v", err)
	}

	payload, err := buildPublicSkillsArchive(source)
	if err != nil {
		t.Fatalf("buildPublicSkillsArchive: %v", err)
	}
	files := readPublicSkillArchive(t, payload)
	if files[publicSkillIndexFile] != "disabled-skill\nenabled-skill\n" {
		t.Fatalf("managed index = %q", files[publicSkillIndexFile])
	}
	if files["enabled-skill/SKILL.md"] != "# enabled\n" {
		t.Fatalf("enabled Skill file = %q", files["enabled-skill/SKILL.md"])
	}
	if _, exists := files["disabled-skill/SKILL.md"]; exists {
		t.Fatal("disabled Skill files should not be included in active archive")
	}
}

func TestDockerPublicSkillsStorageStatusReadyBeforeRuntimeDirExists(t *testing.T) {
	driver := &DockerDriver{skillsDir: t.TempDir()}
	status, err := driver.PublicSkillsStorageStatus(context.Background())
	if err != nil {
		t.Fatalf("PublicSkillsStorageStatus: %v", err)
	}
	if !status.Configured || !status.Ready || status.Phase != "Pending" {
		t.Fatalf("unexpected Docker public Skill status: %+v", status)
	}
}

func readPublicSkillArchive(t *testing.T, payload []byte) map[string]string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("open gzip: %v", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	files := map[string]string{}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return files
		}
		if err != nil {
			t.Fatalf("read tar: %v", err)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		body, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read tar body: %v", err)
		}
		files[header.Name] = string(body)
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
			MemLimit: "4g", CPULimit: "2", RestartPolicy: "unless-stopped",
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

func writeDockerSkillFile(t *testing.T, root, skillName, fileName, body string) {
	t.Helper()
	dir := filepath.Join(root, skillName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir Skill %s: %v", skillName, err)
	}
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(body), 0o600); err != nil {
		t.Fatalf("write Skill %s: %v", skillName, err)
	}
}

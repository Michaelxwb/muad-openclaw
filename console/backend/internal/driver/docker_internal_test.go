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
	writeDockerSkillFile(t, activeRoot, "manual-skill", "SKILL.md", "# manual\n")
	if err := os.WriteFile(
		filepath.Join(activeRoot, publicSkillIndexFile),
		[]byte("stale-skill\n"),
		0o600,
	); err != nil {
		t.Fatalf("write previous public Skill index: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(source, PublicSkillRemoveIndexFile),
		[]byte("stale-skill\n"),
		0o600,
	); err != nil {
		t.Fatalf("write public Skill remove index: %v", err)
	}
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
	if _, err := os.Stat(filepath.Join(activeRoot, "manual-skill", "SKILL.md")); err != nil {
		t.Fatalf("unmanaged Skill should be preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(source, "enabled-skill", "SKILL.md")); err != nil {
		t.Fatalf("source Skill should stay intact: %v", err)
	}
}

func TestDockerSyncPublicSkills_PreservesMissingManagedSkillUnlessRemoved(t *testing.T) {
	skillsRoot := t.TempDir()
	source := t.TempDir()
	driver := &DockerDriver{skillsDir: skillsRoot}
	activeRoot := filepath.Join(skillsRoot, dockerActivePublicSkillsDir)
	writeDockerSkillFile(t, source, "good-skill", "SKILL.md", "# good\n")
	writeDockerSkillFile(t, activeRoot, "bad-skill", "SKILL.md", "# last-good\n")
	if err := os.WriteFile(
		filepath.Join(source, publicSkillIndexFile),
		[]byte("bad-skill\ngood-skill\n"),
		0o600,
	); err != nil {
		t.Fatalf("write public Skill index: %v", err)
	}

	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(activeRoot, "bad-skill", "SKILL.md"))
	if err != nil {
		t.Fatalf("bad Skill last-good should be preserved: %v", err)
	}
	if string(body) != "# last-good\n" {
		t.Fatalf("bad Skill body = %q, want last-good", body)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, "good-skill", "SKILL.md")); err != nil {
		t.Fatalf("good Skill was not published: %v", err)
	}
}

func TestDockerSyncPublicSkills_CleansVisibleSyncArtifacts(t *testing.T) {
	skillsRoot := t.TempDir()
	source := t.TempDir()
	driver := &DockerDriver{skillsDir: skillsRoot}
	activeRoot := filepath.Join(skillsRoot, dockerActivePublicSkillsDir)
	writeDockerSkillFile(t, source, "enabled-skill", "SKILL.md", "# enabled\n")
	writeDockerSkillFile(t, activeRoot, ".muad-sync-left", "SKILL.md", "# staging\n")
	writeDockerSkillFile(t, activeRoot, ".muad-old-stale-skill-left", "SKILL.md", "# backup\n")
	writeDockerSkillFile(t, activeRoot, ".manual.muad-old-left", "SKILL.md", "# keep\n")
	if err := os.WriteFile(filepath.Join(activeRoot, ".muad-public-index.muad-new"), []byte("old"), 0o600); err != nil {
		t.Fatalf("write stale staged index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(activeRoot, ".custom.muad-new"), []byte("keep"), 0o600); err != nil {
		t.Fatalf("write non-artifact hidden file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillsRoot, ".muad-public-signature.muad-new-left"), []byte("old"), 0o600); err != nil {
		t.Fatalf("write parent staged metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillsRoot, ".custom.muad-new-left"), []byte("keep"), 0o600); err != nil {
		t.Fatalf("write parent non-artifact hidden file: %v", err)
	}

	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	for _, name := range []string{".muad-sync-left", ".muad-old-stale-skill-left", ".muad-public-index.muad-new"} {
		if _, err := os.Stat(filepath.Join(activeRoot, name)); !os.IsNotExist(err) {
			t.Fatalf("sync artifact %s should be removed, stat err=%v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, ".muad-public-signature.muad-new-left")); !os.IsNotExist(err) {
		t.Fatalf("parent sync artifact should be removed, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, ".manual.muad-old-left")); err != nil {
		t.Fatalf("non-artifact backup-like directory should be preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, ".custom.muad-new")); err != nil {
		t.Fatalf("non-artifact new-like file should be preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(skillsRoot, ".custom.muad-new-left")); err != nil {
		t.Fatalf("parent non-artifact new-like file should be preserved: %v", err)
	}
}

func TestReplacePublicSkillEntryRestoresBackupWhenPublishFails(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "active", "report-skill")
	writeDockerSkillFile(t, filepath.Dir(target), filepath.Base(target), "SKILL.md", "# old\n")

	err := replacePublicSkillEntry(filepath.Join(root, "missing-source"), target, root)
	if err == nil || !strings.Contains(err.Error(), "publish public Skill") {
		t.Fatalf("replacePublicSkillEntry error = %v, want publish failure", err)
	}
	body, err := os.ReadFile(filepath.Join(target, "SKILL.md"))
	if err != nil {
		t.Fatalf("old target was not restored: %v", err)
	}
	if string(body) != "# old\n" {
		t.Fatalf("restored target body = %q", body)
	}
}

func TestDockerPublicSkillFilesSignatureDetectsMissingActiveSkill(t *testing.T) {
	skillsRoot := t.TempDir()
	source := t.TempDir()
	driver := &DockerDriver{skillsDir: skillsRoot}
	writeDockerSkillFile(t, source, "enabled-skill", "SKILL.md", "# enabled\n")
	for name, body := range map[string]string{
		publicSkillIndexFile:       "enabled-skill\n",
		PublicSkillActiveIndexFile: "enabled-skill\n",
		PublicSkillSignatureFile:   "sha256:published\n",
	} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write source metadata %s: %v", name, err)
		}
	}
	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	signature, err := driver.PublicSkillFilesSignature(context.Background())
	if err != nil || signature != "sha256:published" {
		t.Fatalf("PublicSkillFilesSignature = %q, %v", signature, err)
	}

	if err := os.RemoveAll(filepath.Join(skillsRoot, dockerActivePublicSkillsDir, "enabled-skill")); err != nil {
		t.Fatalf("remove active Skill: %v", err)
	}
	signature, err = driver.PublicSkillFilesSignature(context.Background())
	if err != nil || signature != "" {
		t.Fatalf("missing active Skill signature = %q, %v; want empty", signature, err)
	}

	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("resync public Skills: %v", err)
	}
	if err := os.Remove(filepath.Join(skillsRoot, dockerActivePublicSkillsDir, PublicSkillActiveIndexFile)); err != nil {
		t.Fatalf("remove active index: %v", err)
	}
	signature, err = driver.PublicSkillFilesSignature(context.Background())
	if err != nil || signature != "" {
		t.Fatalf("missing active index signature = %q, %v; want empty", signature, err)
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

func TestDockerExec_MapsRuntimeReadinessErrors(t *testing.T) {
	driver := &DockerDriver{runHook: func(_ context.Context, args []string) (string, error) {
		if !slices.Equal(args, []string{"exec", ContainerName("pod-a"), "true"}) {
			t.Fatalf("unexpected docker args: %v", args)
		}
		return "", errors.New("Error response from daemon: Container abc is not running")
	}}
	if _, err := driver.Exec(context.Background(), "pod-a", "true"); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("Exec error = %v, want ErrRuntimeNotReady", err)
	}
}

func TestDockerExecStdin_MapsMissingContainerToRuntimeNotReady(t *testing.T) {
	err := dockerExecRuntimeError(errors.New("docker exec: exit status 1: No such container: muad-oc-pod-a"))
	if !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("ExecStdin error = %v, want ErrRuntimeNotReady", err)
	}
}

func dockerTestPodSpec(podID, token string) PodSpec {
	return PodSpec{
		PodID: podID, ImageTag: "image:test", GatewayToken: "gateway-token",
		Resource: ResourceSpec{
			MemLimit: "4g", CPULimit: "2", RestartPolicy: "unless-stopped",
			MaxSkillConcurrency: 1, MaxBrowserConcurrency: 1, MaxLongTaskConcurrency: 2,
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

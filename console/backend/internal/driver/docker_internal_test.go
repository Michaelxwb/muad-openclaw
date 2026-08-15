package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type dockerCallRecorder struct {
	calls        [][]string
	volumeExists bool
	nameExists   bool // simulate a same-name container left behind (crash window)
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
	if len(args) >= 2 && args[0] == "ps" {
		if r.nameExists {
			return "muad-oc-pod-a\n", nil
		}
		return "", nil
	}
	if len(args) >= 2 && args[0] == "rm" {
		r.nameExists = false
	}
	return "ok", nil
}

// dockerSequenceRecorder returns the recorded docker command sequence in order
// and can fail a specific command once.
type dockerSequenceRecorder struct {
	calls       [][]string
	failCommand string // command (args[0]) that fails when encountered
}

func (r *dockerSequenceRecorder) run(_ context.Context, args []string) (string, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	if r.failCommand != "" && args[0] == r.failCommand {
		return "", errors.New("docker " + args[0] + ": simulated failure")
	}
	if len(args) >= 2 && args[0] == "volume" && args[1] == "inspect" {
		return "", errors.New("docker volume inspect: no such volume")
	}
	if len(args) >= 2 && args[0] == "ps" {
		return "", nil
	}
	return "ok", nil
}

// dockerListRecorder serves a fixed `docker ps --format {{json .}}` payload.
type dockerListRecorder struct {
	lines string
}

func (r *dockerListRecorder) run(_ context.Context, args []string) (string, error) {
	if len(args) >= 2 && args[0] == "ps" {
		return r.lines, nil
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
	if _, err := os.Stat(filepath.Join(activeRoot, "manual-skill")); !os.IsNotExist(err) {
		t.Fatalf("unmanaged Skill should be removed by convergence: %v", err)
	}
	if _, err := os.Stat(filepath.Join(source, "enabled-skill", "SKILL.md")); err != nil {
		t.Fatalf("source Skill should stay intact: %v", err)
	}
}

func TestDockerSyncPublicSkills_RemovesUnmanagedDirectories(t *testing.T) {
	skillsRoot := t.TempDir()
	source := t.TempDir()
	driver := &DockerDriver{skillsDir: skillsRoot}
	activeRoot := filepath.Join(skillsRoot, dockerActivePublicSkillsDir)
	writeDockerSkillFile(t, source, "managed-skill", "SKILL.md", "# managed\n")
	writeDockerSkillFile(t, activeRoot, "orphan-skill", "SKILL.md", "# orphan\n")
	if err := os.WriteFile(
		filepath.Join(source, publicSkillIndexFile),
		[]byte("managed-skill\n"),
		0o600,
	); err != nil {
		t.Fatalf("write public Skill index: %v", err)
	}

	if err := driver.SyncPublicSkills(context.Background(), "pod-a", source); err != nil {
		t.Fatalf("SyncPublicSkills: %v", err)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, "managed-skill", "SKILL.md")); err != nil {
		t.Fatalf("managed Skill was not published: %v", err)
	}
	if _, err := os.Stat(filepath.Join(activeRoot, "orphan-skill")); !os.IsNotExist(err) {
		t.Fatalf("unmanaged directory should be deleted: %v", err)
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

func TestDockerCreate_RemovesConflictingContainerFirst(t *testing.T) {
	recorder := &dockerCallRecorder{nameExists: true}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	if err := driver.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create with same-name container: %v", err)
	}
	rmIndex := findDockerCallIndex(t, recorder.calls, "rm")
	runIndex := findDockerCallIndex(t, recorder.calls, "run")
	if rmIndex == -1 || runIndex == -1 || rmIndex >= runIndex {
		t.Fatalf("expected rm -f before run, calls=%v", recorder.calls)
	}
	if !slices.Contains(recorder.calls[rmIndex], ContainerName("pod-a")) {
		t.Fatalf("rm call did not target %s: %v", ContainerName("pod-a"), recorder.calls[rmIndex])
	}
}

func TestDockerCreate_LeavesFreshNameAlone(t *testing.T) {
	recorder := &dockerCallRecorder{}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	if err := driver.Create(context.Background(), spec); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if findDockerCallIndex(t, recorder.calls, "rm") != -1 {
		t.Fatalf("fresh Create must not remove containers: %v", recorder.calls)
	}
}

func TestDockerReplaceRuntime_KeepsOldContainerWhenCreateFails(t *testing.T) {
	recorder := &dockerSequenceRecorder{failCommand: "run"}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	err := driver.ReplaceRuntime(context.Background(), spec)
	if err == nil || !strings.Contains(err.Error(), "simulated failure") {
		t.Fatalf("ReplaceRuntime error = %v, want create failure", err)
	}
	for _, call := range recorder.calls {
		if call[0] == "rm" || call[0] == "rename" {
			t.Fatalf("old container must be preserved on create failure, got call %v", call)
		}
	}
}

func TestDockerReplaceRuntime_SwapsContainerAfterSuccessfulCreate(t *testing.T) {
	recorder := &dockerSequenceRecorder{}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	if err := driver.ReplaceRuntime(context.Background(), spec); err != nil {
		t.Fatalf("ReplaceRuntime: %v", err)
	}
	runIndex := findDockerCallIndex(t, recorder.calls, "run")
	rmIndex := findDockerCallIndex(t, recorder.calls, "rm")
	renameIndex := findDockerCallIndex(t, recorder.calls, "rename")
	if runIndex == -1 || rmIndex == -1 || renameIndex == -1 {
		t.Fatalf("expected run + rm + rename sequence, calls=%v", recorder.calls)
	}
	if !(runIndex < rmIndex && rmIndex < renameIndex) {
		t.Fatalf("order must be run < rm < rename, calls=%v", recorder.calls)
	}
	if !slices.Contains(recorder.calls[runIndex], ContainerName("pod-a")+".new") {
		t.Fatalf("create must target temporary name %s.new: %v", ContainerName("pod-a"), recorder.calls[runIndex])
	}
	if !slices.Contains(recorder.calls[rmIndex], ContainerName("pod-a")) {
		t.Fatalf("rm must target old container: %v", recorder.calls[rmIndex])
	}
	if !slices.Contains(recorder.calls[renameIndex], ContainerName("pod-a")+".new") ||
		!slices.Contains(recorder.calls[renameIndex], ContainerName("pod-a")) {
		t.Fatalf("rename must move %s.new to %s: %v", ContainerName("pod-a"), ContainerName("pod-a"), recorder.calls[renameIndex])
	}
}

func TestDockerReplaceRuntime_CleansTemporaryContainerWhenRenameFails(t *testing.T) {
	recorder := &dockerSequenceRecorder{failCommand: "rename"}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: recorder.run}
	spec := dockerTestPodSpec("pod-a", "token")
	err := driver.ReplaceRuntime(context.Background(), spec)
	if err == nil || !strings.Contains(err.Error(), "simulated failure") {
		t.Fatalf("ReplaceRuntime error = %v, want rename failure", err)
	}
	cleanupFound := false
	for _, call := range recorder.calls {
		if call[0] == "rm" && slices.Contains(call, ContainerName("pod-a")+".new") {
			cleanupFound = true
		}
	}
	if !cleanupFound {
		t.Fatalf("temporary container was not cleaned up after rename failure: %v", recorder.calls)
	}
}

func TestDockerReplaceRuntime_CleansStaleTemporaryContainerBeforeCreate(t *testing.T) {
	recorder := &dockerSequenceRecorder{}
	driver := &DockerDriver{secretDir: t.TempDir(), runHook: func(_ context.Context, args []string) (string, error) {
		recorder.calls = append(recorder.calls, append([]string(nil), args...))
		if len(args) >= 2 && args[0] == "ps" {
			return ContainerName("pod-a") + ".new\n", nil // stale temp container exists
		}
		if len(args) >= 2 && args[0] == "volume" && args[1] == "inspect" {
			return "", errors.New("docker volume inspect: no such volume")
		}
		return "ok", nil
	}}
	if err := driver.ReplaceRuntime(context.Background(), dockerTestPodSpec("pod-a", "token")); err != nil {
		t.Fatalf("ReplaceRuntime: %v", err)
	}
	rmIndex := findDockerCallIndex(t, recorder.calls, "rm")
	if rmIndex == -1 || !slices.Contains(recorder.calls[rmIndex], ContainerName("pod-a")+".new") {
		t.Fatalf("stale temporary container was not removed before create: %v", recorder.calls)
	}
}

func TestDockerList_IgnoresReplaceRuntimeTemporaryContainer(t *testing.T) {
	recorder := &dockerListRecorder{lines: `{"Names":"muad-oc-pod-a","State":"running"}` + "\n" +
		`{"Names":"muad-oc-pod-b.new","State":"running"}` + "\n" +
		`{"Names":"muad-oc-pod-c","State":"exited"}` + "\n"}
	driver := &DockerDriver{runHook: recorder.run}
	infos, err := driver.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var podIDs []string
	for _, info := range infos {
		podIDs = append(podIDs, info.PodID)
	}
	slices.Sort(podIDs)
	if fmt.Sprint(podIDs) != "[pod-a pod-c]" {
		t.Fatalf("List Pod IDs = %v, want [pod-a pod-c] (no .new phantom)", podIDs)
	}
}

func findDockerCallIndex(t *testing.T, calls [][]string, command string) int {
	t.Helper()
	for index, call := range calls {
		if len(call) > 0 && call[0] == command {
			return index
		}
	}
	return -1
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

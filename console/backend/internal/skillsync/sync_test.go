package skillsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestSyncPublicSkipsOnlyWhenMemoryAndDiskSignatureMatch(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	asset := syncTestPublicAsset(t, root, "report-skill", "sha256:one")
	store.assets = append(store.assets, asset)
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)

	result, err := syncer.SyncPublic(context.Background())
	if err != nil || !result.HasPublic {
		t.Fatalf("SyncPublic first = %+v, %v", result, err)
	}
	if drv.publicSyncs != 1 || drv.publicSignature == "" {
		t.Fatalf("first sync did not publish signature: syncs=%d sig=%q", drv.publicSyncs, drv.publicSignature)
	}

	if _, err := syncer.SyncPublic(context.Background()); err != nil {
		t.Fatalf("SyncPublic second: %v", err)
	}
	if drv.publicSyncs != 1 {
		t.Fatalf("same signature should skip file sync, got %d syncs", drv.publicSyncs)
	}

	if _, err := syncer.SyncPublicForced(context.Background()); err != nil {
		t.Fatalf("SyncPublicForced with same signature: %v", err)
	}
	if drv.publicSyncs != 2 {
		t.Fatalf("forced sync should republish files, got %d syncs", drv.publicSyncs)
	}

	drv.publicSignature = ""
	if _, err := syncer.SyncPublic(context.Background()); err != nil {
		t.Fatalf("SyncPublic after missing disk signature: %v", err)
	}
	if drv.publicSyncs != 3 {
		t.Fatalf("missing disk signature should force resync, got %d syncs", drv.publicSyncs)
	}
}

func TestSyncPublicPublishesValidSkillsBeforeReportingInvalidAsset(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	good := syncTestPublicAsset(t, root, "good-skill", "sha256:good")
	bad := good
	bad.SkillID = "skill-bad"
	bad.Name = "bad-skill"
	bad.SourcePath = filepath.Join(root, "missing-bad-skill")
	store.assets = append(store.assets, good, bad)
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)

	result, err := syncer.SyncPublic(context.Background())
	if err != nil || !result.HasPublic {
		t.Fatalf("SyncPublic invalid asset = %+v/%v, want published with warning", result, err)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "1 个 Public Skill 同步失败") {
		t.Fatalf("SyncPublic warnings = %v", result.Warnings)
	}
	if drv.publicSyncs != 1 {
		t.Fatalf("public sync calls = %d, want 1", drv.publicSyncs)
	}
	if got := strings.Join(drv.publicNames, ","); got != "good-skill" {
		t.Fatalf("published public Skills = %q, want good-skill", got)
	}
	if drv.publicActiveIndex != "good-skill\n" {
		t.Fatalf("active public index = %q", drv.publicActiveIndex)
	}
	if drv.publicManagedIndex != "bad-skill\ngood-skill\n" {
		t.Fatalf("managed public index = %q", drv.publicManagedIndex)
	}
	if drv.publicRemoveIndex != "" {
		t.Fatalf("remove public index = %q, want empty for failed active Skill", drv.publicRemoveIndex)
	}
	if syncer.publicSignature != "" {
		t.Fatalf("partial public sync must not set desired signature, got %q", syncer.publicSignature)
	}
	if syncer.publicFailSnapshot == "" || syncer.publicFailAt.IsZero() {
		t.Fatal("partial public sync should record a failure snapshot")
	}
}

func TestSyncPublicPartialFailureCooldownSkipsSameSnapshot(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	good := syncTestPublicAsset(t, root, "good-skill", "sha256:good")
	bad := good
	bad.SkillID = "skill-bad"
	bad.Name = "bad-skill"
	bad.SourcePath = filepath.Join(root, "missing-bad-skill")
	store.assets = append(store.assets, good, bad)
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)

	result, err := syncer.SyncPublic(context.Background())
	if err != nil || len(result.Warnings) != 1 {
		t.Fatalf("first SyncPublic = %+v, %v", result, err)
	}
	if drv.publicSyncs != 1 {
		t.Fatalf("first SyncPublic calls = %d, want 1", drv.publicSyncs)
	}

	result, err = syncer.SyncPublic(context.Background())
	if err != nil || !result.HasPublic || len(result.Warnings) != 1 {
		t.Fatalf("cooldown SyncPublic = %+v, %v", result, err)
	}
	if drv.publicSyncs != 1 {
		t.Fatalf("same failed snapshot should not republish during cooldown, got %d calls", drv.publicSyncs)
	}

	store.assets[1].ManifestHash = "sha256:bad-updated"
	if _, err := syncer.SyncPublic(context.Background()); err != nil {
		t.Fatalf("changed snapshot SyncPublic: %v", err)
	}
	if drv.publicSyncs != 2 {
		t.Fatalf("changed failed snapshot should republish immediately, got %d calls", drv.publicSyncs)
	}

	if _, err := syncer.SyncPublicForced(context.Background()); err != nil {
		t.Fatalf("forced SyncPublic: %v", err)
	}
	if drv.publicSyncs != 3 {
		t.Fatalf("forced sync should bypass cooldown, got %d calls", drv.publicSyncs)
	}
}

func TestSyncPublicWritesRemoveIndexForDisabledAndDeletedSkills(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	active := syncTestPublicAsset(t, root, "active-skill", "sha256:active")
	disabled := syncTestPublicAsset(t, root, "disabled-skill", "sha256:disabled")
	disabled.Status = repo.SkillStatusDisabled
	deleted := syncTestPublicAsset(t, root, "deleted-skill", "sha256:deleted")
	deleted.Status = repo.SkillStatusDeleted
	store.assets = append(store.assets, active, disabled, deleted)
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)

	result, err := syncer.SyncPublic(context.Background())
	if err != nil || !result.HasPublic {
		t.Fatalf("SyncPublic = %+v, %v", result, err)
	}
	if drv.publicRemoveIndex != "deleted-skill\ndisabled-skill\n" {
		t.Fatalf("remove public index = %q", drv.publicRemoveIndex)
	}
	if got := strings.Join(drv.publicNames, ","); got != "active-skill" {
		t.Fatalf("published public Skills = %q, want active-skill", got)
	}
}

func TestSyncPublicLockHonorsContext(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.assets = append(store.assets, syncTestPublicAsset(t, root, "locked-skill", "sha256:locked"))
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)
	syncer.publicSyncLockTimeout = time.Millisecond
	syncer.publicLock <- struct{}{}
	defer func() { <-syncer.publicLock }()

	_, err := syncer.SyncPublic(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SyncPublic locked error = %v, want context deadline", err)
	}
	if drv.publicSyncs != 0 {
		t.Fatalf("locked sync should not publish files, got %d calls", drv.publicSyncs)
	}
}

func TestSyncPodSkipsPublicSyncLockWhenDesiredDiskStateExists(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.assets = append(store.assets, syncTestPublicAsset(t, root, "published-skill", "sha256:published"))
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)
	snapshot, err := syncer.publicSkillSnapshotForSync()
	if err != nil {
		t.Fatalf("public snapshot: %v", err)
	}
	drv.publicSignature = snapshot.Signature
	syncer.publicLock <- struct{}{}
	defer func() { <-syncer.publicLock }()

	if err := syncer.SyncPod(context.Background(), "pod-a"); err != nil {
		t.Fatalf("SyncPod with busy public lock and disk state: %v", err)
	}
	if drv.publicSyncs != 0 {
		t.Fatalf("busy hook path should not republish public files, got %d calls", drv.publicSyncs)
	}
	if fmt.Sprint(drv.publicMountPodID) != "[pod-a]" {
		t.Fatalf("public mount pods = %v, want pod-a", drv.publicMountPodID)
	}
}

func TestSyncPodWaitsForPublicLockWhenDiskStateIsStale(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.assets = append(store.assets, syncTestPublicAsset(t, root, "published-skill", "sha256:published"))
	drv := &syncTestDriver{publicSignature: "sha256:last-good"}
	syncer := newSyncTestSyncer(t, store, drv, root)
	syncer.publicSyncLockTimeout = time.Millisecond
	syncer.publicLock <- struct{}{}
	defer func() { <-syncer.publicLock }()

	err := syncer.SyncPod(context.Background(), "pod-a")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SyncPod locked with stale disk state = %v, want context deadline", err)
	}
	if drv.publicSyncs != 0 || len(drv.publicMountPodID) != 0 {
		t.Fatalf("stale state should not publish or mount after lock timeout: syncs=%d mounts=%v",
			drv.publicSyncs, drv.publicMountPodID)
	}
}

func TestSyncPodWaitsForPublicLockWithoutDiskState(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.assets = append(store.assets, syncTestPublicAsset(t, root, "first-skill", "sha256:first"))
	drv := &syncTestDriver{}
	syncer := newSyncTestSyncer(t, store, drv, root)
	syncer.publicSyncLockTimeout = time.Millisecond
	syncer.publicLock <- struct{}{}
	defer func() { <-syncer.publicLock }()

	err := syncer.SyncPod(context.Background(), "pod-a")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SyncPod locked without disk state = %v, want context deadline", err)
	}
	if drv.publicSyncs != 0 || len(drv.publicMountPodID) != 0 {
		t.Fatalf("first sync should not publish or mount after lock timeout: syncs=%d mounts=%v",
			drv.publicSyncs, drv.publicMountPodID)
	}
}

func TestSyncPodSkipsUnchangedPrivateSkillInstall(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.users["user-a"] = repo.HumanUser{HumanUserID: "user-a", AgentID: "alice", PodID: "pod-a"}
	asset := syncTestPrivateAsset(t, root, "user-a", "pod-a", "stable-skill", repo.SkillStatusActive, "sha256:stable")
	store.assets = append(store.assets, asset)
	drv := &syncTestDriver{privateHashes: map[string]map[string]string{
		"alice": {"stable-skill": "sha256:stable"},
	}}
	syncer := newSyncTestSyncer(t, store, drv, root)

	if err := syncer.SyncPod(context.Background(), "pod-a"); err != nil {
		t.Fatalf("SyncPod: %v", err)
	}
	if len(drv.privateInstalls) != 0 {
		t.Fatalf("unchanged private Skill should not reinstall: %v", drv.privateInstalls)
	}
}

func TestSyncPodDeletesStalePrivateSkillPerUserName(t *testing.T) {
	store := newSyncTestStore()
	root := t.TempDir()
	store.users["user-a"] = repo.HumanUser{HumanUserID: "user-a", AgentID: "alice", PodID: "pod-a"}
	store.users["user-b"] = repo.HumanUser{HumanUserID: "user-b", AgentID: "bob", PodID: "pod-a"}
	store.assets = append(store.assets,
		syncTestPrivateAsset(t, root, "user-a", "pod-a", "dupe-skill", repo.SkillStatusActive, "sha256:a"),
		syncTestPrivateAsset(t, root, "user-b", "pod-a", "dupe-skill", repo.SkillStatusDeleted, "sha256:b"),
	)
	drv := &syncTestDriver{privateHashes: map[string]map[string]string{
		"alice": {"dupe-skill": "sha256:a"},
		"bob":   {"dupe-skill": "sha256:b"},
	}}
	syncer := newSyncTestSyncer(t, store, drv, root)

	if err := syncer.SyncPod(context.Background(), "pod-a"); err != nil {
		t.Fatalf("SyncPod: %v", err)
	}
	if fmt.Sprint(drv.privateDeletes) != "[bob/dupe-skill]" {
		t.Fatalf("private deletes = %v, want bob/dupe-skill", drv.privateDeletes)
	}
}

type syncTestStore struct {
	users  map[string]repo.HumanUser
	assets []repo.SkillAsset
}

func newSyncTestStore() *syncTestStore {
	return &syncTestStore{users: map[string]repo.HumanUser{}}
}

func (store *syncTestStore) GetHumanUser(humanUserID string) (repo.HumanUser, error) {
	user, ok := store.users[humanUserID]
	if !ok {
		return repo.HumanUser{}, repo.ErrNotFound
	}
	return user, nil
}

func (store *syncTestStore) ListSkillAssets(
	filter repo.SkillAssetListFilter,
) ([]repo.SkillAsset, int, error) {
	var out []repo.SkillAsset
	for _, asset := range store.assets {
		if filter.Scope != "" && asset.Scope != filter.Scope {
			continue
		}
		if filter.PodID != "" && asset.PodID != filter.PodID {
			continue
		}
		if filter.Status != "" && asset.Status != filter.Status {
			continue
		}
		out = append(out, asset)
	}
	return out, len(out), nil
}

type syncTestDriver struct {
	mu                 sync.Mutex
	publicSyncs        int
	publicSignature    string
	publicNames        []string
	publicActiveIndex  string
	publicManagedIndex string
	publicRemoveIndex  string
	privateHashes      map[string]map[string]string
	privateInstalls    []string
	privateDeletes     []string
	publicMountPodID   []string
}

func (drv *syncTestDriver) SyncPublicSkillFiles(_ context.Context, sourceDir string) error {
	drv.mu.Lock()
	defer drv.mu.Unlock()
	raw, err := os.ReadFile(filepath.Join(sourceDir, driver.PublicSkillSignatureFile))
	if err != nil {
		return err
	}
	drv.publicSyncs++
	drv.publicSignature = strings.TrimSpace(string(raw))
	drv.publicNames = syncTestSkillNames(sourceDir)
	if body, err := os.ReadFile(filepath.Join(sourceDir, driver.PublicSkillActiveIndexFile)); err == nil {
		drv.publicActiveIndex = string(body)
	}
	if body, err := os.ReadFile(filepath.Join(sourceDir, ".muad-public-index")); err == nil {
		drv.publicManagedIndex = string(body)
	}
	if body, err := os.ReadFile(filepath.Join(sourceDir, driver.PublicSkillRemoveIndexFile)); err == nil {
		drv.publicRemoveIndex = string(body)
	}
	return nil
}

func (drv *syncTestDriver) PublicSkillFilesSignature(context.Context) (string, error) {
	drv.mu.Lock()
	defer drv.mu.Unlock()
	return drv.publicSignature, nil
}

func (drv *syncTestDriver) EnsurePublicSkillsMount(_ context.Context, podID string) error {
	drv.publicMountPodID = append(drv.publicMountPodID, podID)
	return nil
}

func (drv *syncTestDriver) ExecStdin(
	_ context.Context, _ string, stdin io.Reader, cmd ...string,
) (string, error) {
	if len(cmd) < 4 || cmd[0] != "node" {
		return "", errors.New("unexpected command")
	}
	switch cmd[2] {
	case "list":
		return drv.privateList(cmd)
	case "install":
		return drv.privateInstall(stdin, cmd)
	case "delete":
		return drv.privateDelete(cmd)
	default:
		return "", errors.New("unexpected private Skill command")
	}
}

func (drv *syncTestDriver) privateList(cmd []string) (string, error) {
	agentID := argValue(cmd, "--agent-id")
	hashes := drv.privateHashes[agentID]
	type installed struct {
		Name         string `json:"name"`
		ManifestHash string `json:"manifestHash"`
	}
	items := make([]installed, 0, len(hashes))
	for name, hash := range hashes {
		items = append(items, installed{Name: name, ManifestHash: hash})
	}
	raw, err := json.Marshal(map[string]any{"ok": true, "skills": items})
	return string(raw), err
}

func (drv *syncTestDriver) privateInstall(stdin io.Reader, cmd []string) (string, error) {
	if _, err := io.ReadAll(stdin); err != nil {
		return "", err
	}
	agentID := argValue(cmd, "--agent-id")
	name := argValue(cmd, "--expected-name")
	drv.privateInstalls = append(drv.privateInstalls, agentID+"/"+name)
	raw, err := json.Marshal(map[string]any{"ok": true, "name": name})
	return string(raw), err
}

func (drv *syncTestDriver) privateDelete(cmd []string) (string, error) {
	agentID := argValue(cmd, "--agent-id")
	name := argValue(cmd, "--skill-name")
	drv.privateDeletes = append(drv.privateDeletes, agentID+"/"+name)
	return `{"ok":true}`, nil
}

func (drv *syncTestDriver) Create(context.Context, driver.PodSpec) error { return nil }
func (drv *syncTestDriver) Start(context.Context, string) error          { return nil }
func (drv *syncTestDriver) Stop(context.Context, string) error           { return nil }
func (drv *syncTestDriver) Restart(context.Context, string) error        { return nil }
func (drv *syncTestDriver) Remove(context.Context, string, bool) error   { return nil }
func (drv *syncTestDriver) List(context.Context) ([]driver.ContainerInfo, error) {
	return nil, nil
}
func (drv *syncTestDriver) StatsAll(context.Context) (map[string]driver.Stats, error) {
	return nil, nil
}
func (drv *syncTestDriver) Logs(context.Context, string, int) (string, error) { return "", nil }
func (drv *syncTestDriver) Exec(context.Context, string, ...string) (string, error) {
	return "", nil
}
func (drv *syncTestDriver) Reap(context.Context, string) error { return nil }
func (drv *syncTestDriver) Revive(context.Context, string) error {
	return nil
}
func (drv *syncTestDriver) UpdateSpec(context.Context, string, driver.PodSpec) error {
	return nil
}
func (drv *syncTestDriver) UpdateServiceToken(context.Context, string, driver.SecretFileSpec) error {
	return nil
}
func (drv *syncTestDriver) SyncPublicSkills(ctx context.Context, podID, sourceDir string) error {
	if err := drv.SyncPublicSkillFiles(ctx, sourceDir); err != nil {
		return err
	}
	return drv.EnsurePublicSkillsMount(ctx, podID)
}
func (drv *syncTestDriver) PublicSkillsStorageStatus(context.Context) (driver.PublicSkillsStorageStatus, error) {
	return driver.PublicSkillsStorageStatus{Configured: true, Ready: true}, nil
}
func (drv *syncTestDriver) EnsurePublicSkillsStorage(context.Context) (driver.PublicSkillsStorageStatus, error) {
	return driver.PublicSkillsStorageStatus{Configured: true, Ready: true}, nil
}

func syncTestPublicAsset(t *testing.T, root, name, hash string) repo.SkillAsset {
	t.Helper()
	source := filepath.Join(root, name)
	writeSyncTestSkill(t, source, name)
	return repo.SkillAsset{
		SkillID: "skill-" + name, Name: name, Scope: repo.SkillScopePublic,
		Status: repo.SkillStatusActive, SourcePath: source, ManifestHash: hash, UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func syncTestPrivateAsset(
	t *testing.T, root, userID, podID, name, status, hash string,
) repo.SkillAsset {
	t.Helper()
	source := filepath.Join(root, "_private-source", userID, name)
	writeSyncTestSkill(t, source, name)
	return repo.SkillAsset{
		SkillID: "skill-" + userID + "-" + name, Name: name, Scope: repo.SkillScopePrivate,
		HumanUserID: userID, PodID: podID, Status: status, SourcePath: source,
		ManifestHash: hash, UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func writeSyncTestSkill(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create Skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("# "+name+"\n"), 0o600); err != nil {
		t.Fatalf("write Skill: %v", err)
	}
}

func syncTestSkillNames(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}

func newSyncTestSyncer(
	t *testing.T, store *syncTestStore, drv *syncTestDriver, root string,
) *Syncer {
	t.Helper()
	syncer, err := New(store, drv, root, "/home/node/.openclaw")
	if err != nil {
		t.Fatalf("New syncer: %v", err)
	}
	return syncer
}

func argValue(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

// Package skillsync keeps Console-managed Skill files aligned with runtimes.
package skillsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type Store interface {
	GetHumanUser(humanUserID string) (repo.HumanUser, error)
	ListSkillAssets(filter repo.SkillAssetListFilter) ([]repo.SkillAsset, int, error)
}

type Syncer struct {
	store                 Store
	driver                driver.RuntimeDriver
	skillsDir             string
	runtimeStateDir       string
	publicLock            chan struct{}
	publicSignature       string
	publicFailSnapshot    string
	publicFailAt          time.Time
	publicFailWarnings    []string
	publicSyncLockTimeout time.Duration
}

type privateSkillInstallResult struct {
	OK   bool   `json:"ok"`
	Name string `json:"name"`
}

type privateSkillListResult struct {
	OK     bool                         `json:"ok"`
	Skills []privateSkillInstalledState `json:"skills"`
}

type privateSkillInstalledState struct {
	Name         string `json:"name"`
	ManifestHash string `json:"manifestHash"`
}

type publicSkillSnapshot struct {
	Active       []repo.SkillAsset
	ManagedNames []string
	RemoveNames  []string
	Signature    string
}

type publicSkillStaging struct {
	dir          string
	cleanup      func()
	failedSkills []string
	warnings     []string
}

type PublicSyncResult struct {
	HasPublic bool
	Warnings  []string
}

// PublicSkillPartialSyncError reports that some managed public Skills could not
// be synchronized. The previously published signature is retained so later syncs
// keep retrying; the failure is surfaced to callers instead of being silently
// treated as a success (the runtime would otherwise keep serving stale versions
// while the signature never converges).
type PublicSkillPartialSyncError struct {
	Warnings []string
}

func (err *PublicSkillPartialSyncError) Error() string {
	return fmt.Sprintf("public Skill sync partial failure: %s", strings.Join(err.Warnings, "; "))
}

const (
	defaultPublicSyncLockTimeout = 30 * time.Second
	publicPartialFailCooldown    = 30 * time.Second
)

func New(store Store, drv driver.RuntimeDriver, skillsDir, runtimeStateDir string) (*Syncer, error) {
	if store == nil || drv == nil || strings.TrimSpace(skillsDir) == "" {
		return nil, errors.New("skillsync: dependencies are required")
	}
	return &Syncer{
		store: store, driver: drv, skillsDir: skillsDir,
		runtimeStateDir:       strings.TrimSpace(runtimeStateDir),
		publicLock:            make(chan struct{}, 1),
		publicSyncLockTimeout: defaultPublicSyncLockTimeout,
	}, nil
}

func (syncer *Syncer) SyncPod(ctx context.Context, podID string) error {
	return syncer.syncPod(ctx, podID)
}

func (syncer *Syncer) syncPod(ctx context.Context, podID string) error {
	result, err := syncer.syncPublic(ctx, publicSyncOptions{SkipLockedWithPublishedState: true})
	if err != nil {
		return err
	}
	return syncer.SyncPodAfterPublicSync(ctx, podID, result.HasPublic)
}

func (syncer *Syncer) SyncPodAfterPublicSync(ctx context.Context, podID string, hasPublic bool) error {
	if hasPublic {
		if err := syncer.driver.EnsurePublicSkillsMount(ctx, podID); err != nil {
			return err
		}
	}
	return syncer.syncPrivateSkills(ctx, podID)
}

func (syncer *Syncer) BeforeApply(ctx context.Context, podID string) error {
	return syncer.SyncPod(ctx, podID)
}

func (syncer *Syncer) SyncPublic(ctx context.Context) (PublicSyncResult, error) {
	return syncer.syncPublic(ctx, publicSyncOptions{})
}

func (syncer *Syncer) SyncPublicForced(ctx context.Context) (PublicSyncResult, error) {
	return syncer.syncPublic(ctx, publicSyncOptions{Force: true})
}

type publicSyncOptions struct {
	Force                        bool
	SkipLockedWithPublishedState bool
}

func (syncer *Syncer) syncPublic(ctx context.Context, options publicSyncOptions) (PublicSyncResult, error) {
	snapshot, err := syncer.publicSkillSnapshotForSync()
	if err != nil {
		return PublicSyncResult{}, err
	}
	if len(snapshot.ManagedNames) == 0 {
		return PublicSyncResult{}, nil
	}
	unlock, err := syncer.acquirePublicSyncLock(
		ctx, options.SkipLockedWithPublishedState, snapshot.Signature,
	)
	if err != nil {
		return PublicSyncResult{}, err
	}
	if unlock == nil {
		return PublicSyncResult{HasPublic: true}, nil
	}
	defer unlock()
	if !options.Force {
		if result, ok, err := syncer.cachedPublicPartialFailure(ctx, snapshot); err != nil || ok {
			return result, err
		}
	}
	if !options.Force && syncer.publicSignature == snapshot.Signature {
		current, err := syncer.driver.PublicSkillFilesSignature(ctx)
		if err != nil {
			return PublicSyncResult{}, err
		}
		if current == snapshot.Signature {
			return PublicSyncResult{HasPublic: true}, nil
		}
	}
	staging, err := syncer.activePublicSkillSyncDir(ctx, snapshot)
	if err != nil {
		return PublicSyncResult{}, err
	}
	defer staging.cleanup()
	if err := syncer.driver.SyncPublicSkillFiles(ctx, staging.dir); err != nil {
		return PublicSyncResult{}, err
	}
	if len(staging.failedSkills) > 0 {
		log.Printf("public_skill_sync_partial_failed failed=%d skills=%s",
			len(staging.failedSkills), strings.Join(staging.failedSkills, ","))
		syncer.recordPublicPartialFailure(snapshot.Signature, staging.warnings)
		return PublicSyncResult{HasPublic: true, Warnings: staging.warnings},
			&PublicSkillPartialSyncError{Warnings: staging.warnings}
	}
	syncer.publicSignature = snapshot.Signature
	syncer.clearPublicPartialFailure()
	return PublicSyncResult{HasPublic: true}, nil
}

func (syncer *Syncer) cachedPublicPartialFailure(
	ctx context.Context, snapshot publicSkillSnapshot,
) (PublicSyncResult, bool, error) {
	if syncer.publicFailSnapshot != snapshot.Signature || syncer.publicFailAt.IsZero() {
		return PublicSyncResult{}, false, nil
	}
	if time.Since(syncer.publicFailAt) >= publicPartialFailCooldown {
		return PublicSyncResult{}, false, nil
	}
	current, err := syncer.driver.PublicSkillFilesSignature(ctx)
	if err != nil {
		return PublicSyncResult{}, false, err
	}
	if current == "" {
		// 磁盘上还没有任何已发布签名（首次同步即部分失败）：不套用冷却，
		// 让后续同步持续重试直到收敛。
		return PublicSyncResult{}, false, nil
	}
	// 冷却期内不重复发布文件，但必须如实报告失败——部分成功不再当作成功。
	warnings := append([]string(nil), syncer.publicFailWarnings...)
	return PublicSyncResult{HasPublic: true, Warnings: warnings}, true,
		&PublicSkillPartialSyncError{Warnings: warnings}
}

func (syncer *Syncer) recordPublicPartialFailure(signature string, warnings []string) {
	syncer.publicFailSnapshot = signature
	syncer.publicFailAt = time.Now()
	syncer.publicFailWarnings = append([]string(nil), warnings...)
}

func (syncer *Syncer) clearPublicPartialFailure() {
	syncer.publicFailSnapshot = ""
	syncer.publicFailAt = time.Time{}
	syncer.publicFailWarnings = nil
}

func (syncer *Syncer) acquirePublicSyncLock(
	ctx context.Context, allowPublishedStateSkip bool, desiredSignature string,
) (func(), error) {
	if allowPublishedStateSkip {
		select {
		case syncer.publicLock <- struct{}{}:
			return func() { <-syncer.publicLock }, nil
		default:
			current, err := syncer.driver.PublicSkillFilesSignature(ctx)
			if err != nil {
				return nil, err
			}
			if current == desiredSignature {
				return nil, nil
			}
		}
	}
	timeout := syncer.publicSyncLockTimeout
	if timeout <= 0 {
		timeout = defaultPublicSyncLockTimeout
	}
	lockCtx, cancel := context.WithTimeout(ctx, timeout)
	select {
	case syncer.publicLock <- struct{}{}:
		return func() {
			<-syncer.publicLock
			cancel()
		}, nil
	case <-lockCtx.Done():
		cancel()
		return nil, fmt.Errorf("acquire public Skill sync lock: %w", lockCtx.Err())
	}
}

func (syncer *Syncer) syncPrivateSkills(ctx context.Context, podID string) error {
	active, err := syncer.privateSkillAssets(podID, repo.SkillStatusActive)
	if err != nil {
		return err
	}
	stale, err := syncer.stalePrivateSkillAssets(podID)
	if err != nil {
		return err
	}
	users, err := syncer.privateSkillUsers(append(active, stale...))
	if err != nil {
		return err
	}
	desired := map[string]map[string]string{}
	for _, asset := range active {
		user := users[asset.HumanUserID]
		if desired[user.AgentID] == nil {
			desired[user.AgentID] = map[string]string{}
		}
		desired[user.AgentID][asset.Name] = asset.ManifestHash
	}
	installed := map[string]map[string]string{}
	for _, asset := range active {
		user := users[asset.HumanUserID]
		hashes, err := syncer.installedPrivateSkillHashes(ctx, podID, user, installed)
		if err != nil {
			return err
		}
		if hashes[asset.Name] == asset.ManifestHash {
			continue
		}
		if err := syncer.installPrivateSkillAsset(ctx, podID, user, asset); err != nil {
			return err
		}
	}
	// 清点收敛：已安装集与期望集求差集删除。DB 中 disabled/deleted 资产、资产硬删
	// 或用户移出 pod 后的残留都会在这里被清理——只依赖 DB 状态枚举 stale 资产会漏删。
	for _, user := range users {
		if err := syncer.prunePrivateInstalled(ctx, podID, user, desired[user.AgentID], installed); err != nil {
			return err
		}
	}
	return nil
}

// prunePrivateInstalled 删除该 agent 已安装但不再期望的私有 Skill。desired 为
// 空 map 时表示该用户当前没有任何期望资产（如用户已移出 pod），全部清空。
func (syncer *Syncer) prunePrivateInstalled(
	ctx context.Context, podID string, user repo.HumanUser,
	desired map[string]string, installedCache map[string]map[string]string,
) error {
	hashes, err := syncer.installedPrivateSkillHashes(ctx, podID, user, installedCache)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names) // 确定性删除顺序：审计/驱动调用稳定，测试可断言
	for _, name := range names {
		if _, keep := desired[name]; keep {
			continue
		}
		if err := syncer.deletePrivateSkillInPod(ctx, podID, user.AgentID, name); err != nil {
			return err
		}
	}
	return nil
}

func (syncer *Syncer) privateSkillAssets(podID, status string) ([]repo.SkillAsset, error) {
	assets, _, err := syncer.store.ListSkillAssets(repo.SkillAssetListFilter{
		Scope: repo.SkillScopePrivate, PodID: podID, Status: status,
	})
	return assets, err
}

func (syncer *Syncer) stalePrivateSkillAssets(podID string) ([]repo.SkillAsset, error) {
	var stale []repo.SkillAsset
	for _, status := range []string{repo.SkillStatusDisabled, repo.SkillStatusDeleted} {
		assets, err := syncer.privateSkillAssets(podID, status)
		if err != nil {
			return nil, err
		}
		stale = append(stale, assets...)
	}
	return stale, nil
}

func (syncer *Syncer) privateSkillUsers(assets []repo.SkillAsset) (map[string]repo.HumanUser, error) {
	users := map[string]repo.HumanUser{}
	for _, asset := range assets {
		if _, exists := users[asset.HumanUserID]; exists {
			continue
		}
		user, err := syncer.store.GetHumanUser(asset.HumanUserID)
		if err != nil {
			return nil, err
		}
		users[asset.HumanUserID] = user
	}
	return users, nil
}

func (syncer *Syncer) installedPrivateSkillHashes(
	ctx context.Context, podID string, user repo.HumanUser, cache map[string]map[string]string,
) (map[string]string, error) {
	if cached := cache[user.AgentID]; cached != nil {
		return cached, nil
	}
	hashes, err := syncer.listPrivateSkillHashes(ctx, podID, user.AgentID)
	if err != nil {
		return nil, err
	}
	cache[user.AgentID] = hashes
	return hashes, nil
}

func (syncer *Syncer) listPrivateSkillHashes(
	ctx context.Context, podID, agentID string,
) (map[string]string, error) {
	output, err := syncer.driver.ExecStdin(ctx, podID, strings.NewReader(""),
		syncer.privateSkillInstallerArgs("list", "--agent-id", agentID)...)
	if err != nil {
		log.Printf("private_skill_list_failed pod=%s agent=%s error=%v", podID, agentID, err)
		return nil, err
	}
	var result privateSkillListResult
	if err := json.Unmarshal([]byte(output), &result); err != nil || !result.OK {
		return nil, errors.New("invalid private Skill list response")
	}
	hashes := make(map[string]string, len(result.Skills))
	for _, skill := range result.Skills {
		hashes[skill.Name] = skill.ManifestHash
	}
	return hashes, nil
}

func (syncer *Syncer) installPrivateSkillAsset(
	ctx context.Context, podID string, user repo.HumanUser, asset repo.SkillAsset,
) error {
	bundle, err := buildSkillDirectoryBundle(asset.SourcePath, asset.Name)
	if err != nil {
		return err
	}
	result, err := syncer.installPrivateSkillInPod(ctx, podID, user.AgentID, asset.Name, "tar.gz", bundle)
	if err != nil {
		return err
	}
	if result.Name != asset.Name {
		return errors.New("private Skill installer returned a different Skill")
	}
	return nil
}

func (syncer *Syncer) installPrivateSkillInPod(
	ctx context.Context, podID, agentID, expectedName, format string, bundle []byte,
) (privateSkillInstallResult, error) {
	args := []string{
		"node", "/opt/muad/private-skill-installer.mjs", "install",
		"--agent-id", agentID, "--bundle-format", format,
	}
	if expectedName != "" {
		args = append(args, "--expected-name", expectedName)
	}
	args = syncer.appendRuntimeStateDir(args)
	output, err := syncer.driver.ExecStdin(ctx, podID, bytes.NewReader(bundle), args...)
	if err != nil {
		log.Printf("private_skill_install_failed pod=%s agent=%s error=%v", podID, agentID, err)
		return privateSkillInstallResult{}, err
	}
	var result privateSkillInstallResult
	if err := json.Unmarshal([]byte(output), &result); err != nil || !result.OK || result.Name == "" {
		return privateSkillInstallResult{}, errors.New("invalid installer response")
	}
	return result, nil
}

func (syncer *Syncer) deletePrivateSkillInPod(
	ctx context.Context, podID, agentID, skillName string,
) error {
	_, err := syncer.driver.ExecStdin(ctx, podID, strings.NewReader(""),
		syncer.privateSkillInstallerArgs("delete", "--agent-id", agentID, "--skill-name", skillName)...)
	if err != nil {
		log.Printf("private_skill_delete_failed pod=%s agent=%s skill=%s error=%v", podID, agentID, skillName, err)
	}
	return err
}

func (syncer *Syncer) privateSkillInstallerArgs(command string, args ...string) []string {
	base := append([]string{"node", "/opt/muad/private-skill-installer.mjs", command}, args...)
	return syncer.appendRuntimeStateDir(base)
}

func (syncer *Syncer) appendRuntimeStateDir(args []string) []string {
	if syncer.runtimeStateDir == "" {
		return args
	}
	return append(args, "--state-dir", syncer.runtimeStateDir)
}

func (syncer *Syncer) activePublicSkillSyncDir(
	ctx context.Context, snapshot publicSkillSnapshot,
) (publicSkillStaging, error) {
	root, err := resolvePublicSkillRoot(syncer.skillsDir)
	if err != nil {
		return publicSkillStaging{}, err
	}
	tempRoot, err := os.MkdirTemp("", "muad-active-public-skills-")
	if err != nil {
		return publicSkillStaging{}, err
	}
	cleanup := func() { _ = os.RemoveAll(tempRoot) }
	published := make([]repo.SkillAsset, 0, len(snapshot.Active))
	failedSkills := make([]string, 0)
	for _, asset := range snapshot.Active {
		source := activePublicSkillSource(root, asset)
		target := filepath.Join(tempRoot, asset.Name)
		if err := copySkillDirectory(source, target); err != nil {
			log.Printf("public_skill_asset_sync_failed skill=%s source=%s error=%s",
				asset.Name, source, auditlog.RedactDiagnostic(err.Error()))
			failedSkills = append(failedSkills, asset.Name)
			continue
		}
		published = append(published, asset)
	}
	if err := writePublicSkillManagedIndex(tempRoot, snapshot.ManagedNames); err != nil {
		cleanup()
		return publicSkillStaging{}, err
	}
	if err := writePublicSkillRemoveIndex(tempRoot, snapshot.RemoveNames); err != nil {
		cleanup()
		return publicSkillStaging{}, err
	}
	if err := writePublicSkillActiveIndex(tempRoot, published); err != nil {
		cleanup()
		return publicSkillStaging{}, err
	}
	signature := snapshot.Signature
	if len(failedSkills) > 0 {
		// 部分失败时不发布部分签名：保留当前已发布签名（首次失败则为空），
		// 磁盘签名与期望签名永不相等，后续同步持续重试直至全部收敛。
		signature, err = syncer.driver.PublicSkillFilesSignature(ctx)
		if err != nil {
			cleanup()
			return publicSkillStaging{}, err
		}
	}
	if err := writePublicSkillSignature(tempRoot, signature); err != nil {
		cleanup()
		return publicSkillStaging{}, err
	}
	return publicSkillStaging{
		dir: tempRoot, cleanup: cleanup, failedSkills: failedSkills,
		warnings: publicSkillSyncWarnings(failedSkills),
	}, nil
}

func (syncer *Syncer) publicSkillSnapshotForSync() (publicSkillSnapshot, error) {
	var active []repo.SkillAsset
	managed := map[string]struct{}{}
	remove := map[string]struct{}{}
	activeNames := map[string]struct{}{}
	for _, status := range []string{repo.SkillStatusActive, repo.SkillStatusDisabled, repo.SkillStatusDeleted} {
		assets, _, err := syncer.store.ListSkillAssets(repo.SkillAssetListFilter{
			Scope: repo.SkillScopePublic, Status: status,
		})
		if err != nil {
			return publicSkillSnapshot{}, err
		}
		for _, asset := range assets {
			managed[asset.Name] = struct{}{}
			if asset.Status == repo.SkillStatusActive {
				active = append(active, asset)
				activeNames[asset.Name] = struct{}{}
				continue
			}
			if asset.Status == repo.SkillStatusDisabled || asset.Status == repo.SkillStatusDeleted {
				remove[asset.Name] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(managed))
	for name := range managed {
		names = append(names, name)
	}
	removeNames := make([]string, 0, len(remove))
	for name := range remove {
		if _, isActive := activeNames[name]; !isActive {
			removeNames = append(removeNames, name)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].Name < active[j].Name })
	sort.Strings(names)
	sort.Strings(removeNames)
	return publicSkillSnapshot{
		Active: active, ManagedNames: names, RemoveNames: removeNames,
		Signature: publicSkillSignature(active, names),
	}, nil
}

func publicSkillSignature(active []repo.SkillAsset, managedNames []string) string {
	hash := sha256.New()
	for _, name := range managedNames {
		hash.Write([]byte("managed\x00" + name + "\x00"))
	}
	for _, asset := range active {
		hash.Write([]byte("active\x00" + asset.Name + "\x00" + asset.SourcePath + "\x00"))
		hash.Write([]byte(asset.ManifestHash + "\x00" + asset.UpdatedAt.UTC().Format(time.RFC3339Nano) + "\x00"))
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

func writePublicSkillManagedIndex(root string, names []string) error {
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return os.WriteFile(filepath.Join(root, ".muad-public-index"), []byte(body), 0o600)
}

func writePublicSkillActiveIndex(root string, active []repo.SkillAsset) error {
	names := make([]string, 0, len(active))
	for _, asset := range active {
		names = append(names, asset.Name)
	}
	sort.Strings(names)
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return os.WriteFile(filepath.Join(root, driver.PublicSkillActiveIndexFile), []byte(body), 0o600)
}

func writePublicSkillRemoveIndex(root string, names []string) error {
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return os.WriteFile(filepath.Join(root, driver.PublicSkillRemoveIndexFile), []byte(body), 0o600)
}

func writePublicSkillSignature(root, signature string) error {
	return os.WriteFile(filepath.Join(root, driver.PublicSkillSignatureFile), []byte(signature+"\n"), 0o600)
}

func publicSkillSyncWarnings(failedSkills []string) []string {
	if len(failedSkills) == 0 {
		return nil
	}
	names := append([]string(nil), failedSkills...)
	sort.Strings(names)
	return []string{fmt.Sprintf("%d 个 Public Skill 同步失败：%s", len(names), strings.Join(names, "、"))}
}

func activePublicSkillSource(root string, asset repo.SkillAsset) string {
	source := filepath.Clean(strings.TrimSpace(asset.SourcePath))
	if source != "" && filepath.IsAbs(source) && pathWithin(root, source) {
		return source
	}
	return filepath.Join(root, asset.Name)
}

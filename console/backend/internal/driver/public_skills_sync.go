package driver

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	publicSkillIndexFile       = ".muad-public-index"
	PublicSkillActiveIndexFile = ".muad-public-active-index"
	PublicSkillRemoveIndexFile = ".muad-public-remove-index"
	PublicSkillSignatureFile   = ".muad-public-signature"
	publicSkillsMountAttempts  = 2
)

// SyncPublicSkills mirrors active public Skills into the Docker runtime mount
// directory. The upload source stays untouched so disabled/deleted Skills can be
// kept in Console storage without remaining visible inside workers.
func (d *DockerDriver) SyncPublicSkillFiles(_ context.Context, sourceDir string) error {
	if strings.TrimSpace(sourceDir) == "" {
		return ErrInvalidPodSpec
	}
	targetDir := d.publicSkillsHostDir()
	if targetDir == "" {
		return ErrInvalidPodSpec
	}
	return syncDirectoryContents(sourceDir, targetDir)
}

func (d *DockerDriver) PublicSkillFilesSignature(context.Context) (string, error) {
	return readPublicSkillSignature(d.publicSkillsHostDir())
}

func (d *DockerDriver) EnsurePublicSkillsMount(context.Context, string) error {
	return nil
}

func (d *DockerDriver) SyncPublicSkills(ctx context.Context, podID, sourceDir string) error {
	if err := d.SyncPublicSkillFiles(ctx, sourceDir); err != nil {
		return err
	}
	return d.EnsurePublicSkillsMount(ctx, podID)
}

func (d *DockerDriver) PublicSkillsStorageStatus(
	_ context.Context,
) (PublicSkillsStorageStatus, error) {
	hostDir := d.publicSkillsHostDir()
	configured := strings.TrimSpace(d.skillsDir) != ""
	phase := "Missing"
	ready := configured
	message := "Docker 使用 active-only 运行目录挂载 Public Skill"
	if !configured {
		message = "未配置 Docker Public Skill 目录"
	} else if stat, err := os.Stat(hostDir); err == nil && stat.IsDir() {
		phase = "directory"
	} else if os.IsNotExist(err) {
		phase = "Pending"
		message = "Docker Public Skill 运行目录将在应用或创建 Pod 时自动创建"
	} else if err != nil && !os.IsNotExist(err) {
		return PublicSkillsStorageStatus{}, fmt.Errorf("stat Docker public Skill directory: %w", err)
	}
	return PublicSkillsStorageStatus{
		Driver: "docker", Name: hostDir, Configured: configured, Ready: ready,
		Phase: phase, Message: message,
	}, nil
}

func (d *DockerDriver) EnsurePublicSkillsStorage(
	ctx context.Context,
) (PublicSkillsStorageStatus, error) {
	if err := d.ensurePublicSkillsDir(); err != nil {
		return PublicSkillsStorageStatus{}, err
	}
	return d.PublicSkillsStorageStatus(ctx)
}

func syncDirectoryContents(sourceDir, targetDir string) error {
	source, err := publicSkillsRoot(sourceDir)
	if err != nil {
		return err
	}
	target := filepath.Clean(strings.TrimSpace(targetDir))
	if target == "." || target == "" {
		return ErrInvalidPodSpec
	}
	sourceAbs, err := filepath.Abs(source)
	if err != nil {
		return fmt.Errorf("resolve source public Skill directory: %w", err)
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("resolve target public Skill directory: %w", err)
	}
	if sourceAbs == targetAbs {
		return nil
	}
	if err := os.MkdirAll(targetAbs, dockerPublicSkillsDirMode); err != nil {
		return fmt.Errorf("create public Skill target directory: %w", err)
	}
	cleanupPublicSkillSyncArtifacts(filepath.Dir(targetAbs))
	cleanupPublicSkillSyncArtifacts(targetAbs)
	staging, err := os.MkdirTemp(filepath.Dir(targetAbs), ".muad-sync-")
	if err != nil {
		return fmt.Errorf("create public Skill staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := copyPublicSkillTree(sourceAbs, staging); err != nil {
		return err
	}
	managed, err := publicSkillManagedNames(sourceAbs)
	if err != nil {
		return err
	}
	remove, err := publicSkillRemoveNames(sourceAbs)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(staging, publicSkillIndexFile), []byte(managed.body), 0o600); err != nil {
		return fmt.Errorf("write public Skill index: %w", err)
	}
	if err := os.WriteFile(filepath.Join(staging, PublicSkillRemoveIndexFile), []byte(remove.body), 0o600); err != nil {
		return fmt.Errorf("write public Skill remove index: %w", err)
	}
	signature, err := publicSkillSourceSignature(sourceAbs)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(staging, PublicSkillSignatureFile), []byte(signature+"\n"), 0o600); err != nil {
		return fmt.Errorf("write public Skill signature: %w", err)
	}
	activeIndex, err := publicSkillActiveIndexBody(sourceAbs)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(staging, PublicSkillActiveIndexFile), []byte(activeIndex), 0o600); err != nil {
		return fmt.Errorf("write public Skill active index: %w", err)
	}
	if err := publishPublicSkillStaging(staging, targetAbs, remove.names); err != nil {
		return err
	}
	return os.Chmod(targetAbs, dockerPublicSkillsDirMode)
}

type publicSkillManagedSet struct {
	body  string
	names []string
}

func publicSkillManagedNames(sourceRoot string) (publicSkillManagedSet, error) {
	body, err := publicSkillIndexBody(sourceRoot)
	if err != nil {
		return publicSkillManagedSet{}, err
	}
	names := managedNamesFromIndex(body)
	return publicSkillManagedSet{body: body, names: names}, nil
}

func publicSkillRemoveNames(sourceRoot string) (publicSkillManagedSet, error) {
	body, err := publicSkillRemoveIndexBody(sourceRoot)
	if err != nil {
		return publicSkillManagedSet{}, err
	}
	return publicSkillManagedSet{body: body, names: managedNamesFromIndex(body)}, nil
}

func managedNamesFromIndex(body string) []string {
	names := []string{}
	for _, line := range strings.Split(body, "\n") {
		name := strings.TrimSpace(line)
		if safePublicSkillName(name) {
			names = append(names, name)
		}
	}
	return uniqueSortedStrings(names)
}

func publishPublicSkillStaging(staging, targetRoot string, removeNames []string) error {
	published, err := publicSkillDirectoryNames(staging)
	if err != nil {
		return err
	}
	for _, name := range published {
		source := filepath.Join(staging, name)
		target := filepath.Join(targetRoot, name)
		if err := replacePublicSkillEntry(source, target, filepath.Dir(targetRoot)); err != nil {
			return err
		}
	}
	for _, name := range removeNames {
		target := filepath.Join(targetRoot, name)
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("remove stale public Skill: %w", err)
		}
	}
	// 全量删除收敛：目标目录中不在 managed 列表的目录（手工放置、或资产已从 DB
	// 硬删导致 remove-index 无法再枚举）一律清除；与 remove-index 合并互补，
	// remove-index 兼容保留。managed 但本次未发布（部分失败）的目录仍保留。
	managed, err := publicSkillManagedNames(staging)
	if err != nil {
		return err
	}
	managedSet := make(map[string]struct{}, len(managed.names))
	for _, name := range managed.names {
		managedSet[name] = struct{}{}
	}
	existing, err := publicSkillDirectoryNames(targetRoot)
	if err != nil {
		return err
	}
	for _, name := range existing {
		if _, isManaged := managedSet[name]; isManaged {
			continue
		}
		if err := os.RemoveAll(filepath.Join(targetRoot, name)); err != nil {
			return fmt.Errorf("remove unmanaged public Skill %q: %w", name, err)
		}
	}
	if err := replacePublicSkillFile(filepath.Join(staging, publicSkillIndexFile), filepath.Join(targetRoot, publicSkillIndexFile), 0o600); err != nil {
		return err
	}
	if err := replacePublicSkillFile(filepath.Join(staging, PublicSkillActiveIndexFile), filepath.Join(targetRoot, PublicSkillActiveIndexFile), 0o600); err != nil {
		return err
	}
	if err := replacePublicSkillFile(filepath.Join(staging, PublicSkillRemoveIndexFile), filepath.Join(targetRoot, PublicSkillRemoveIndexFile), 0o600); err != nil {
		return err
	}
	return replacePublicSkillFile(filepath.Join(staging, PublicSkillSignatureFile), filepath.Join(targetRoot, PublicSkillSignatureFile), 0o600)
}

func replacePublicSkillEntry(source, target, backupRoot string) error {
	backup, err := publicSkillBackupPath(backupRoot, filepath.Base(target))
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(backup) }()
	if err := os.Rename(target, backup); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("stage old public Skill: %w", err)
	}
	if err := os.Rename(source, target); err != nil {
		if _, restoreErr := os.Stat(backup); restoreErr == nil {
			_ = os.Rename(backup, target)
		}
		return fmt.Errorf("publish public Skill: %w", err)
	}
	if err := os.RemoveAll(backup); err != nil {
		log.Printf("public_skill_backup_cleanup_failed target=%s error=%v", target, err)
	}
	return nil
}

func publicSkillBackupPath(root, name string) (string, error) {
	backup, err := os.MkdirTemp(root, ".muad-old-"+name+"-")
	if err != nil {
		return "", fmt.Errorf("create public Skill backup path: %w", err)
	}
	if err := os.Remove(backup); err != nil {
		return "", fmt.Errorf("prepare public Skill backup path: %w", err)
	}
	return backup, nil
}

func replacePublicSkillFile(source, target string, mode os.FileMode) error {
	staged, err := publicSkillStagedFilePath(target)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(staged) }()
	if err := copyRegularFile(source, staged, mode); err != nil {
		return err
	}
	if err := os.Rename(staged, target); err != nil {
		return fmt.Errorf("publish public Skill file: %w", err)
	}
	return nil
}

func publicSkillStagedFilePath(target string) (string, error) {
	activeRoot := filepath.Dir(target)
	stagingRoot := filepath.Dir(activeRoot)
	if stagingRoot == "." || stagingRoot == activeRoot {
		stagingRoot = activeRoot
	}
	file, err := os.CreateTemp(stagingRoot, ".muad-new-"+filepath.Base(target)+"-")
	if err != nil {
		return "", fmt.Errorf("create public Skill staged file: %w", err)
	}
	name := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("close public Skill staged file: %w", err)
	}
	if err := os.Remove(name); err != nil {
		return "", fmt.Errorf("prepare public Skill staged file: %w", err)
	}
	return name, nil
}

func cleanupPublicSkillSyncArtifacts(root string) {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		log.Printf("public_skill_sync_cleanup_scan_failed root=%s error=%v", root, err)
		return
	}
	for _, entry := range entries {
		if !publicSkillSyncArtifact(entry.Name()) {
			continue
		}
		target := filepath.Join(root, entry.Name())
		if err := os.RemoveAll(target); err != nil {
			log.Printf("public_skill_sync_cleanup_failed target=%s error=%v", target, err)
		}
	}
}

func publicSkillSyncArtifact(name string) bool {
	return strings.HasPrefix(name, ".muad-sync-") ||
		strings.HasPrefix(name, ".muad-old-") ||
		strings.HasPrefix(name, ".muad-new-") ||
		publicSkillLegacyNewArtifact(name)
}

func publicSkillLegacyNewArtifact(name string) bool {
	for _, metadata := range publicSkillMetadataFiles() {
		if name == metadata+".muad-new" || strings.HasPrefix(name, metadata+".muad-new-") {
			return true
		}
	}
	return false
}

func publicSkillMetadataFiles() []string {
	return []string{
		publicSkillIndexFile,
		PublicSkillActiveIndexFile,
		PublicSkillRemoveIndexFile,
		PublicSkillSignatureFile,
	}
}

func readPublicSkillSignature(root string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", nil
	}
	raw, err := os.ReadFile(filepath.Join(root, PublicSkillSignatureFile))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read public Skill signature: %w", err)
	}
	complete, err := publicSkillActiveTreeComplete(root)
	if err != nil {
		return "", err
	}
	if !complete {
		return "", nil
	}
	return strings.TrimSpace(string(raw)), nil
}

func publicSkillSourceSignature(root string) (string, error) {
	signature, err := readPublicSkillSignature(root)
	if err != nil {
		return "", err
	}
	if signature != "" {
		return signature, nil
	}
	return "legacy", nil
}

func publicSkillActiveIndexBody(root string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, PublicSkillActiveIndexFile))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read public Skill active index: %w", err)
	}
	return sanitizePublicSkillIndex(string(raw)), nil
}

func publicSkillRemoveIndexBody(root string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, PublicSkillRemoveIndexFile))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read public Skill remove index: %w", err)
	}
	return sanitizePublicSkillIndex(string(raw)), nil
}

func publicSkillActiveTreeComplete(root string) (bool, error) {
	raw, err := os.ReadFile(filepath.Join(root, PublicSkillActiveIndexFile))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	body := sanitizePublicSkillIndex(string(raw))
	for _, name := range managedNamesFromIndex(body) {
		if _, err := os.Stat(filepath.Join(root, name, "SKILL.md")); err == nil {
			continue
		} else if os.IsNotExist(err) {
			return false, nil
		} else {
			return false, fmt.Errorf("stat active public Skill: %w", err)
		}
	}
	return true, nil
}

func copyPublicSkillTree(sourceRoot, targetRoot string) error {
	if _, err := os.Stat(sourceRoot); os.IsNotExist(err) {
		return nil
	}
	return filepath.WalkDir(sourceRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == sourceRoot {
			return nil
		}
		relative, err := filepath.Rel(sourceRoot, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		if !safePublicSkillArchivePath(name) {
			return nil
		}
		target := filepath.Join(targetRoot, filepath.FromSlash(name))
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copyRegularFile(path, target, info.Mode().Perm())
	})
}

func copyRegularFile(source, target string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create public Skill file parent: %w", err)
	}
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open public Skill file: %w", err)
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("create public Skill file: %w", err)
	}
	defer output.Close()
	if _, err := io.Copy(output, input); err != nil {
		return fmt.Errorf("copy public Skill file: %w", err)
	}
	return nil
}

// SyncPublicSkills mirrors Console-managed public Skills into the Console
// pod's RW mount of the shared k8s PVC. Workers mount the active subPath
// read-only, so applying Skills no longer depends on temporary pods.
func (d *K8sDriver) SyncPublicSkillFiles(ctx context.Context, sourceDir string) error {
	if err := d.ensurePublicSkillsPVCReady(ctx); err != nil {
		return err
	}
	targetDir, err := d.publicSkillsSyncTargetDir()
	if err != nil {
		return err
	}
	return syncDirectoryContents(sourceDir, targetDir)
}

func (d *K8sDriver) PublicSkillFilesSignature(context.Context) (string, error) {
	target, err := d.publicSkillsSyncTargetDir()
	if err != nil {
		return "", err
	}
	return readPublicSkillSignature(target)
}

func (d *K8sDriver) EnsurePublicSkillsMount(ctx context.Context, podID string) error {
	return d.ensurePublicSkillsMount(ctx, podID)
}

func (d *K8sDriver) SyncPublicSkills(ctx context.Context, podID string, sourceDir string) error {
	if err := d.SyncPublicSkillFiles(ctx, sourceDir); err != nil {
		return err
	}
	return d.EnsurePublicSkillsMount(ctx, podID)
}

func (d *K8sDriver) ensurePublicSkillsPVCReady(ctx context.Context) error {
	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil {
		return err
	}
	if !status.Configured {
		return fmt.Errorf("%w: public Skill storage is not configured", ErrInvalidPodSpec)
	}
	if !status.Ready {
		return fmt.Errorf("%w: public Skill PVC %s is not ready: %s", ErrRuntimeNotReady, d.skillsPVC, status.Phase)
	}
	return nil
}

func (d *K8sDriver) ensurePublicSkillsMount(ctx context.Context, podID string) error {
	if !d.publicSkillsConfigured() {
		return ErrInvalidPodSpec
	}
	deps := d.client.AppsV1().Deployments(d.namespace)
	name := ContainerName(podID)
	for attempt := 0; attempt < publicSkillsMountAttempts; attempt++ {
		dep, err := deps.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if len(dep.Spec.Template.Spec.Containers) == 0 {
			return ErrRuntimeNotReady
		}
		changed := ensureVolume(&dep.Spec.Template.Spec, publicSkillsVolume(d.skillsPVC))
		changed = ensureVolumeMount(&dep.Spec.Template.Spec.Containers[0], d.publicSkillsVolumeMount()) || changed
		if !changed {
			return nil
		}
		if _, err = deps.Update(ctx, dep, metav1.UpdateOptions{}); err == nil {
			return nil
		}
		if !apierrors.IsConflict(err) || attempt+1 == publicSkillsMountAttempts {
			return err
		}
	}
	return nil
}

func ensureVolume(spec *corev1.PodSpec, volume corev1.Volume) bool {
	for i := range spec.Volumes {
		if spec.Volumes[i].Name == volume.Name {
			if samePublicSkillsVolume(spec.Volumes[i], volume) {
				return false
			}
			spec.Volumes[i] = volume
			return true
		}
	}
	spec.Volumes = append(spec.Volumes, volume)
	return true
}

func samePublicSkillsVolume(left, right corev1.Volume) bool {
	if left.Name != right.Name {
		return false
	}
	leftClaim := ""
	leftReadOnly := false
	if left.PersistentVolumeClaim != nil {
		leftClaim = left.PersistentVolumeClaim.ClaimName
		leftReadOnly = left.PersistentVolumeClaim.ReadOnly
	}
	rightClaim := ""
	rightReadOnly := false
	if right.PersistentVolumeClaim != nil {
		rightClaim = right.PersistentVolumeClaim.ClaimName
		rightReadOnly = right.PersistentVolumeClaim.ReadOnly
	}
	return leftClaim == rightClaim && leftReadOnly == rightReadOnly
}

func ensureVolumeMount(container *corev1.Container, mount corev1.VolumeMount) bool {
	for i := range container.VolumeMounts {
		existing := container.VolumeMounts[i]
		if existing.Name == mount.Name || existing.MountPath == mount.MountPath {
			if samePublicSkillsVolumeMount(existing, mount) {
				return false
			}
			container.VolumeMounts[i] = mount
			return true
		}
	}
	container.VolumeMounts = append(container.VolumeMounts, mount)
	return true
}

func samePublicSkillsVolumeMount(left, right corev1.VolumeMount) bool {
	return left.Name == right.Name && left.MountPath == right.MountPath &&
		left.ReadOnly == right.ReadOnly && left.SubPath == right.SubPath
}

func (d *K8sDriver) PublicSkillsStorageStatus(
	ctx context.Context,
) (PublicSkillsStorageStatus, error) {
	base := d.publicSkillsStorageBase()
	if !base.Configured {
		return base, nil
	}
	pvc, err := d.client.CoreV1().PersistentVolumeClaims(d.namespace).Get(
		ctx, d.skillsPVC, metav1.GetOptions{},
	)
	if apierrors.IsNotFound(err) {
		base.Phase = "Missing"
		base.Message = "Public Skill PVC 尚未创建"
		return base, nil
	}
	if err != nil {
		return PublicSkillsStorageStatus{}, err
	}
	status := d.statusFromPublicSkillsPVC(pvc)
	if status.Ready {
		if err := d.ensurePublicSkillsActiveDir(); err != nil {
			status.Ready = false
			status.Message = fmt.Sprintf("Console Public Skill 挂载目录不可写: %v", err)
		}
	}
	return status, nil
}

func (d *K8sDriver) EnsurePublicSkillsStorage(
	ctx context.Context,
) (PublicSkillsStorageStatus, error) {
	base := d.publicSkillsStorageBase()
	if !base.Configured {
		return base, ErrInvalidPodSpec
	}
	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil || status.Ready {
		return status, err
	}
	pvc, err := d.createPublicSkillsPVC(ctx)
	if apierrors.IsAlreadyExists(err) {
		return d.PublicSkillsStorageStatus(ctx)
	}
	if err != nil {
		return PublicSkillsStorageStatus{}, err
	}
	return d.statusFromPublicSkillsPVC(pvc), nil
}

func (d *K8sDriver) publicSkillsStorageBase() PublicSkillsStorageStatus {
	pvcConfigured := strings.TrimSpace(d.skillsPVC) != ""
	mountConfigured := strings.TrimSpace(d.publicSkillsMount) != ""
	status := PublicSkillsStorageStatus{
		Driver: "k8s", Name: d.skillsPVC, Namespace: d.namespace,
		Configured: pvcConfigured && mountConfigured,
		AccessMode: "ReadWriteMany", StorageClass: d.skillsStorageClass, Size: d.skillsSize,
	}
	switch {
	case !pvcConfigured:
		status.Message = "未配置 k8s.skillsPVC"
	case !mountConfigured:
		status.Message = "未配置 k8s.publicSkillsMountPath"
	}
	return status
}

func (d *K8sDriver) createPublicSkillsPVC(ctx context.Context) (*corev1.PersistentVolumeClaim, error) {
	qty, err := resource.ParseQuantity(orDefault(d.skillsSize, "5Gi"))
	if err != nil {
		return nil, fmt.Errorf("k8s: public Skill PVC size %q: %w", d.skillsSize, err)
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: d.skillsPVC, Namespace: d.namespace,
			Labels: map[string]string{"app": "muad-console", "muad-resource": "public-skills"},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: qty},
			},
		},
	}
	if d.skillsStorageClass != "" {
		pvc.Spec.StorageClassName = ptr(d.skillsStorageClass)
	}
	return d.client.CoreV1().PersistentVolumeClaims(d.namespace).Create(ctx, pvc, metav1.CreateOptions{})
}

func (d *K8sDriver) statusFromPublicSkillsPVC(
	pvc *corev1.PersistentVolumeClaim,
) PublicSkillsStorageStatus {
	status := d.publicSkillsStorageBase()
	status.Phase = string(pvc.Status.Phase)
	hasRWX := pvcHasAccessMode(pvc, corev1.ReadWriteMany)
	status.Ready = pvc.Status.Phase == corev1.ClaimBound && hasRWX
	if pvc.Spec.StorageClassName != nil {
		status.StorageClass = *pvc.Spec.StorageClassName
	}
	if len(pvc.Spec.AccessModes) > 0 {
		status.AccessMode = string(pvc.Spec.AccessModes[0])
	}
	if qty, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		status.Size = qty.String()
	}
	if pvc.Status.Phase == corev1.ClaimBound && !hasRWX {
		status.Message = "Public Skill PVC 必须支持 ReadWriteMany"
	} else if status.Ready {
		status.Message = "Public Skill PVC 已就绪"
	} else {
		status.Message = "Public Skill PVC 已创建，等待存储绑定"
	}
	return status
}

func pvcHasAccessMode(pvc *corev1.PersistentVolumeClaim, mode corev1.PersistentVolumeAccessMode) bool {
	for _, accessMode := range pvc.Spec.AccessModes {
		if accessMode == mode {
			return true
		}
	}
	return false
}

func (d *K8sDriver) publicSkillsSyncTargetDir() (string, error) {
	root := strings.TrimSpace(d.publicSkillsMount)
	if root == "" {
		return "", ErrInvalidPodSpec
	}
	target := filepath.Join(filepath.Clean(root), dockerActivePublicSkillsDir)
	if !pathInside(filepath.Clean(root), target) {
		return "", ErrInvalidPodSpec
	}
	return target, nil
}

func (d *K8sDriver) ensurePublicSkillsActiveDir() error {
	target, err := d.publicSkillsSyncTargetDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(target, dockerPublicSkillsDirMode); err != nil {
		return fmt.Errorf("create public Skill active directory: %w", err)
	}
	if err := os.Chmod(target, dockerPublicSkillsDirMode); err != nil {
		return fmt.Errorf("chmod public Skill active directory: %w", err)
	}
	return nil
}

func publicSkillsRoot(sourceDir string) (string, error) {
	root := filepath.Clean(strings.TrimSpace(sourceDir))
	if root == "." || root == "" {
		return "", ErrInvalidPodSpec
	}
	if stat, err := os.Stat(root); err == nil && stat.IsDir() {
		return root, nil
	} else if os.IsNotExist(err) {
		return root, nil
	} else if err != nil {
		return "", fmt.Errorf("stat public Skill root: %w", err)
	}
	return "", fmt.Errorf("public Skill root is not a directory")
}

func publicSkillIndexBody(root string) (string, error) {
	configured, err := os.ReadFile(filepath.Join(root, publicSkillIndexFile))
	if err == nil {
		return sanitizePublicSkillIndex(string(configured)), nil
	}
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("read public Skill index: %w", err)
	}
	names, err := publicSkillDirectoryNames(root)
	if err != nil {
		return "", err
	}
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return body, nil
}

func sanitizePublicSkillIndex(raw string) string {
	seen := map[string]struct{}{}
	names := []string{}
	for _, line := range strings.Split(raw, "\n") {
		name := strings.TrimSpace(line)
		if !safePublicSkillName(name) {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	sort.Strings(names)
	body := strings.Join(names, "\n")
	if body != "" {
		body += "\n"
	}
	return body
}

func publicSkillDirectoryNames(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read public Skill root: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && safePublicSkillName(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func safePublicSkillArchivePath(name string) bool {
	parts := strings.Split(name, "/")
	return len(parts) > 0 && safePublicSkillName(parts[0])
}

func safePublicSkillName(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") || strings.Contains(name, "..") {
		return false
	}
	return !strings.ContainsAny(name, `/\:`)
}

func uniqueSortedStrings(values []string) []string {
	sort.Strings(values)
	if len(values) < 2 {
		return values
	}
	write := 1
	for read := 1; read < len(values); read++ {
		if values[read] != values[read-1] {
			values[write] = values[read]
			write++
		}
	}
	return values[:write]
}

func pathInside(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

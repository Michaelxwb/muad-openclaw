package driver

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const publicSkillIndexFile = ".muad-public-index"

// SyncPublicSkills mirrors active public Skills into the Docker runtime mount
// directory. The upload source stays untouched so disabled/deleted Skills can be
// kept in Console storage without remaining visible inside workers.
func (d *DockerDriver) SyncPublicSkills(_ context.Context, _ string, sourceDir string) error {
	if strings.TrimSpace(sourceDir) == "" {
		return ErrInvalidPodSpec
	}
	targetDir := d.publicSkillsHostDir()
	if targetDir == "" {
		return ErrInvalidPodSpec
	}
	return syncDirectoryContents(sourceDir, targetDir)
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
	if err := clearDirectoryContents(targetAbs); err != nil {
		return err
	}
	if err := copyPublicSkillTree(sourceAbs, targetAbs); err != nil {
		return err
	}
	return os.Chmod(targetAbs, dockerPublicSkillsDirMode)
}

func clearDirectoryContents(targetRoot string) error {
	entries, err := os.ReadDir(targetRoot)
	if err != nil {
		return fmt.Errorf("read public Skill target directory: %w", err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(targetRoot, entry.Name())); err != nil {
			return fmt.Errorf("remove public Skill target entry: %w", err)
		}
	}
	return nil
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

// SyncPublicSkills streams Console-managed public Skills into the running k8s
// worker. The index file lets future syncs remove only directories previously
// managed by Console without touching image-bundled Skills.
func (d *K8sDriver) SyncPublicSkills(ctx context.Context, podID, sourceDir string) error {
	payload, err := buildPublicSkillsArchive(sourceDir)
	if err != nil {
		return err
	}
	if d.skillsPVC != "" {
		if err := d.ensurePublicSkillsPVCReady(ctx); err != nil {
			return err
		}
		if err := d.ensurePublicSkillsMount(ctx, podID); err != nil {
			return err
		}
		return d.syncPublicSkillsToPVC(ctx, podID, payload)
	}
	_, err = d.ExecStdin(ctx, podID, bytes.NewReader(payload), "sh", "-lc", publicSkillSyncScript(d.runtime.withDefaults().PublicSkillsDir))
	return err
}

func (d *K8sDriver) ensurePublicSkillsPVCReady(ctx context.Context) error {
	status, err := d.PublicSkillsStorageStatus(ctx)
	if err != nil {
		return err
	}
	if !status.Ready {
		return fmt.Errorf("%w: public Skill PVC %s is not ready: %s", ErrRuntimeNotReady, d.skillsPVC, status.Phase)
	}
	return nil
}

func (d *K8sDriver) ensurePublicSkillsMount(ctx context.Context, podID string) error {
	deps := d.client.AppsV1().Deployments(d.namespace)
	name := ContainerName(podID)
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
	_, err = deps.Update(ctx, dep, metav1.UpdateOptions{})
	return err
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
	return left.Name == right.Name && left.MountPath == right.MountPath && left.ReadOnly == right.ReadOnly
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
	return d.statusFromPublicSkillsPVC(pvc), nil
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
	status := PublicSkillsStorageStatus{
		Driver: "k8s", Name: d.skillsPVC, Namespace: d.namespace,
		Configured: strings.TrimSpace(d.skillsPVC) != "",
		AccessMode: "ReadWriteMany", StorageClass: d.skillsStorageClass, Size: d.skillsSize,
	}
	if !status.Configured {
		status.Message = "未配置 k8sSkillsPVC"
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

func (d *K8sDriver) syncPublicSkillsToPVC(ctx context.Context, podID string, payload []byte) error {
	image, err := d.workerImage(ctx, podID)
	if err != nil {
		return err
	}
	name := fmt.Sprintf("muad-skills-sync-%d", time.Now().UnixNano())
	if err := d.createSkillsSyncPod(ctx, name, image); err != nil {
		return err
	}
	defer func() {
		_ = d.client.CoreV1().Pods(d.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}()
	if err := d.waitForExactPodRunning(ctx, name); err != nil {
		return err
	}
	_, err = d.execStdinInPod(ctx, name, bytes.NewReader(payload), "sh", "-lc", publicSkillSyncScript(d.runtime.withDefaults().PublicSkillsDir))
	return err
}

func (d *K8sDriver) workerImage(ctx context.Context, podID string) (string, error) {
	dep, err := d.client.AppsV1().Deployments(d.namespace).Get(
		ctx, ContainerName(podID), metav1.GetOptions{},
	)
	if err != nil {
		return "", err
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return "", ErrRuntimeNotReady
	}
	return dep.Spec.Template.Spec.Containers[0].Image, nil
}

func (d *K8sDriver) createSkillsSyncPod(ctx context.Context, name, image string) error {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: map[string]string{"app": "muad-skills-sync"}},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Volumes: []corev1.Volume{{
				Name: "skills",
				VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: d.skillsPVC,
				}},
			}},
			Containers: []corev1.Container{{
				Name: "sync", Image: image, Command: []string{"sh", "-lc", "sleep 300"},
				VolumeMounts: []corev1.VolumeMount{{Name: "skills", MountPath: d.runtime.withDefaults().PublicSkillsDir}},
			}},
		},
	}
	_, err := d.client.CoreV1().Pods(d.namespace).Create(ctx, pod, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (d *K8sDriver) waitForExactPodRunning(ctx context.Context, name string) error {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		pod, err := d.client.CoreV1().Pods(d.namespace).Get(ctx, name, metav1.GetOptions{})
		if err == nil && pod.Status.Phase == corev1.PodRunning {
			return nil
		}
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("%w: Skill sync Pod %s not running", ErrRuntimeNotReady, name)
}

func publicSkillSyncScript(publicSkillsDir string) string {
	return fmt.Sprintf(`
set -eu
public_skills_dir=%s
mkdir -p "$public_skills_dir"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
tar -xzf - -C "$tmp_dir"
cd "$public_skills_dir"
for index_file in "$public_skills_dir/.muad-public-index" "$tmp_dir/.muad-public-index"; do
  if [ -f "$index_file" ]; then
    while IFS= read -r name; do
      case "$name" in ""|.*|*/*|*..*) continue ;; esac
      rm -rf -- "$public_skills_dir/$name"
    done < "$index_file"
  fi
done
tar -cf - -C "$tmp_dir" . | tar -xf - -C "$public_skills_dir"
`, shellQuote(publicSkillsDir))
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func buildPublicSkillsArchive(sourceDir string) ([]byte, error) {
	root, err := publicSkillsRoot(sourceDir)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	if err := addPublicSkillIndex(tw, root); err != nil {
		return nil, err
	}
	if err := addPublicSkillFiles(tw, root); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("close public Skill archive: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("close public Skill gzip: %w", err)
	}
	return out.Bytes(), nil
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

func addPublicSkillIndex(tw *tar.Writer, root string) error {
	body, err := publicSkillIndexBody(root)
	if err != nil {
		return err
	}
	return addTarBytes(tw, publicSkillIndexFile, []byte(body), 0o600)
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

func addPublicSkillFiles(tw *tar.Writer, root string) error {
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil
	}
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return addPublicSkillPath(tw, root, path, entry)
	})
}

func addPublicSkillPath(tw *tar.Writer, root, path string, entry fs.DirEntry) error {
	if path == root {
		return nil
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return err
	}
	name := filepath.ToSlash(rel)
	if !safePublicSkillArchivePath(name) {
		return nil
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	if entry.IsDir() {
		return addTarHeader(tw, name+"/", info, tar.TypeDir)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	return addTarFile(tw, name, path, info)
}

func addTarFile(tw *tar.Writer, name, path string, info fs.FileInfo) error {
	if err := addTarHeader(tw, name, info, tar.TypeReg); err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(tw, file)
	return err
}

func addTarBytes(tw *tar.Writer, name string, body []byte, mode int64) error {
	header := &tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	_, err := tw.Write(body)
	return err
}

func addTarHeader(tw *tar.Writer, name string, info fs.FileInfo, typ byte) error {
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = name
	header.Typeflag = typ
	return tw.WriteHeader(header)
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

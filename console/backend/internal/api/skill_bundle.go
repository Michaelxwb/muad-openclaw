package api

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
)

var (
	skillNameRegexp     = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	skillPlatformRegexp = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

type skillBundleManifest struct {
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	Runtime         string   `json:"runtime"`
	Mode            string   `json:"mode"`
	Visibility      string   `json:"visibility"`
	Platform        string   `json:"platform"`
	Platforms       []string `json:"platforms"`
	Progress        any      `json:"progress"`
	BrowserRequired bool     `json:"browserRequired"`
	LongTask        bool     `json:"longTask"`
	Capabilities    []string `json:"capabilities"`
	Entrypoint      string   `json:"entrypoint"`
	Scripts         []string `json:"scripts"`
}

type skillMarkdownMetadata struct {
	Present     bool
	Name        string
	Description string
}

type skillBundleIssue struct {
	code     int
	detailZH string
	detailEN string
	cause    error
}

func (err *skillBundleIssue) Error() string {
	detail := strings.TrimSpace(err.detailEN)
	if detail == "" {
		detail = strings.TrimSpace(err.detailZH)
	}
	if err.cause != nil && detail != "" {
		return detail + ": " + err.cause.Error()
	}
	if err.cause != nil {
		return err.cause.Error()
	}
	return detail
}

func (err *skillBundleIssue) Unwrap() error {
	return err.cause
}

func (err *skillBundleIssue) detail(lang langCode) string {
	detail := strings.TrimSpace(err.detailZH)
	if lang == langEN && strings.TrimSpace(err.detailEN) != "" {
		detail = strings.TrimSpace(err.detailEN)
	}
	if err.cause != nil && detail != "" {
		return detail + ": " + err.cause.Error()
	}
	if err.cause != nil {
		return err.cause.Error()
	}
	return detail
}

func skillBundleError(code int, zh, en string) error {
	return &skillBundleIssue{code: code, detailZH: zh, detailEN: en}
}

func skillBundleErrorf(code int, zh, en string, args ...any) error {
	return skillBundleError(code, fmt.Sprintf(zh, args...), fmt.Sprintf(en, args...))
}

func skillBundleWrap(code int, cause error, zh, en string, args ...any) error {
	return &skillBundleIssue{
		code: code, detailZH: fmt.Sprintf(zh, args...), detailEN: fmt.Sprintf(en, args...),
		cause: cause,
	}
}

func installPublicSkillBundle(
	bundle []byte, publicRoot string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	root, err := resolvePublicSkillRoot(publicRoot)
	if err != nil {
		return privateSkillInstallResult{}, skillBundleWrap(
			errcode.InvalidSkillBundle, err,
			"Public Skill 存储目录配置不可用，无法保存上传的 Skill",
			"Public Skill storage root is not usable; the uploaded Skill cannot be saved",
		)
	}
	return installSkillBundleToRoot(bundle, root, "", "public", validateName)
}

func installPrivateSkillBundle(
	bundle []byte, skillsRoot, humanUserID, expectedName string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	root, err := resolvePrivateSkillRoot(skillsRoot, humanUserID)
	if err != nil {
		return privateSkillInstallResult{}, skillBundleWrap(
			errcode.InvalidSkillBundle, err,
			"Private Skill 存储目录配置不可用，无法保存上传的 Skill",
			"Private Skill storage root is not usable; the uploaded Skill cannot be saved",
		)
	}
	return installSkillBundleToRoot(bundle, root, expectedName, "private", validateName)
}

func installSkillBundleToRoot(
	bundle []byte, root, expectedName, defaultVisibility string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	tempRoot, err := os.MkdirTemp("", "muad-public-skill-")
	if err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("create temp Skill dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(tempRoot) }()
	extractRoot := filepath.Join(tempRoot, "extract")
	if err := os.MkdirAll(extractRoot, 0o700); err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("create extract dir: %w", err)
	}
	if err := extractSkillBundle(bundle, extractRoot); err != nil {
		return privateSkillInstallResult{}, err
	}
	skillDir, err := findPrimarySkillDir(extractRoot)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	metadata, err := readSkillBundleMetadata(skillDir, defaultVisibility)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	if expected := strings.TrimSpace(expectedName); expected != "" && metadata.Name != expected {
		return privateSkillInstallResult{}, skillBundleErrorf(
			errcode.SkillBundleUnexpectedName,
			"上传包里的 Skill 名称是 %q，但当前操作期望名称是 %q；请修改 SKILL.md frontmatter name 或 muad.skill.json.name 后重新打包",
			"Uploaded Skill name is %q, but this operation expects %q; update SKILL.md frontmatter name or muad.skill.json.name and repackage",
			metadata.Name, expected,
		)
	}
	if validateName != nil {
		if err := validateName(metadata.Name); err != nil {
			return privateSkillInstallResult{}, err
		}
	}
	targetDir := filepath.Join(root, metadata.Name)
	if !pathWithin(root, targetDir) {
		return privateSkillInstallResult{}, skillBundleErrorf(
			errcode.SkillBundleUnsafePath,
			"Skill 名称 %q 生成的目标路径会逃逸存储目录",
			"Skill name %q resolves outside the storage root",
			metadata.Name,
		)
	}
	if err := replaceSkillDirectory(skillDir, targetDir); err != nil {
		return privateSkillInstallResult{}, err
	}
	metadata.TargetDir = targetDir
	return metadata, nil
}

func resolvePrivateSkillRoot(skillsRoot, humanUserID string) (string, error) {
	root, err := resolvePublicSkillRoot(skillsRoot)
	if err != nil {
		return "", err
	}
	userID := strings.TrimSpace(humanUserID)
	if userID == "" || strings.ContainsAny(userID, `/\:`) || strings.Contains(userID, "..") {
		return "", errors.New("invalid human user")
	}
	target := filepath.Join(root, "_private", userID)
	if !pathWithin(root, target) {
		return "", errors.New("target path escapes private Skill root")
	}
	return target, nil
}

func resolvePublicSkillRoot(publicRoot string) (string, error) {
	root := filepath.Clean(strings.TrimSpace(publicRoot))
	if root == "" {
		return "", errors.New("empty public Skill root")
	}
	if filepath.IsAbs(root) {
		return root, nil
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve public Skill root: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func extractSkillBundle(bundle []byte, targetRoot string) error {
	if err := extractTarGzSkillBundle(bundle, targetRoot); err == nil {
		return nil
	} else if !isInvalidArchiveBundle(err) {
		return err
	}
	if err := extractZipSkillBundle(bundle, targetRoot); err != nil {
		return skillBundleWrap(
			errcode.InvalidBundleFormat, err,
			"上传文件内容不是有效的 .tar.gz 或 .zip 压缩包",
			"Uploaded file content is not a valid .tar.gz or .zip archive",
		)
	}
	return nil
}

func isInvalidArchiveBundle(err error) bool {
	return skillBundleErrorCode(err) == errcode.InvalidBundleFormat
}

func extractTarGzSkillBundle(bundle []byte, targetRoot string) error {
	gz, err := gzip.NewReader(bytes.NewReader(bundle))
	if err != nil {
		return skillBundleWrap(
			errcode.InvalidBundleFormat, err,
			"上传文件内容不是有效的 tar.gz 压缩包",
			"Uploaded file content is not a valid tar.gz archive",
		)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return skillBundleWrap(
				errcode.InvalidBundleFormat, err,
				"读取 tar.gz 压缩包失败，文件可能已损坏",
				"Failed to read the tar.gz archive; the file may be corrupted",
			)
		}
		relative, err := safeArchivePath(header.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, filepath.FromSlash(relative))
		if !pathWithin(targetRoot, target) {
			return skillBundleErrorf(
				errcode.SkillBundleUnsafePath,
				"归档路径 %q 会逃逸解压目录",
				"Archive path %q escapes the extract root",
				header.Name,
			)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return fmt.Errorf("create bundle dir: %w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return fmt.Errorf("create bundle parent: %w", err)
			}
			if err := writeBundleFile(target, reader, header.Size); err != nil {
				return err
			}
		case tar.TypeSymlink, tar.TypeLink:
			return skillBundleErrorf(
				errcode.SkillBundleLink,
				"归档条目 %q 是软链接或硬链接，Skill 包不允许包含链接",
				"Archive entry %q is a symbolic or hard link; links are not allowed",
				header.Name,
			)
		default:
			continue
		}
	}
}

func extractZipSkillBundle(bundle []byte, targetRoot string) error {
	reader, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		return skillBundleWrap(
			errcode.InvalidBundleFormat, err,
			"上传文件内容不是有效的 zip 压缩包",
			"Uploaded file content is not a valid zip archive",
		)
	}
	for _, file := range reader.File {
		if ignoredZipEntry(file.Name) {
			continue
		}
		if err := extractZipEntry(file, targetRoot); err != nil {
			return err
		}
	}
	return nil
}

func extractZipEntry(file *zip.File, targetRoot string) error {
	relative, err := safeArchivePath(file.Name)
	if err != nil {
		return err
	}
	target := filepath.Join(targetRoot, filepath.FromSlash(relative))
	if !pathWithin(targetRoot, target) {
		return skillBundleErrorf(
			errcode.SkillBundleUnsafePath,
			"归档路径 %q 会逃逸解压目录",
			"Archive path %q escapes the extract root",
			file.Name,
		)
	}
	mode := file.FileInfo().Mode()
	if mode&os.ModeSymlink != 0 {
		return skillBundleErrorf(
			errcode.SkillBundleLink,
			"zip 条目 %q 是软链接，Skill 包不允许包含链接",
			"Zip entry %q is a symbolic link; links are not allowed",
			file.Name,
		)
	}
	if file.FileInfo().IsDir() || zipNameIsDirectory(file.Name) {
		return os.MkdirAll(target, 0o700)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create bundle parent: %w", err)
	}
	source, err := file.Open()
	if err != nil {
		return fmt.Errorf("open zip entry: %w", err)
	}
	defer source.Close()
	return writeBundleFile(target, source, int64(file.UncompressedSize64))
}

func ignoredZipEntry(name string) bool {
	normalized := strings.Trim(strings.ReplaceAll(name, "\\", "/"), "/")
	return normalized == "" || normalized == "__MACOSX" ||
		strings.HasPrefix(normalized, "__MACOSX/") ||
		normalized == ".DS_Store" || strings.HasSuffix(normalized, "/.DS_Store")
}

func zipNameIsDirectory(name string) bool {
	return strings.HasSuffix(strings.ReplaceAll(name, "\\", "/"), "/")
}

func writeBundleFile(target string, reader io.Reader, size int64) error {
	if size < 0 {
		return skillBundleError(
			errcode.InvalidSkillBundle,
			"压缩包里存在非法文件大小",
			"The archive contains an invalid file size",
		)
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create bundle file: %w", err)
	}
	defer file.Close()
	if _, err := io.Copy(file, reader); err != nil {
		return fmt.Errorf("write bundle file: %w", err)
	}
	return nil
}

func safeArchivePath(name string) (string, error) {
	normalized := strings.ReplaceAll(name, "\\", "/")
	if normalized == "" {
		return "", skillBundleError(
			errcode.SkillBundleUnsafePath,
			"压缩包里存在空路径条目",
			"The archive contains an empty path entry",
		)
	}
	if strings.HasPrefix(normalized, "/") {
		return "", skillBundleErrorf(
			errcode.SkillBundleUnsafePath,
			"归档路径 %q 是绝对路径，必须使用相对路径",
			"Archive path %q is absolute; use a relative path",
			name,
		)
	}
	if strings.Contains(normalized, ":") {
		return "", skillBundleErrorf(
			errcode.SkillBundleUnsafePath,
			"归档路径 %q 包含冒号，可能是 Windows 盘符或特殊路径，禁止上传",
			"Archive path %q contains a colon, which may be a Windows drive or special path and is not allowed",
			name,
		)
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return "", skillBundleErrorf(
			errcode.SkillBundleUnsafePath,
			"归档路径 %q 包含 ..，会逃逸 Skill 目录",
			"Archive path %q contains .. and would escape the Skill directory",
			name,
		)
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == ".." {
			return "", skillBundleErrorf(
				errcode.SkillBundleUnsafePath,
				"归档路径 %q 包含 ..，会逃逸 Skill 目录",
				"Archive path %q contains .. and would escape the Skill directory",
				name,
			)
		}
	}
	return cleaned, nil
}

func findPrimarySkillDir(root string) (string, error) {
	found := make([]string, 0, 1)
	err := filepath.WalkDir(root, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return skillBundleErrorf(
				errcode.SkillBundleLink,
				"压缩包解压后发现链接条目 %q，Skill 包不允许包含软链接或硬链接",
				"Extracted bundle contains link entry %q; symbolic or hard links are not allowed",
				archiveDisplayPath(root, item),
			)
		}
		if !entry.IsDir() && filepath.Base(item) == "SKILL.md" {
			found = append(found, filepath.Dir(item))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(found) == 0 {
		return "", skillBundleError(
			errcode.SkillBundleNoSkillMd,
			"压缩包内没有找到主 SKILL.md；请把 Skill 说明文件命名为 SKILL.md 并放在 Skill 根目录",
			"The archive does not contain a primary SKILL.md; name the Skill instruction file SKILL.md and place it in the Skill root",
		)
	}
	sortSkillDirs(root, found)
	topDepth := archivePathDepth(root, found[0])
	topLevelRoots := 1
	for _, candidate := range found[1:] {
		if archivePathDepth(root, candidate) != topDepth {
			break
		}
		topLevelRoots++
	}
	if topLevelRoots > 1 {
		return "", skillBundleErrorf(
			errcode.SkillBundleMultiRoot,
			"压缩包内发现多个同层 Skill 根目录：%s；请拆成多个 Skill 包分别上传",
			"The archive contains multiple peer Skill roots: %s; split them into separate Skill bundles",
			strings.Join(relativeSkillDirs(root, found[:topLevelRoots]), ", "),
		)
	}
	return found[0], nil
}

func archiveDisplayPath(root, item string) string {
	relative, err := filepath.Rel(root, item)
	if err != nil {
		return filepath.ToSlash(filepath.Base(item))
	}
	return filepath.ToSlash(relative)
}

func relativeSkillDirs(root string, dirs []string) []string {
	out := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		out = append(out, archiveDisplayPath(root, dir))
	}
	return out
}

func readSkillBundleMetadata(skillDir, defaultVisibility string) (privateSkillInstallResult, error) {
	skillMarkdown, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		return privateSkillInstallResult{}, skillBundleWrap(
			errcode.SkillBundleNoSkillMd, err,
			"读取主 SKILL.md 失败",
			"Failed to read the primary SKILL.md",
		)
	}
	manifest, managed, err := readSkillManifest(filepath.Join(skillDir, "muad.skill.json"))
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	frontmatter := skillMarkdownFrontmatter(string(skillMarkdown))
	name := firstSkillName(manifest.Name, frontmatter.Name, filepath.Base(skillDir))
	if name == "" || !skillNameRegexp.MatchString(name) {
		return privateSkillInstallResult{}, invalidSkillNameError(
			manifest.Name, frontmatter.Name, filepath.Base(skillDir),
		)
	}
	if err := validateOpenClawSkillMetadata(manifest, frontmatter, name, defaultVisibility); err != nil {
		return privateSkillInstallResult{}, err
	}
	platforms, err := normalizeSkillPlatforms(manifest)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	scriptFiles, err := scanTraditionalSkillScripts(skillDir)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	entryType := classifySkillEntryType(managed, scriptFiles)
	// Progress telemetry is disabled in the minimal runtime until a new audited
	// execution layer owns it end to end.
	progressSupported := false
	browserRequired := manifest.BrowserRequired || stringSliceContains(manifest.Capabilities, "browser")
	longTask := manifest.LongTask
	if err := ensureLongTaskSubmitStub(skillDir, name, longTask); err != nil {
		return privateSkillInstallResult{}, err
	}
	metadata := map[string]any{
		"name": name, "version": strings.TrimSpace(manifest.Version),
		"runtime": manifest.Runtime, "mode": manifest.Mode,
		"visibility": valueOrDefault(manifest.Visibility, skillDefaultVisibility(defaultVisibility)),
		"platforms":  platforms, "progressSupported": progressSupported,
		"browserRequired": browserRequired, "entryType": entryType, "longTask": longTask,
	}
	if managed {
		managedScripts := make([]string, 0)
		if manifest.Entrypoint != "" {
			managedScripts = append(managedScripts, manifest.Entrypoint)
		}
		if len(manifest.Scripts) > 0 {
			managedScripts = append(managedScripts, manifest.Scripts...)
		}
		for _, sf := range scriptFiles {
			if sf != "" {
				managedScripts = append(managedScripts, sf)
			}
		}
		metadata["hasScripts"] = len(managedScripts) > 0
		metadata["scriptFiles"] = managedScripts
	} else {
		metadata["runtime"] = "traditional"
		metadata["hasScripts"] = len(scriptFiles) > 0
		metadata["scriptFiles"] = scriptFiles
	}
	manifestJSON, err := json.Marshal(metadata)
	if err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("marshal Skill manifest: %w", err)
	}
	manifestHash, err := hashSkillDirectory(skillDir)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	return privateSkillInstallResult{
		OK: true, Name: name, Version: strings.TrimSpace(manifest.Version),
		Platforms: platforms, ProgressSupported: progressSupported,
		BrowserRequired: browserRequired, LongTask: longTask, EntryType: entryType,
		ManifestHash: manifestHash, ManifestJSON: string(manifestJSON),
	}, nil
}

func ensureLongTaskSubmitStub(skillDir, name string, longTask bool) error {
	if !longTask {
		return nil
	}
	stubPath := filepath.Join(skillDir, "_longtask_submit.md")
	if err := os.WriteFile(stubPath, []byte(longTaskSubmitStub(name)), 0o600); err != nil {
		return skillBundleWrap(
			errcode.InvalidSkillBundle, err,
			"为 longTask Skill 写入 _longtask_submit.md 失败",
			"Failed to write _longtask_submit.md for the longTask Skill",
		)
	}
	return nil
}

func longTaskSubmitStub(name string) string {
	return `# Long Task

This Skill runs as a background task. Do not execute the real task in the current conversation, and do not run any tools or scripts for it.

Reply to the user with one short confirmation in the user's language (for Chinese users, reply in Chinese), for example:

好的，正在后台为你执行「` + name + `」，完成后结果会自动推送给你，可继续发消息。

Do not output any special marker or machine-readable first line.
`
}

func skillDefaultVisibility(value string) string {
	if strings.TrimSpace(value) == "private" {
		return "private"
	}
	return "public"
}

func hashSkillDirectory(skillDir string) (string, error) {
	files := make([]string, 0)
	err := filepath.WalkDir(skillDir, func(item string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return skillBundleErrorf(
				errcode.SkillBundleLink,
				"Skill 目录里的路径 %q 是链接，Skill 包不允许包含软链接或硬链接",
				"Skill directory path %q is a link; symbolic or hard links are not allowed",
				archiveDisplayPath(skillDir, item),
			)
		}
		if item != skillDir && entry.IsDir() && ignoredSkillScriptDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(skillDir, item)
		if err != nil || !pathWithin(skillDir, item) {
			return skillBundleErrorf(
				errcode.SkillBundleUnsafePath,
				"Skill 文件路径 %q 会逃逸 Skill 根目录",
				"Skill file path %q escapes the Skill root",
				archiveDisplayPath(skillDir, item),
			)
		}
		files = append(files, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	hash := sha256.New()
	separator := []byte{0}
	for _, file := range files {
		content, err := os.ReadFile(filepath.Join(skillDir, filepath.FromSlash(file)))
		if err != nil {
			return "", skillBundleWrap(
				errcode.InvalidSkillBundle, err,
				"读取 Skill 文件 %q 计算内容指纹失败",
				"Failed to read Skill file %q while computing the content hash",
				file,
			)
		}
		hash.Write([]byte(file))
		hash.Write(separator)
		hash.Write(content)
		hash.Write(separator)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func readSkillManifest(path string) (skillBundleManifest, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return skillBundleManifest{}, false, nil
	}
	if err != nil {
		return skillBundleManifest{}, false, skillBundleWrap(
			errcode.SkillBundleInvalidManifest, err,
			"读取 muad.skill.json 失败",
			"Failed to read muad.skill.json",
		)
	}
	var manifest skillBundleManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return skillBundleManifest{}, false, skillBundleWrap(
			errcode.SkillBundleInvalidManifest, err,
			"muad.skill.json 不是合法 JSON",
			"muad.skill.json is not valid JSON",
		)
	}
	return manifest, true, nil
}

func classifySkillEntryType(managed bool, scriptFiles []string) string {
	if managed {
		return "managed"
	}
	if len(scriptFiles) > 0 {
		return "traditional-script"
	}
	return "traditional-prompt"
}

func scanTraditionalSkillScripts(skillDir string) ([]string, error) {
	scripts := make([]string, 0)
	err := filepath.WalkDir(skillDir, func(item string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return skillBundleErrorf(
				errcode.SkillBundleLink,
				"Skill 目录里的脚本路径 %q 是链接，Skill 包不允许包含软链接或硬链接",
				"Skill script path %q is a link; symbolic or hard links are not allowed",
				archiveDisplayPath(skillDir, item),
			)
		}
		if item != skillDir && entry.IsDir() && ignoredSkillScriptDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		if entry.IsDir() || !supportedSkillScriptExtension(filepath.Ext(entry.Name())) {
			return nil
		}
		relative, err := filepath.Rel(skillDir, item)
		if err != nil || !pathWithin(skillDir, item) {
			return skillBundleErrorf(
				errcode.SkillBundleUnsafePath,
				"Skill 脚本路径 %q 会逃逸 Skill 根目录",
				"Skill script path %q escapes the Skill root",
				archiveDisplayPath(skillDir, item),
			)
		}
		scripts = append(scripts, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(scripts)
	return scripts, nil
}

func ignoredSkillScriptDirectory(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__"
}

func supportedSkillScriptExtension(extension string) bool {
	switch strings.ToLower(extension) {
	case ".sh", ".py", ".js":
		return true
	default:
		return false
	}
}

func validateOpenClawSkillMetadata(
	manifest skillBundleManifest, frontmatter skillMarkdownMetadata, resolvedName, defaultVisibility string,
) error {
	if skillDefaultVisibility(defaultVisibility) != "public" {
		return nil
	}
	if !frontmatter.Present {
		return skillBundleError(
			errcode.SkillBundleFrontmatter,
			"Public Skill 的 SKILL.md 顶部缺少 YAML frontmatter；需要包含 name 和 description",
			"The Public Skill's SKILL.md is missing YAML frontmatter; include name and description",
		)
	}
	if strings.TrimSpace(frontmatter.Name) == "" {
		return skillBundleError(
			errcode.SkillBundleFrontmatter,
			"Public Skill 的 SKILL.md frontmatter 缺少 name 字段",
			"The Public Skill's SKILL.md frontmatter is missing the name field",
		)
	}
	if strings.TrimSpace(frontmatter.Description) == "" {
		return skillBundleError(
			errcode.SkillBundleFrontmatter,
			"Public Skill 的 SKILL.md frontmatter 缺少 description 字段",
			"The Public Skill's SKILL.md frontmatter is missing the description field",
		)
	}
	frontmatterName := strings.TrimSpace(frontmatter.Name)
	if !skillNameRegexp.MatchString(frontmatterName) {
		return invalidSkillNameError("", frontmatterName, "")
	}
	if strings.TrimSpace(manifest.Name) != "" && normalizeSkillName(manifest.Name) != frontmatterName {
		return skillBundleErrorf(
			errcode.SkillBundleNameMismatch,
			"muad.skill.json.name 解析为 %q，但 SKILL.md frontmatter name 是 %q；两个字段必须一致",
			"muad.skill.json.name resolves to %q, but SKILL.md frontmatter name is %q; they must match",
			normalizeSkillName(manifest.Name), frontmatterName,
		)
	}
	if resolvedName != frontmatterName {
		return skillBundleErrorf(
			errcode.SkillBundleNameMismatch,
			"Skill 目录或 manifest 推导出的名称是 %q，但 SKILL.md frontmatter name 是 %q；请保持一致",
			"Skill directory or manifest resolved to %q, but SKILL.md frontmatter name is %q; keep them consistent",
			resolvedName, frontmatterName,
		)
	}
	return nil
}

func invalidSkillNameError(manifestName, frontmatterName, dirName string) error {
	values := skillNameSourceSummary(manifestName, frontmatterName, dirName)
	return skillBundleErrorf(
		errcode.SkillBundleInvalidName,
		"无法确定合法 Skill 名称（当前值：%s）；名称必须以小写字母开头，只能包含小写字母、数字、- 或 _，最长 64 个字符",
		"Unable to determine a valid Skill name (current values: %s); the name must start with a lowercase letter and contain only lowercase letters, digits, - or _, up to 64 characters",
		values,
	)
}

func skillNameSourceSummary(manifestName, frontmatterName, dirName string) string {
	parts := make([]string, 0, 3)
	if strings.TrimSpace(manifestName) != "" {
		parts = append(parts, "muad.skill.json.name="+strconvQuote(manifestName))
	}
	if strings.TrimSpace(frontmatterName) != "" {
		parts = append(parts, "SKILL.md name="+strconvQuote(frontmatterName))
	}
	if strings.TrimSpace(dirName) != "" {
		parts = append(parts, "目录名="+strconvQuote(dirName))
	}
	if len(parts) == 0 {
		return "空"
	}
	return strings.Join(parts, ", ")
}

func strconvQuote(value string) string {
	return fmt.Sprintf("%q", strings.TrimSpace(value))
}

func skillMarkdownFrontmatter(markdown string) skillMarkdownMetadata {
	normalized := strings.ReplaceAll(markdown, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return skillMarkdownMetadata{}
	}
	metadata := skillMarkdownMetadata{Present: true}
	lines := strings.Split(normalized, "\n")
	for index := 1; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if line == "---" {
			return metadata
		}
		if strings.HasPrefix(line, "name:") {
			metadata.Name = trimFrontmatterString(strings.TrimPrefix(line, "name:"))
			continue
		}
		if strings.HasPrefix(line, "description:") {
			metadata.Description = trimFrontmatterString(strings.TrimPrefix(line, "description:"))
		}
	}
	return metadata
}

func trimFrontmatterString(value string) string {
	return strings.Trim(strings.TrimSpace(value), `"'`)
}

func normalizeSkillPlatforms(manifest skillBundleManifest) ([]string, error) {
	raw := append([]string(nil), manifest.Platforms...)
	if strings.TrimSpace(manifest.Platform) != "" {
		raw = append(raw, manifest.Platform)
	}
	seen := map[string]bool{}
	platforms := make([]string, 0, len(raw))
	for _, item := range raw {
		if strings.TrimSpace(item) == "" {
			continue
		}
		platform := normalizePlatformName(item)
		if platform == "" {
			return nil, skillBundleErrorf(
				errcode.SkillBundleInvalidPlatform,
				"muad.skill.json 的 platform/platforms 包含非法平台名 %q；只能使用小写字母、数字或 _，且必须以字母开头",
				"muad.skill.json platform/platforms contains invalid platform name %q; use lowercase letters, digits, or _, starting with a letter",
				item,
			)
		}
		if seen[platform] {
			continue
		}
		seen[platform] = true
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	return platforms, nil
}

func sortSkillDirs(root string, dirs []string) {
	sort.Slice(dirs, func(i, j int) bool {
		left := archivePathDepth(root, dirs[i])
		right := archivePathDepth(root, dirs[j])
		if left != right {
			return left < right
		}
		return dirs[i] < dirs[j]
	})
}

func archivePathDepth(root, dir string) int {
	relative, err := filepath.Rel(root, dir)
	if err != nil {
		return 999
	}
	relative = filepath.ToSlash(filepath.Clean(relative))
	if relative == "." {
		return 0
	}
	return strings.Count(relative, "/") + 1
}

func normalizeSkillName(value string) string {
	return normalizeDashedIdentifier(value, "-")
}

func firstSkillName(values ...string) string {
	for _, value := range values {
		if name := normalizeSkillName(value); name != "" {
			return name
		}
	}
	return ""
}

func normalizePlatformName(value string) string {
	name := normalizeDashedIdentifier(value, "_")
	if !skillPlatformRegexp.MatchString(name) {
		return ""
	}
	return name
}

func normalizeDashedIdentifier(value, separator string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastSeparator := false
	for _, item := range value {
		switch {
		case item >= 'a' && item <= 'z', item >= '0' && item <= '9':
			builder.WriteRune(item)
			lastSeparator = false
		case item == '-' || item == '_' || item == '.' || item == ' ':
			if builder.Len() > 0 && !lastSeparator {
				builder.WriteString(separator)
				lastSeparator = true
			}
		}
	}
	name := strings.Trim(builder.String(), separator)
	if len(name) > 64 {
		name = strings.Trim(name[:64], separator)
	}
	if name == "" || name[0] < 'a' || name[0] > 'z' {
		return ""
	}
	return name
}

func replaceSkillDirectory(source, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("create public Skill root: %w", err)
	}
	staging, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+".tmp-")
	if err != nil {
		return fmt.Errorf("create staging Skill dir: %w", err)
	}
	backup := staging + ".bak"
	defer func() { _ = os.RemoveAll(staging) }()
	if err := copySkillDirectory(source, staging); err != nil {
		return err
	}
	hadTarget := true
	if err := os.Rename(target, backup); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("stage old public Skill: %w", err)
		}
		hadTarget = false
	}
	if err := os.Rename(staging, target); err != nil {
		if restoreErr := restoreSkillDirectoryBackup(backup, target, hadTarget); restoreErr != nil {
			return errors.Join(fmt.Errorf("publish public Skill: %w", err), restoreErr)
		}
		return fmt.Errorf("publish public Skill: %w", err)
	}
	if hadTarget {
		cleanupSkillDirectoryBackup(backup, target)
	}
	return nil
}

func restoreSkillDirectoryBackup(backup, target string, hadTarget bool) error {
	if !hadTarget {
		return nil
	}
	if err := os.Rename(backup, target); err != nil {
		return fmt.Errorf("restore old public Skill: %w", err)
	}
	return nil
}

func cleanupSkillDirectoryBackup(backup, target string) {
	if err := os.RemoveAll(backup); err != nil {
		log.Printf("skill_directory_backup_cleanup_failed target=%s error=%v", target, err)
	}
}

func removePublicSkillDirectory(publicRoot, skillName string) error {
	if !skillNameRegexp.MatchString(strings.TrimSpace(skillName)) {
		return errors.New("invalid skill name")
	}
	root, err := resolvePublicSkillRoot(publicRoot)
	if err != nil {
		return errors.New("invalid public Skill root")
	}
	target := filepath.Join(root, strings.TrimSpace(skillName))
	if !pathWithin(root, target) {
		return errors.New("target path escapes public Skill root")
	}
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("remove public Skill: %w", err)
	}
	return nil
}

func copySkillDirectory(source, target string) error {
	return filepath.WalkDir(source, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return skillBundleErrorf(
				errcode.SkillBundleLink,
				"Skill 目录里的路径 %q 是链接，Skill 包不允许包含软链接或硬链接",
				"Skill directory path %q is a link; symbolic or hard links are not allowed",
				archiveDisplayPath(source, item),
			)
		}
		relative, err := filepath.Rel(source, item)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o700)
		}
		sourceFile, err := os.Open(item)
		if err != nil {
			return fmt.Errorf("open Skill file: %w", err)
		}
		defer sourceFile.Close()
		return writeCopiedFile(destination, sourceFile)
	})
}

func writeCopiedFile(target string, source io.Reader) error {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create Skill file: %w", err)
	}
	defer file.Close()
	if _, err := io.Copy(file, source); err != nil {
		return fmt.Errorf("copy Skill file: %w", err)
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func stringSliceContains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func valueOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

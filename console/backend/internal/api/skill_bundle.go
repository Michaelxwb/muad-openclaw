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
)

var (
	skillNameRegexp     = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	skillPlatformRegexp = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

const (
	maxExtractedSkillBundleBytes   = 25 * 1024 * 1024
	maxExtractedSkillBundleEntries = 2048
)

type skillBundleExtractLimits struct {
	entries   int
	totalByte int64
}

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
	Capabilities    []string `json:"capabilities"`
	Entrypoint      string   `json:"entrypoint"`
	Scripts         []string `json:"scripts"`
}

type skillMarkdownMetadata struct {
	Present     bool
	Name        string
	Description string
}

func installPublicSkillBundle(
	bundle []byte, publicRoot string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	root, err := resolvePublicSkillRoot(publicRoot)
	if err != nil {
		return privateSkillInstallResult{}, errors.New("invalid public Skill root")
	}
	return installSkillBundleToRoot(bundle, root, "", "public", validateName)
}

func installPrivateSkillBundle(
	bundle []byte, skillsRoot, humanUserID, expectedName string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	root, err := resolvePrivateSkillRoot(skillsRoot, humanUserID)
	if err != nil {
		return privateSkillInstallResult{}, errors.New("invalid private Skill root")
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
		return privateSkillInstallResult{}, errors.New("unexpected skill name")
	}
	if validateName != nil {
		if err := validateName(metadata.Name); err != nil {
			return privateSkillInstallResult{}, err
		}
	}
	targetDir := filepath.Join(root, metadata.Name)
	if !pathWithin(root, targetDir) {
		return privateSkillInstallResult{}, errors.New("target path escapes public Skill root")
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
	} else if !isInvalidTarGzBundle(err) {
		return err
	}
	if err := extractZipSkillBundle(bundle, targetRoot); err != nil {
		return fmt.Errorf("invalid skill bundle: %w", err)
	}
	return nil
}

func isInvalidTarGzBundle(err error) bool {
	return strings.HasPrefix(err.Error(), "invalid skill bundle:")
}

func extractTarGzSkillBundle(bundle []byte, targetRoot string) error {
	gz, err := gzip.NewReader(bytes.NewReader(bundle))
	if err != nil {
		return fmt.Errorf("invalid skill bundle: %w", err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	limits := &skillBundleExtractLimits{}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read skill bundle: %w", err)
		}
		relative, err := safeArchivePath(header.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, filepath.FromSlash(relative))
		if !pathWithin(targetRoot, target) {
			return errors.New("bundle path escapes extract root")
		}
		if err := limits.addEntry(); err != nil {
			return err
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
			if err := writeBundleFile(target, reader, header.Size, limits); err != nil {
				return err
			}
		case tar.TypeSymlink, tar.TypeLink:
			return errors.New("bundle must not contain links")
		default:
			continue
		}
	}
}

func extractZipSkillBundle(bundle []byte, targetRoot string) error {
	reader, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		return err
	}
	limits := &skillBundleExtractLimits{}
	for _, file := range reader.File {
		if ignoredZipEntry(file.Name) {
			continue
		}
		if err := extractZipEntry(file, targetRoot, limits); err != nil {
			return err
		}
	}
	return nil
}

func extractZipEntry(
	file *zip.File, targetRoot string, limits *skillBundleExtractLimits,
) error {
	relative, err := safeArchivePath(file.Name)
	if err != nil {
		return err
	}
	target := filepath.Join(targetRoot, filepath.FromSlash(relative))
	if !pathWithin(targetRoot, target) {
		return errors.New("bundle path escapes extract root")
	}
	mode := file.FileInfo().Mode()
	if mode&os.ModeSymlink != 0 {
		return errors.New("bundle must not contain symlinks")
	}
	if err := limits.addEntry(); err != nil {
		return err
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
	return writeBundleFile(target, source, int64(file.UncompressedSize64), limits)
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

func writeBundleFile(
	target string, reader io.Reader, size int64, limits *skillBundleExtractLimits,
) error {
	if err := limits.addBytes(size); err != nil {
		return err
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

func (limits *skillBundleExtractLimits) addEntry() error {
	limits.entries++
	if limits.entries > maxExtractedSkillBundleEntries {
		return errors.New("bundle contains too many files")
	}
	return nil
}

func (limits *skillBundleExtractLimits) addBytes(size int64) error {
	if size < 0 {
		return errors.New("bundle contains an invalid file size")
	}
	limits.totalByte += size
	if limits.totalByte > maxExtractedSkillBundleBytes {
		return errors.New("bundle extracted size is too large")
	}
	return nil
}

func safeArchivePath(name string) (string, error) {
	normalized := strings.ReplaceAll(name, "\\", "/")
	if normalized == "" || strings.HasPrefix(normalized, "/") || strings.Contains(normalized, ":") {
		return "", errors.New("bundle contains an invalid path")
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return "", errors.New("bundle contains a parent path segment")
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == ".." {
			return "", errors.New("bundle contains a parent path segment")
		}
	}
	return cleaned, nil
}

func buildSkillDirectoryBundle(sourceDir, skillName string) ([]byte, error) {
	name := strings.TrimSpace(skillName)
	if !skillNameRegexp.MatchString(name) {
		return nil, errors.New("invalid skill name")
	}
	root := filepath.Clean(strings.TrimSpace(sourceDir))
	if root == "" || root == "." {
		return nil, errors.New("empty Skill directory")
	}
	if stat, err := os.Stat(root); err != nil {
		return nil, fmt.Errorf("stat Skill directory: %w", err)
	} else if !stat.IsDir() {
		return nil, errors.New("Skill source is not a directory")
	}
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	if err := filepath.WalkDir(root, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return addSkillDirectoryBundlePath(tw, root, item, entry, name)
	}); err != nil {
		_ = tw.Close()
		_ = gz.Close()
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("close Skill archive: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("close Skill gzip: %w", err)
	}
	return out.Bytes(), nil
}

func addSkillDirectoryBundlePath(
	tw *tar.Writer, root, item string, entry fs.DirEntry, skillName string,
) error {
	relative, err := filepath.Rel(root, item)
	if err != nil {
		return err
	}
	archiveName := strings.Trim(strings.ReplaceAll(filepath.ToSlash(relative), "\\", "/"), "/")
	if archiveName == "." || archiveName == "" {
		archiveName = skillName
	} else {
		archiveName = path.Join(skillName, archiveName)
	}
	if _, err := safeArchivePath(archiveName); err != nil {
		return err
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Skill source must not contain symlinks")
	}
	if entry.IsDir() {
		return writeSkillDirectoryBundleHeader(tw, archiveName+"/", info, tar.TypeDir)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if err := writeSkillDirectoryBundleHeader(tw, archiveName, info, tar.TypeReg); err != nil {
		return err
	}
	file, err := os.Open(item)
	if err != nil {
		return fmt.Errorf("open Skill file: %w", err)
	}
	defer file.Close()
	_, err = io.Copy(tw, file)
	return err
}

func writeSkillDirectoryBundleHeader(
	tw *tar.Writer, name string, info fs.FileInfo, typ byte,
) error {
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = name
	header.Typeflag = typ
	return tw.WriteHeader(header)
}

func findPrimarySkillDir(root string) (string, error) {
	found := make([]string, 0, 1)
	err := filepath.WalkDir(root, func(item string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return errors.New("bundle must not contain symlinks")
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
		return "", errors.New("bundle must contain a SKILL.md")
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
		return "", errors.New("bundle contains multiple top-level Skill roots")
	}
	return found[0], nil
}

func readSkillBundleMetadata(skillDir, defaultVisibility string) (privateSkillInstallResult, error) {
	skillMarkdown, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("read SKILL.md: %w", err)
	}
	manifest, managed, err := readSkillManifest(filepath.Join(skillDir, "muad.skill.json"))
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	frontmatter := skillMarkdownFrontmatter(string(skillMarkdown))
	name := firstSkillName(manifest.Name, frontmatter.Name, filepath.Base(skillDir))
	if name == "" || !skillNameRegexp.MatchString(name) {
		return privateSkillInstallResult{}, errors.New("invalid skill name")
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
	metadata := map[string]any{
		"name": name, "version": strings.TrimSpace(manifest.Version),
		"runtime": manifest.Runtime, "mode": manifest.Mode,
		"visibility": valueOrDefault(manifest.Visibility, skillDefaultVisibility(defaultVisibility)),
		"platforms":  platforms, "progressSupported": progressSupported,
		"browserRequired": browserRequired, "entryType": entryType,
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
		BrowserRequired: browserRequired, EntryType: entryType,
		ManifestHash: manifestHash, ManifestJSON: string(manifestJSON),
	}, nil
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
			return errors.New("Skill directory must not contain symlinks")
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
			return errors.New("Skill file escapes bundle root")
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
			return "", fmt.Errorf("read Skill file for hash: %w", err)
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
		return skillBundleManifest{}, false, fmt.Errorf("read Skill manifest: %w", err)
	}
	var manifest skillBundleManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return skillBundleManifest{}, false, errors.New("invalid Skill manifest")
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
			return errors.New("Skill directory must not contain symlinks")
		}
		if item != skillDir && entry.IsDir() && ignoredSkillScriptDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		if entry.IsDir() || !supportedSkillScriptExtension(filepath.Ext(entry.Name())) {
			return nil
		}
		relative, err := filepath.Rel(skillDir, item)
		if err != nil || !pathWithin(skillDir, item) {
			return errors.New("Skill script escapes bundle root")
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
	if !frontmatter.Present || strings.TrimSpace(frontmatter.Name) == "" ||
		strings.TrimSpace(frontmatter.Description) == "" {
		return errors.New("public Skill SKILL.md must include OpenClaw frontmatter name and description")
	}
	frontmatterName := strings.TrimSpace(frontmatter.Name)
	if !skillNameRegexp.MatchString(frontmatterName) {
		return errors.New("invalid skill name")
	}
	if strings.TrimSpace(manifest.Name) != "" && normalizeSkillName(manifest.Name) != frontmatterName {
		return errors.New("public Skill muad.skill.json name must match SKILL.md frontmatter name")
	}
	if resolvedName != frontmatterName {
		return errors.New("public Skill name must match SKILL.md frontmatter name")
	}
	return nil
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
			return nil, errors.New("invalid platform dependency")
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
			return errors.New("bundle must not contain symlinks")
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

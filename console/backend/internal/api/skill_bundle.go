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
}

func installPublicSkillBundle(
	bundle []byte, publicRoot string, validateName func(string) error,
) (privateSkillInstallResult, error) {
	root, err := resolvePublicSkillRoot(publicRoot)
	if err != nil {
		return privateSkillInstallResult{}, errors.New("invalid public Skill root")
	}
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
	skillDir, err := findSingleSkillDir(extractRoot)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	metadata, err := readSkillBundleMetadata(skillDir)
	if err != nil {
		return privateSkillInstallResult{}, err
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
	}
	if err := extractZipSkillBundle(bundle, targetRoot); err != nil {
		return fmt.Errorf("invalid skill bundle: %w", err)
	}
	return nil
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

func findSingleSkillDir(root string) (string, error) {
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
		return "", errors.New("bundle must contain SKILL.md")
	}
	sortSkillDirs(root, found)
	return found[0], nil
}

func readSkillBundleMetadata(skillDir string) (privateSkillInstallResult, error) {
	skillMarkdown, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("read SKILL.md: %w", err)
	}
	manifest, managed, err := readSkillManifest(filepath.Join(skillDir, "muad.skill.json"))
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	name := firstSkillName(
		manifest.Name,
		skillMarkdownFrontmatterName(string(skillMarkdown)),
		filepath.Base(skillDir),
	)
	if name == "" || !skillNameRegexp.MatchString(name) {
		return privateSkillInstallResult{}, errors.New("invalid skill name")
	}
	platforms := normalizeSkillPlatforms(manifest)
	scriptFiles, err := scanTraditionalSkillScripts(skillDir)
	if err != nil {
		return privateSkillInstallResult{}, err
	}
	entryType := classifySkillEntryType(managed, scriptFiles)
	progressSupported := manifest.Progress != nil || strings.Contains(string(skillMarkdown), "muad-progress")
	browserRequired := manifest.BrowserRequired || stringSliceContains(manifest.Capabilities, "browser")
	metadata := map[string]any{
		"name": name, "version": strings.TrimSpace(manifest.Version),
		"runtime": manifest.Runtime, "mode": manifest.Mode,
		"visibility": valueOrDefault(manifest.Visibility, "public"),
		"platforms":  platforms, "progressSupported": progressSupported,
		"browserRequired": browserRequired, "entryType": entryType,
	}
	if !managed {
		metadata["runtime"] = "traditional"
		metadata["hasScripts"] = len(scriptFiles) > 0
		metadata["scriptFiles"] = scriptFiles
	}
	manifestJSON, err := json.Marshal(metadata)
	if err != nil {
		return privateSkillInstallResult{}, fmt.Errorf("marshal Skill manifest: %w", err)
	}
	return privateSkillInstallResult{
		OK: true, Name: name, Version: strings.TrimSpace(manifest.Version),
		Platforms: platforms, ProgressSupported: progressSupported,
		BrowserRequired: browserRequired, EntryType: entryType,
		ManifestHash: hashBytes(skillMarkdown), ManifestJSON: string(manifestJSON),
	}, nil
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

func skillMarkdownFrontmatterName(markdown string) string {
	normalized := strings.ReplaceAll(markdown, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return ""
	}
	lines := strings.Split(normalized, "\n")
	for index := 1; index < len(lines); index++ {
		line := strings.TrimSpace(lines[index])
		if line == "---" {
			return ""
		}
		if strings.HasPrefix(line, "name:") {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "name:")), `"'`)
		}
	}
	return ""
}

func normalizeSkillPlatforms(manifest skillBundleManifest) []string {
	raw := append([]string(nil), manifest.Platforms...)
	if strings.TrimSpace(manifest.Platform) != "" {
		raw = append(raw, manifest.Platform)
	}
	seen := map[string]bool{}
	platforms := make([]string, 0, len(raw))
	for _, item := range raw {
		platform := normalizePlatformName(item)
		if platform == "" || seen[platform] {
			continue
		}
		seen[platform] = true
		platforms = append(platforms, platform)
	}
	return platforms
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
	staging := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+".tmp")
	if err := os.RemoveAll(staging); err != nil {
		return fmt.Errorf("clean staging Skill dir: %w", err)
	}
	if err := copySkillDirectory(source, staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("remove old public Skill: %w", err)
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("publish public Skill: %w", err)
	}
	return nil
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

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
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

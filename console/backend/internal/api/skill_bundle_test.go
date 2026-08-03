package api

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectSkillBundleClassifiesTraditionalScript(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "legacy-report")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create scripts directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: legacy-report\ndescription: Legacy report Skill.\n---\n# Legacy report\n")
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "export.py"), "print('ok')\n")

	result, err := readSkillBundleMetadata(skillDir, "public")
	if err != nil {
		t.Fatalf("inspect traditional script Skill: %v", err)
	}
	if result.EntryType != "traditional-script" {
		t.Fatalf("entry type = %q, want traditional-script", result.EntryType)
	}
	var metadata struct {
		Runtime     string   `json:"runtime"`
		HasScripts  bool     `json:"hasScripts"`
		ScriptFiles []string `json:"scriptFiles"`
	}
	if err := json.Unmarshal([]byte(result.ManifestJSON), &metadata); err != nil {
		t.Fatalf("decode scanned metadata: %v", err)
	}
	if metadata.Runtime != "traditional" || !metadata.HasScripts ||
		len(metadata.ScriptFiles) != 1 || metadata.ScriptFiles[0] != "scripts/export.py" {
		t.Fatalf("traditional script metadata = %+v", metadata)
	}
}

func TestInspectSkillBundleClassifiesTraditionalPrompt(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "web-guide")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatalf("create Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: web-guide\ndescription: Web guide Skill.\n---\n# Web guide\n")

	result, err := readSkillBundleMetadata(skillDir, "public")
	if err != nil {
		t.Fatalf("inspect traditional prompt Skill: %v", err)
	}
	if result.EntryType != "traditional-prompt" {
		t.Fatalf("entry type = %q, want traditional-prompt", result.EntryType)
	}
}

func TestInspectSkillBundleUsesCallerDefaultVisibility(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "private-guide")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatalf("create Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "# Private guide\n")

	result, err := readSkillBundleMetadata(skillDir, "private")
	if err != nil {
		t.Fatalf("inspect private default Skill: %v", err)
	}
	var metadata struct {
		Visibility string `json:"visibility"`
	}
	if err := json.Unmarshal([]byte(result.ManifestJSON), &metadata); err != nil {
		t.Fatalf("decode metadata: %v", err)
	}
	if metadata.Visibility != "private" {
		t.Fatalf("visibility = %q, want private", metadata.Visibility)
	}
}

func TestInspectSkillBundlePreservesManagedManifest(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "managed-skill")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create managed Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: managed-skill\ndescription: Managed Skill.\n---\n# Managed\n")
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "muad.skill.json"), `{"name":"managed-skill","runtime":"script"}`)
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "run.py"), "print('ok')\n")

	result, err := readSkillBundleMetadata(skillDir, "public")
	if err != nil {
		t.Fatalf("inspect managed Skill: %v", err)
	}
	if result.EntryType != "managed" {
		t.Fatalf("entry type = %q, want managed", result.EntryType)
	}
}

func TestInspectSkillBundleRejectsSymlinkScript(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "linked-skill")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create linked Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: linked-skill\ndescription: Linked Skill.\n---\n# Linked\n")
	target := filepath.Join(t.TempDir(), "outside.py")
	writeSkillBundleTestFile(t, target, "print('outside')\n")
	if err := os.Symlink(target, filepath.Join(skillDir, "scripts", "run.py")); err != nil {
		t.Fatalf("create script symlink: %v", err)
	}

	if _, err := readSkillBundleMetadata(skillDir, "public"); err == nil {
		t.Fatal("expected symlink script to be rejected")
	}
}

func TestInstallPublicSkillBundle_AllowsRelativePublicRoot(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("get cwd: %v", err)
	}
	root := t.TempDir()
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir temp root: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(cwd); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	})

	result, err := installPublicSkillBundle(makeAPIZipSkillBundle(t), "public-skills", nil)
	if err != nil {
		t.Fatalf("install public Skill bundle: %v", err)
	}
	if result.Name != "web-tools-guide" {
		t.Fatalf("Skill name = %q", result.Name)
	}
	if _, err := os.ReadFile(filepath.Join(root, "public-skills", "web-tools-guide", "SKILL.md")); err != nil {
		t.Fatalf("read installed Skill: %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsInvalidManifest(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"Web Tools Guide 1.0.2/SKILL.md":        []byte("# Web\n"),
		"Web Tools Guide 1.0.2/muad.skill.json": []byte("{not json"),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid Skill manifest") {
		t.Fatalf("invalid manifest error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsMissingOpenClawFrontmatterDescription(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"missing-description/SKILL.md": []byte("---\nname: missing-description\n---\n# Missing\n"),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "OpenClaw frontmatter name and description") {
		t.Fatalf("missing frontmatter description error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsManifestFrontmatterNameMismatch(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"policy-check/SKILL.md":        []byte("---\nname: policy-check\ndescription: Policy check Skill.\n---\n# Policy\n"),
		"policy-check/muad.skill.json": []byte(`{"name":"extract"}`),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "must match SKILL.md frontmatter name") {
		t.Fatalf("frontmatter mismatch error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsTooManyEntries(t *testing.T) {
	root := t.TempDir()
	files := map[string][]byte{"many-files/SKILL.md": []byte("# Many\n")}
	for index := 0; index < maxExtractedSkillBundleEntries+1; index++ {
		files[fmt.Sprintf("many-files/file-%d.txt", index)] = []byte("x")
	}
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, files), root, nil)
	if err == nil || !strings.Contains(err.Error(), "too many files") {
		t.Fatalf("too many entries error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsExtractedSizeTooLarge(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"huge-skill/SKILL.md":    []byte("# Huge\n"),
		"huge-skill/payload.bin": bytes.Repeat([]byte{0}, maxExtractedSkillBundleBytes+1),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "extracted size is too large") {
		t.Fatalf("large extracted size error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsTarSymlink(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPITarWithSymlink(t), root, nil)
	if err == nil || !strings.Contains(err.Error(), "links") {
		t.Fatalf("tar symlink error = %v", err)
	}
}

func TestInstallPublicSkillBundle_AllowsNestedSkillMarkdownFiles(t *testing.T) {
	root := t.TempDir()
	result, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"xdr-query/SKILL.md":               []byte("---\nname: xdr-query\ndescription: XDR query Skill.\n---\n# XDR\n"),
		"xdr-query/examples/demo/SKILL.md": []byte("# Demo\n"),
	}), root, nil)
	if err != nil {
		t.Fatalf("install nested SKILL.md bundle: %v", err)
	}
	if result.Name != "xdr-query" {
		t.Fatalf("Skill name = %q", result.Name)
	}
	if _, err := os.ReadFile(filepath.Join(root, "xdr-query", "examples", "demo", "SKILL.md")); err != nil {
		t.Fatalf("read nested SKILL.md: %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsMultipleTopLevelSkillRoots(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"skill-a/SKILL.md": []byte("# A\n"),
		"skill-b/SKILL.md": []byte("# B\n"),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "multiple top-level Skill roots") {
		t.Fatalf("multiple top-level roots error = %v", err)
	}
}

func TestInstallPublicSkillBundle_RejectsMissingSkillMarkdown(t *testing.T) {
	root := t.TempDir()
	_, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"skill-a/README.md": []byte("# A\n"),
	}), root, nil)
	if err == nil || !strings.Contains(err.Error(), "must contain a SKILL.md") {
		t.Fatalf("missing SKILL.md error = %v", err)
	}
}

func TestHashSkillDirectoryUsesAllIncludedFiles(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "hash-skill")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "# Hash\n")
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "run.py"), "print('v1')\n")

	initial, err := hashSkillDirectory(skillDir)
	if err != nil {
		t.Fatalf("hash Skill directory: %v", err)
	}
	if initial != "sha256:c89fc9503b000262ffb1c772b3b6d639fe3738d349a281161f14028dd5212ab8" {
		t.Fatalf("hash = %q", initial)
	}

	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "run.py"), "print('v2')\n")
	changed, err := hashSkillDirectory(skillDir)
	if err != nil {
		t.Fatalf("hash changed Skill directory: %v", err)
	}
	if changed == initial {
		t.Fatal("expected script content change to update directory hash")
	}
}

func makeAPITarWithSymlink(t *testing.T) []byte {
	t.Helper()
	var body bytes.Buffer
	gz := gzip.NewWriter(&body)
	archive := tar.NewWriter(gz)
	writeAPITarHeader(t, archive, "linked-skill/", tar.TypeDir, 0, "")
	writeAPITarHeader(t, archive, "linked-skill/SKILL.md", tar.TypeReg, int64(len("# Linked\n")), "")
	if _, err := archive.Write([]byte("# Linked\n")); err != nil {
		t.Fatalf("write tar SKILL.md: %v", err)
	}
	writeAPITarHeader(t, archive, "linked-skill/leak", tar.TypeSymlink, 0, "/etc/passwd")
	if err := archive.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return body.Bytes()
}

func writeAPITarHeader(t *testing.T, archive *tar.Writer, name string, typ byte, size int64, link string) {
	t.Helper()
	if err := archive.WriteHeader(&tar.Header{Name: name, Typeflag: typ, Mode: 0o600, Size: size, Linkname: link}); err != nil {
		t.Fatalf("write tar header %s: %v", name, err)
	}
}

func makeAPIZipSkillBundle(t *testing.T) []byte {
	return makeAPIZipWithFiles(t, map[string][]byte{
		"web-tools-guide-1.0.2/SKILL.md": []byte("---\nname: web-tools-guide\ndescription: Web tools guide Skill.\n---\n# Web\n"),
	})
}

func makeAPIZipWithFiles(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var body bytes.Buffer
	archive := zip.NewWriter(&body)
	for name, content := range files {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatalf("create zip entry: %v", err)
		}
		if _, err := file.Write(content); err != nil {
			t.Fatalf("write zip entry: %v", err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return body.Bytes()
}

func writeSkillBundleTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

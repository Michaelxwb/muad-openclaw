package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInspectSkillBundleClassifiesTraditionalScript(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "legacy-report")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create scripts directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: legacy-report\n---\n# Legacy report\n")
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "export.py"), "print('ok')\n")

	result, err := readSkillBundleMetadata(skillDir)
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
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "---\nname: web-guide\n---\n# Web guide\n")

	result, err := readSkillBundleMetadata(skillDir)
	if err != nil {
		t.Fatalf("inspect traditional prompt Skill: %v", err)
	}
	if result.EntryType != "traditional-prompt" {
		t.Fatalf("entry type = %q, want traditional-prompt", result.EntryType)
	}
}

func TestInspectSkillBundlePreservesManagedManifest(t *testing.T) {
	skillDir := filepath.Join(t.TempDir(), "managed-skill")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o700); err != nil {
		t.Fatalf("create managed Skill directory: %v", err)
	}
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "# Managed\n")
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "muad.skill.json"), `{"name":"managed-skill","runtime":"script"}`)
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "scripts", "run.py"), "print('ok')\n")

	result, err := readSkillBundleMetadata(skillDir)
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
	writeSkillBundleTestFile(t, filepath.Join(skillDir, "SKILL.md"), "# Linked\n")
	target := filepath.Join(t.TempDir(), "outside.py")
	writeSkillBundleTestFile(t, target, "print('outside')\n")
	if err := os.Symlink(target, filepath.Join(skillDir, "scripts", "run.py")); err != nil {
		t.Fatalf("create script symlink: %v", err)
	}

	if _, err := readSkillBundleMetadata(skillDir); err == nil {
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

func TestInstallPublicSkillBundle_UsesFallbackNameWhenManifestIsLoose(t *testing.T) {
	root := t.TempDir()
	result, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"Web Tools Guide 1.0.2/SKILL.md":        []byte("# Web\n"),
		"Web Tools Guide 1.0.2/muad.skill.json": []byte("{not json"),
	}), root, nil)
	if err != nil {
		t.Fatalf("install loose public Skill bundle: %v", err)
	}
	if result.Name != "web-tools-guide-1-0-2" {
		t.Fatalf("Skill name = %q", result.Name)
	}
}

func TestInstallPublicSkillBundle_SelectsShallowSkillWhenExamplesExist(t *testing.T) {
	root := t.TempDir()
	result, err := installPublicSkillBundle(makeAPIZipWithFiles(t, map[string][]byte{
		"xdr-query/SKILL.md":               []byte("# XDR\n"),
		"xdr-query/examples/demo/SKILL.md": []byte("# Demo\n"),
	}), root, nil)
	if err != nil {
		t.Fatalf("install multi-SKILL public bundle: %v", err)
	}
	if result.Name != "xdr-query" {
		t.Fatalf("Skill name = %q", result.Name)
	}
}

func makeAPIZipSkillBundle(t *testing.T) []byte {
	return makeAPIZipWithFiles(t, map[string][]byte{
		"web-tools-guide-1.0.2/SKILL.md": []byte("---\nname: web-tools-guide\n---\n# Web\n"),
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

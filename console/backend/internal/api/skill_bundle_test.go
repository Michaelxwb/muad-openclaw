package api

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

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

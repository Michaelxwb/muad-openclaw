package skillcheck

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckBusinessSkillRequiresProgress(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "xdr-alert")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("xdr 业务系统\nsession-manager\n"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}

	findings, err := Check(Options{Root: root})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if len(findings) != 1 || findings[0].Level != "ERROR" {
		t.Fatalf("expected progress error, got %#v", findings)
	}
}

func TestCheckBusinessSkillPassesWithProgressAndSessionManager(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "xdr-alert")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("xdr 业务系统\nsession-manager\n"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "scripts", "run.sh"), []byte("muad-progress stage --stage query --text 正在查询\n"), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}

	findings, err := Check(Options{Root: root})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if len(findings) != 0 {
		t.Fatalf("expected no findings, got %#v", findings)
	}
}

func TestCheckWarnsWhenSessionManagerMissing(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "soar")
	if err := os.MkdirAll(filepath.Join(skillDir, "scripts"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("soar 业务系统\nmuad-progress\n"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}

	findings, err := Check(Options{Root: root})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if len(findings) != 1 || findings[0].Level != "WARN" {
		t.Fatalf("expected session-manager warning, got %#v", findings)
	}
}

func TestCheckValidatesMuadManifest(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, "example-long-task")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("example\n"), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "muad.skill.json"), []byte(`{"name":"example-long-task","runtime":"script","mode":"steps","steps":[{"id":"auth","title":"鉴权"}]}`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	findings, err := Check(Options{Root: root})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if len(findings) != 1 || findings[0].Message != "steps mode requires command for each step" {
		t.Fatalf("expected manifest command error, got %#v", findings)
	}
}

package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreflightS23GeneratedLongTaskGuideRequiresActualSubmission(t *testing.T) {
	dir := t.TempDir()
	if err := ensureLongTaskSubmitStub(dir, "report", true); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "_longtask_submit.md")
	contents, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"SKILL.md", "muad_submit_long_task", "accepted", "taskId", "requiredNames", "bindings"} {
		if !strings.Contains(string(contents), required) {
			t.Errorf("guide missing %q", required)
		}
	}
	if strings.Contains(string(contents), "正在后台为你执行") || strings.Contains(string(contents), "do not run any tools") {
		t.Fatal("guide retains the old implicit submission instructions")
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("guide permissions=%o", info.Mode().Perm())
	}
}

func TestPreflightS23OrdinarySkillDoesNotGenerateLongTaskGuide(t *testing.T) {
	dir := t.TempDir()
	if err := ensureLongTaskSubmitStub(dir, "ordinary", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "_longtask_submit.md")); !os.IsNotExist(err) {
		t.Fatalf("ordinary Skill unexpectedly generated a long-task guide: %v", err)
	}
}

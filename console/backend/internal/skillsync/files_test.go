package skillsync

import (
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildSkillDirectoryBundleAllowsLargeBundles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "large-skill")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("create Skill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("# Large\n"), 0o600); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
	payload := make([]byte, 6*1024*1024)
	if _, err := rand.New(rand.NewSource(1)).Read(payload); err != nil {
		t.Fatalf("fill payload: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "payload.bin"), payload, 0o600); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	bundle, err := buildSkillDirectoryBundle(root, "large-skill")
	if err != nil {
		t.Fatalf("build Skill bundle: %v", err)
	}
	if len(bundle) <= 5*1024*1024 {
		t.Fatalf("test bundle size = %d, want above 5 MiB", len(bundle))
	}
}

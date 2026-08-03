package api

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestUpsertPublicSkillAssetWithCleanupRemovesWrittenDirectoryOnError(t *testing.T) {
	root := t.TempDir()
	skillName := "cleanup-skill"
	if err := os.MkdirAll(filepath.Join(root, skillName), 0o700); err != nil {
		t.Fatalf("create Skill directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, skillName, "SKILL.md"), []byte("# cleanup\n"), 0o600); err != nil {
		t.Fatalf("write Skill file: %v", err)
	}
	want := errors.New("insert failed")
	_, _, err := upsertPublicSkillAssetWithCleanup(
		skillName,
		root,
		func(repo.SkillAsset) (repo.SkillAsset, []string, error) {
			return repo.SkillAsset{}, nil, want
		},
		repo.SkillAsset{Name: skillName},
	)
	if !errors.Is(err, want) {
		t.Fatalf("upsert error = %v, want %v", err, want)
	}
	if _, err := os.Stat(filepath.Join(root, skillName)); !os.IsNotExist(err) {
		t.Fatalf("Skill directory should be removed after upsert failure: %v", err)
	}
}

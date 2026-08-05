package test

import (
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestAgentGuidanceRoundTrip(t *testing.T) {
	store := newStore(t)

	got, err := store.GetAgentGuidance()
	if err != nil {
		t.Fatalf("GetAgentGuidance default: %v", err)
	}
	if got.UserSkill != "" || got.Memory != "" || got.Main != "" {
		t.Fatalf("default Agent guidance = %+v, want empty (renderer defaults)", got)
	}

	guidance := repo.AgentGuidance{
		UserSkill: "- 用户自建 Skill 规则 A\n- 规则 B",
		Memory:    "# 记忆规则\n- 存到 IDENTITY.md",
		Main:      "# 回退指导\n- 只引导绑定",
	}
	if err := store.SetAgentGuidance(guidance); err != nil {
		t.Fatalf("SetAgentGuidance: %v", err)
	}

	got, err = store.GetAgentGuidance()
	if err != nil {
		t.Fatalf("GetAgentGuidance after set: %v", err)
	}
	if got.UserSkill != guidance.UserSkill || got.Memory != guidance.Memory || got.Main != guidance.Main {
		t.Fatalf("Agent guidance = %+v, want %+v", got, guidance)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("Agent guidance UpdatedAt should be set")
	}

	// Overwrite idempotently (singleton id=1).
	if err := store.SetAgentGuidance(repo.AgentGuidance{UserSkill: "only"}); err != nil {
		t.Fatalf("SetAgentGuidance overwrite: %v", err)
	}
	got, err = store.GetAgentGuidance()
	if err != nil {
		t.Fatalf("GetAgentGuidance after overwrite: %v", err)
	}
	if got.UserSkill != "only" || got.Memory != "" || got.Main != "" {
		t.Fatalf("Agent guidance after overwrite = %+v", got)
	}
}

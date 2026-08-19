package test

import (
	"net/http"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

func TestAgentGuidanceRoundTrip(t *testing.T) {
	store := newStore(t)

	got, err := store.GetAgentGuidance()
	if err != nil {
		t.Fatalf("GetAgentGuidance default: %v", err)
	}
	if got.UserSkill != "" || got.Memory != "" || got.Main != "" || got.GlobalPrompt != "" {
		t.Fatalf("default Agent guidance = %+v, want empty (renderer defaults)", got)
	}

	guidance := repo.AgentGuidance{
		UserSkill:    "- 用户自建 Skill 规则 A\n- 规则 B",
		Memory:       "# 记忆规则\n- 存到 IDENTITY.md",
		Main:         "# 回退指导\n- 只引导绑定",
		GlobalPrompt: "# 全局规则\n- 用中文回答中文提问",
	}
	if err := store.SetAgentGuidance(guidance); err != nil {
		t.Fatalf("SetAgentGuidance: %v", err)
	}

	got, err = store.GetAgentGuidance()
	if err != nil {
		t.Fatalf("GetAgentGuidance after set: %v", err)
	}
	if got.UserSkill != guidance.UserSkill || got.Memory != guidance.Memory ||
		got.Main != guidance.Main || got.GlobalPrompt != guidance.GlobalPrompt {
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
	if got.UserSkill != "only" || got.Memory != "" || got.Main != "" || got.GlobalPrompt != "" {
		t.Fatalf("Agent guidance after overwrite = %+v", got)
	}
}

func TestSaveAgentGuidanceAndMarkPods_IsAtomic(t *testing.T) {
	store := newStore(t)
	createTestPod(t, store, "pod-a", 10)
	createTestPod(t, store, "pod-b", 10)
	before, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod before: %v", err)
	}

	podIDs, err := store.SaveAgentGuidanceAndMarkPods(repo.AgentGuidance{UserSkill: "shared rule"})
	if err != nil {
		t.Fatalf("SaveAgentGuidanceAndMarkPods: %v", err)
	}
	if len(podIDs) != 2 {
		t.Fatalf("affected Pod IDs = %v, want both Pods", podIDs)
	}
	guidance, err := store.GetAgentGuidance()
	if err != nil || guidance.UserSkill != "shared rule" {
		t.Fatalf("guidance after save = %+v, %v", guidance, err)
	}
	after, err := store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod after: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration+1 ||
		after.LastApplyStatus != repo.ApplyStatusPending {
		t.Fatalf("Pod not marked pending atomically: before=%+v after=%+v", before, after)
	}
}

func TestAgentGuidanceAPI_PutSavesAndQueuesAllPods(t *testing.T) {
	env := newTestEnv(t)
	createTestPod(t, env.store, "pod-a", 10)
	createTestPod(t, env.store, "pod-b", 10)
	env.reconcile.podIDs = nil

	response := env.do(http.MethodPut, "/api/v1/settings/agent-guidance",
		`{"userSkill":"rule A","memory":"memory B","main":"main C","globalPrompt":"global D"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PUT agent guidance = %d: %s", response.Code, response.Body.String())
	}
	assertQueuedPods(t, env, "pod-a", "pod-b")
	guidance, err := env.store.GetAgentGuidance()
	if err != nil || guidance.UserSkill != "rule A" || guidance.Memory != "memory B" ||
		guidance.Main != "main C" || guidance.GlobalPrompt != "global D" {
		t.Fatalf("stored guidance = %+v, %v", guidance, err)
	}
}

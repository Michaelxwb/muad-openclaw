//go:build e2e && integration

package test

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
)

func TestRuntimeFileSkillIsolation_S09(t *testing.T) {
	requireE2EEnv(t, "MUAD_E2E_DELIVERY_USER_IDS") // Dedicated test recipients for the real long-task delivery.
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) {
			h := newRuntimeFileE2E(t, kind)
			h.create(false)
			users := h.makeUsers(2)
			name := "e2e-private-isolation"
			h.uploadSkill(users[0].HumanUserID, name, "OWNER_A_ONLY", 1, false)
			h.uploadSkill(users[1].HumanUserID, name, "OWNER_B_ONLY", 1, false)
			h.uploadSkill(users[0].HumanUserID, "e2e-background", "LONG_TASK_COMPLETE", 0, true)
			h.waitConverged()
			assertRealSkillIsolation(t, h, users, name)
		})
	}
}

func assertRealSkillIsolation(t *testing.T, h *runtimeFileE2E, users []e2eUser, name string) {
	config, err := driver.DecodeRuntimeConfig(bytes.NewReader(h.snapshot().RuntimeJSON))
	if err != nil {
		t.Fatal("invalid real DTO")
	}
	roots := map[string]string{}
	system := false
	traditional := false
	longTask := false
	for _, policy := range config.Skills.Agents {
		for _, grant := range policy.Allowed {
			if grant.Name == name {
				roots[policy.AgentID] = grant.RootPath
				traditional = traditional || (grant.EntryType == "traditional-script" && len(grant.ScriptFiles) > 0)
			}
			if grant.Source == "system" {
				system = true
			}
			if grant.Name == "e2e-background" && grant.LongTask {
				longTask = true
			}
		}
	}
	if roots[users[0].AgentID] == "" || roots[users[0].AgentID] == roots[users[1].AgentID] || !traditional || !longTask {
		t.Fatal("runtime grants lost isolated paths or execution semantics")
	}
	shadow := makeZipWithFiles(t, map[string][]byte{"session-manager/SKILL.md": []byte("---\nname: session-manager\ndescription: must not override system\n---\n")})
	if h.postSkillBundle(users[0].HumanUserID, "session-manager", shadow).Code == 0 {
		t.Fatal("protected system Skill accepted a private override")
	}
	// Effective resolver must keep protected built-ins selected as system.
	for _, user := range users {
		list := e2eData[struct {
			Items []struct{ Name, EffectiveSource string }
		}](t, h.request(http.MethodGet, "/human-users/"+user.HumanUserID+"/skills", nil))
		for _, skill := range list.Items {
			if skill.Name == "session-manager" {
				if skill.EffectiveSource != "system" {
					t.Fatal("system priority lost")
				}
				system = true
			}
		}
	}
	if !system {
		t.Fatal("E2E image/Console must include protected system fixture")
	}
	assertRealSkillExecution(t, h, users, name)
}

func assertRealSkillExecution(t *testing.T, h *runtimeFileE2E, users []e2eUser, name string) {
	for i, user := range users {
		marker := []string{"OWNER_A_ONLY", "OWNER_B_ONLY"}[i]
		out, err := h.drv.Exec(h.ctx, h.podID, "openclaw", "agent", "--agent", user.AgentID, "--session-key", "agent:"+user.AgentID+":wecom:direct:"+user.ExternalID, "--message", "Use the "+name+" Skill, read its SKILL.md and execute scripts/run.mjs. Return its actual output.", "--json", "--timeout", "120")
		if err != nil || !strings.Contains(out, marker) || strings.Contains(out, []string{"OWNER_B_ONLY", "OWNER_A_ONLY"}[i]) {
			t.Fatal("real guard/script user isolation failed")
		}
		assertSkillAudit(t, h, user, name)
	}
	_, err := h.drv.Exec(h.ctx, h.podID, "openclaw", "agent", "--agent", users[0].AgentID, "--session-key", "agent:"+users[0].AgentID+":wecom:direct:"+users[0].ExternalID, "--message", "/skill:e2e-background Execute its actual script and report the result.", "--json", "--timeout", "120")
	if err != nil {
		t.Fatal("real background submission failed")
	}
	assertLongTask(t, h, users[0])
	for _, user := range users {
		stored := e2eHumanUser(t, h.request(http.MethodGet, "/human-users/"+user.HumanUserID, nil))
		if stored.ModelConfigID != user.ModelConfigID {
			t.Fatal("model binding changed")
		}
	}
}

func assertSkillAudit(t *testing.T, h *runtimeFileE2E, user e2eUser, name string) {
	deadline := time.Now().Add(time.Minute)
	for {
		list := e2eData[struct {
			Items []struct{ HumanUserID, AgentID, SkillName string }
		}](t, h.request(http.MethodGet, "/skill-executions?humanUserId="+user.HumanUserID, nil))
		for _, record := range list.Items {
			if record.SkillName == name {
				if record.HumanUserID != user.HumanUserID || record.AgentID != user.AgentID {
					t.Fatal("Skill audit owner mismatch")
				}
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("real Skill hook did not write execution audit")
		}
		time.Sleep(time.Second)
	}
}

func assertLongTask(t *testing.T, h *runtimeFileE2E, user e2eUser) {
	deadline := time.Now().Add(3 * time.Minute)
	for {
		list := e2eData[struct {
			Items []struct{ HumanUserID, AgentID, SkillName, Status string }
		}](t, h.request(http.MethodGet, "/long-tasks?humanUserId="+user.HumanUserID+"&skillName=e2e-background", nil))
		for _, task := range list.Items {
			if task.Status == "succeeded" {
				if task.HumanUserID != user.HumanUserID || task.AgentID != user.AgentID {
					t.Fatal("long-task owner mismatch")
				}
				return
			}
			if task.Status == "failed" {
				t.Fatal("real long task failed")
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("long task did not complete through real runtime manager")
		}
		time.Sleep(time.Second)
	}
}

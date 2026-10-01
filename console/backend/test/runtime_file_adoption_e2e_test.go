//go:build e2e && integration

package test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/gateway"
)

func TestRuntimeFileRetainedWorkspace_S10(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) { assertRuntimeWorkspaceAdoption(t, kind, false) })
	}
}

func TestRuntimeFileAdoptedGeneration_B03(t *testing.T) {
	for _, kind := range []string{"k8s", "docker"} {
		t.Run(kind, func(t *testing.T) { assertRuntimeWorkspaceAdoption(t, kind, true) })
	}
}

func assertRuntimeWorkspaceAdoption(t *testing.T, kind string, highGeneration bool) {
	h := newRuntimeFileE2E(t, kind)
	h.create(false)
	user := h.makeUsers(1)[0]
	h.uploadSkill(user.HumanUserID, "e2e-retained-private", "RETAINED_PRIVATE_SCRIPT", 0, false)
	h.waitConverged()
	volume, sentinel := h.volumeIdentity(), h.stateSentinel(true)
	original := h.snapshot()
	token := h.worker(`import fs from 'node:fs';process.stdout.write(fs.readFileSync('/run/secrets/muad/pod-service-token','utf8'));`)
	if highGeneration {
		seedRetainedHighGeneration(t, h, original)
	}
	e2eData[json.RawMessage](t, h.request(http.MethodDelete, "/containers/"+h.podID+"?deleteState=false", nil))
	if h.volumeIdentity() != volume {
		t.Fatal("retained volume was replaced on delete")
	}
	detached := e2eHumanUser(t, h.request(http.MethodGet, "/human-users/"+user.HumanUserID, nil))
	if detached.PodID != "" {
		t.Fatal("deleted Pod still owns user")
	}
	h.create(true)
	pod := h.waitConverged()
	if h.volumeIdentity() != volume || h.stateSentinel(false) != sentinel {
		t.Fatal("adoption lost original workspace/session volume")
	}
	restored := e2eHumanUser(t, h.request(http.MethodGet, "/human-users/"+user.HumanUserID, nil))
	if restored.PodID != h.podID || restored.AgentID != user.AgentID || restored.ModelConfigID != user.ModelConfigID {
		t.Fatal("adoption changed user/agent/model ownership")
	}
	assertAdoptedCredentials(t, h, original, strings.TrimSpace(token))
	assertRetainedSkill(t, h, user)
	h.assertFileStartup(pod.ConfigGeneration)
	if highGeneration && pod.ConfigGeneration >= 1000 {
		t.Fatal("fixture did not exercise lower new-instance generation")
	}
	h.restartAndWait()
	h.assertFileStartup(pod.ConfigGeneration)
}

func seedRetainedHighGeneration(t *testing.T, h *runtimeFileE2E, snapshot driver.RuntimeStartupSnapshot) {
	spec := h.restoreSpec(snapshot, requireE2EEnv(t, "MUAD_E2E_FILE_IMAGE"))
	spec.MultiUser.Generation = 1000
	for i := range spec.MultiUser.Agents {
		spec.MultiUser.Agents[i].Prompt = "OLD_INSTANCE_PROMPT_MUST_BE_REPLACED"
	}
	raw, err := json.Marshal(spec.MultiUser)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.RuntimeJSON = raw
	if err := h.drv.(driver.RuntimeStartupDriver).RestoreRuntime(h.ctx, spec, snapshot); err != nil {
		t.Fatal("high-generation retained fixture failed")
	}
	if status := gateway.Probe(h.ctx, h.drv, h.podID); status.RuntimeGeneration != 1000 {
		// A replacement can need ordinary startup time before reporting health.
		if err := waitE2ERuntimeGeneration(h, 1000); err != nil {
			t.Fatal("retained high generation did not boot")
		}
	}
}

func waitE2ERuntimeGeneration(h *runtimeFileE2E, generation int64) error {
	ctx, cancel := context.WithTimeout(h.ctx, 3*time.Minute)
	defer cancel()
	for {
		status := gateway.Probe(ctx, h.drv, h.podID)
		if status.Healthy && status.RuntimeGuardHealthy && status.RuntimeGeneration == generation {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func assertAdoptedCredentials(t *testing.T, h *runtimeFileE2E, original driver.RuntimeStartupSnapshot, oldToken string) {
	current := h.snapshot()
	if current.Environment["OPENCLAW_GATEWAY_TOKEN"] == original.Environment["OPENCLAW_GATEWAY_TOKEN"] {
		t.Fatal("adoption reused gateway credentials")
	}
	newToken := strings.TrimSpace(h.worker(`import fs from 'node:fs';process.stdout.write(fs.readFileSync('/run/secrets/muad/pod-service-token','utf8'));`))
	if runtimeDigest([]byte(oldToken)) == runtimeDigest([]byte(newToken)) {
		t.Fatal("adoption reused service credentials")
	}
	req, err := http.NewRequestWithContext(h.ctx, http.MethodPost, h.url+"/internal/v1/skills/private/ingest", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+oldToken)
	response, err := h.client.Do(req)
	if err != nil {
		t.Fatal("old service-token authentication probe failed")
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("old Pod service credential remains accepted")
	}
}

func assertRetainedSkill(t *testing.T, h *runtimeFileE2E, user e2eUser) {
	config, err := driver.DecodeRuntimeConfig(bytes.NewReader(h.snapshot().RuntimeJSON))
	if err != nil {
		t.Fatal("adopted startup DTO is invalid")
	}
	for _, agent := range config.Agents {
		if agent.Prompt == "OLD_INSTANCE_PROMPT_MUST_BE_REPLACED" {
			t.Fatal("old high-generation config remained active")
		}
	}
	root := ""
	for _, policy := range config.Skills.Agents {
		if policy.AgentID == user.AgentID {
			for _, grant := range policy.Allowed {
				if grant.Name == "e2e-retained-private" {
					root = grant.RootPath
				}
			}
		}
	}
	if root == "" {
		t.Fatal("adoption lost private Skill grant")
	}
	out := h.worker(`import fs from 'node:fs';import path from 'node:path';console.log(fs.readFileSync(path.join(process.argv[1],'scripts/run.mjs'),'utf8'));`, root)
	if !strings.Contains(out, "RETAINED_PRIVATE_SCRIPT") {
		t.Fatal("adoption lost private script content")
	}
	out, err = h.drv.Exec(h.ctx, h.podID, "openclaw", "agent", "--agent", user.AgentID, "--session-key", "agent:"+user.AgentID+":wecom:direct:"+user.ExternalID, "--message", "Use e2e-retained-private and execute scripts/run.mjs; report actual output.", "--json", "--timeout", "120")
	if err != nil || !strings.Contains(out, "RETAINED_PRIVATE_SCRIPT") {
		t.Fatal("adopted private Skill access failed")
	}
	assertSkillAudit(t, h, user, "e2e-retained-private")
}

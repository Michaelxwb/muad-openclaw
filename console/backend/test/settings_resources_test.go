package test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/runtimeconfig"
)

// S-03 [integration] 真实边界：settings HTTP handler → repo → runtimeconfig
// builder → openclaw-config-renderer（Node 真实实现）。
func TestSettingsResourcesSkillRequestLimitFlowsToRuntimeConfig(t *testing.T) {
	env := newTestEnv(t)
	createPodThroughAPI(t, env, testPodBody)

	if result := buildSettingsRuntime(t, env, "pod-a"); result.Config.Guard.SkillRequestLimit != 1000 {
		t.Fatalf("default skillRequestLimit = %d, want 1000", result.Config.Guard.SkillRequestLimit)
	}

	before, err := env.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod before: %v", err)
	}
	response := env.do(http.MethodPut, "/api/v1/settings/resources", `{"skillRequestLimit":50}`)
	if response.Code != http.StatusOK {
		t.Fatalf("set skillRequestLimit = %d: %s", response.Code, response.Body.String())
	}
	response = env.do(http.MethodGet, "/api/v1/settings/resources", "")
	assertBodyContains(t, response.Code, response.Body.String(), http.StatusOK, `"skillRequestLimit":50`)

	after, err := env.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod after: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration+1 {
		t.Fatalf("generation = %d, want %d (one apply-triggering change)",
			after.ConfigGeneration, before.ConfigGeneration+1)
	}

	result := buildSettingsRuntime(t, env, "pod-a")
	if result.Config.Guard.SkillRequestLimit != 50 {
		t.Fatalf("guard.skillRequestLimit = %d, want 50", result.Config.Guard.SkillRequestLimit)
	}
	if !strings.Contains(string(result.CanonicalJSON), `"skillRequestLimit":50`) {
		t.Fatalf("runtime config bytes lack skillRequestLimit:50:\n%s", result.CanonicalJSON)
	}
	guardConfig := renderGuardConfig(t, result.CanonicalJSON)
	if !strings.Contains(guardConfig, `"skillRequestLimit":50`) {
		t.Fatalf("rendered guard config lacks skillRequestLimit:50: %s", guardConfig)
	}

	// 未变化不触发 apply：重复保存同一值不得前移 generation。
	response = env.do(http.MethodPut, "/api/v1/settings/resources", `{"skillRequestLimit":50}`)
	if response.Code != http.StatusOK {
		t.Fatalf("repeat set skillRequestLimit = %d: %s", response.Code, response.Body.String())
	}
	repeated, err := env.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod repeated: %v", err)
	}
	if repeated.ConfigGeneration != after.ConfigGeneration {
		t.Fatalf("unchanged skillRequestLimit advanced generation: %d -> %d",
			after.ConfigGeneration, repeated.ConfigGeneration)
	}
}

// E-07 [integration] 真实边界：settings HTTP handler + 仓库落库状态。
func TestSettingsResourcesSkillRequestLimitValidation(t *testing.T) {
	env := newTestEnv(t)
	createPodThroughAPI(t, env, testPodBody)
	before, err := env.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod before: %v", err)
	}

	for _, body := range []string{
		`{"skillRequestLimit":-1}`,
		`{"skillRequestLimit":1000001}`,
		`{"skillRequestLimit":"abc"}`,
	} {
		response := env.do(http.MethodPut, "/api/v1/settings/resources", body)
		assertBodyContains(t, response.Code, response.Body.String(), http.StatusBadRequest,
			`"code":40003`)
	}

	if _, err := env.store.GetResourceGlobal(); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("invalid skillRequestLimit persisted a global resource config: %v", err)
	}
	after, err := env.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("GetPod after: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration {
		t.Fatalf("invalid skillRequestLimit advanced generation: %d -> %d",
			before.ConfigGeneration, after.ConfigGeneration)
	}
}

func buildSettingsRuntime(t *testing.T, env *testEnv, podID string) runtimeconfig.Result {
	t.Helper()
	builder, err := runtimeconfig.New(env.store, env.cipher, runtimeconfig.Options{
		ConsoleInternalURL:     env.cfg.ConsoleInternalURL,
		MaxSkillConcurrency:    env.cfg.RuntimeDefaults.MaxSkillConcurrency,
		MaxBrowserConcurrency:  env.cfg.RuntimeDefaults.MaxBrowserConcurrency,
		MaxLongTaskConcurrency: env.cfg.RuntimeDefaults.MaxLongTaskConcurrency,
	})
	if err != nil {
		t.Fatalf("runtimeconfig.New: %v", err)
	}
	result, err := builder.Build(podID)
	if err != nil {
		t.Fatalf("runtimeconfig Build: %v", err)
	}
	return result
}

// renderGuardConfig 把 Go 编写的 runtime DTO 喂给真实的 Node schema + renderer，
// 返回渲染后的 muad-runtime-guard 配置字节。
func renderGuardConfig(t *testing.T, canonicalJSON []byte) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatalf("resolve repository root: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", renderGuardConfigScript, root)
	command.Stdin = bytes.NewReader(canonicalJSON)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Go DTO → Node schema/renderer failed: %v\n%s", err, output)
	}
	return string(output)
}

const renderGuardConfigScript = `
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root = process.argv[1];
const {validateRuntimeConfig} = await import(pathToFileURL(root + '/bin/runtime-config-schema.mjs'));
const {renderOpenClawConfig, canonicalStringify} = await import(pathToFileURL(root + '/bin/openclaw-config-renderer.mjs'));
const runtime = JSON.parse(readFileSync(0, 'utf8'));
validateRuntimeConfig(runtime);
const rendered = renderOpenClawConfig(runtime);
process.stdout.write(canonicalStringify(rendered.plugins.entries['muad-runtime-guard'].config));
`

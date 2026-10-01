//go:build e2e

package test

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestRuntimeGrantRenderEquivalence_S02(t *testing.T) {
	cipher := mustRuntimeCipher(t)
	source := runtimeBuilderFixture(t, cipher)
	for user, skills := range source.skills {
		for i := range skills {
			skills[i].ScriptFiles = []string{"scripts/export.py"}
		}
		source.skills[user] = skills
	}
	config := buildRuntime(t, source, cipher).Config
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", grantRenderEquivalenceScript, root, t.TempDir())
	command.Stdin = bytes.NewReader(data)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Go DTO → Node schema/render/guidance equivalence failed: %v\n%s", err, output)
	}
}

const grantRenderEquivalenceScript = `
import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [root, workspace] = process.argv.slice(1);
const {validateRuntimeConfig} = await import(pathToFileURL(root + '/bin/runtime-config-schema.mjs'));
const {renderOpenClawConfig, canonicalStringify, writeAgentGuidance} = await import(pathToFileURL(root + '/bin/openclaw-config-renderer.mjs'));
const compact = JSON.parse(readFileSync(0, 'utf8'));
for (const agent of compact.agents) agent.workspace = workspace + '/' + agent.id;
const legacy = structuredClone(compact);
for (const agent of legacy.skills.agents) for (const grant of agent.allowed) {
  if (grant.entryType !== 'traditional-script') {
    assert.deepEqual(compact.skills.agents.find(a => a.agentId === agent.agentId).allowed.find(g => g.name === grant.name).scriptFiles, []);
    grant.scriptFiles = ['scripts/export.py'];
  }
}
validateRuntimeConfig(legacy); validateRuntimeConfig(compact);
assert.equal(canonicalStringify(renderOpenClawConfig(compact)), canonicalStringify(renderOpenClawConfig(legacy)));
const guidance = runtime => {
  writeAgentGuidance(runtime);
  const files = runtime.agents.map(a => a.workspace + '/' + (a.id === 'main' ? 'BOOTSTRAP.md' : 'AGENTS.md'));
  const bytes = files.map(f => readFileSync(f).toString('base64'));
  for (const f of files) rmSync(f);
  return bytes;
};
assert.deepEqual(guidance(compact), guidance(legacy));
`

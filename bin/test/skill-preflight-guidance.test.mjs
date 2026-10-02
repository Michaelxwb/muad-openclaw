import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderOpenClawConfig, writeAgentGuidance } from '../openclaw-config-renderer.mjs';

function fixture(t) {
  const runtime = JSON.parse(readFileSync(new URL('./fixtures/runtime-v1.json', import.meta.url), 'utf8'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-preflight-guide-'));
  for (const agent of runtime.agents) { agent.workspace = path.join(root, `workspace-${agent.id}`); agent.agentDir = path.join(root, `agents/${agent.id}/agent`); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { runtime, root };
}

test('PreflightS12 fixed guidance upgrades old activation block and enforces matching/input preflight', t => {
  const { runtime } = fixture(t), agent = runtime.agents[1];
  mkdirSync(agent.workspace, { recursive: true });
  const file = path.join(agent.workspace, 'AGENTS.md');
  writeFileSync(file, '<!-- muad:skill-activation:start -->\nReading that exact SKILL.md is the native Skill activation and audit boundary.\n<!-- muad:skill-activation:end -->\ncustom notes\n');
  runtime.guidance = { userSkill: 'custom guidance' };
  writeAgentGuidance(runtime);
  const text = readFileSync(file, 'utf8');
  for (const phrase of ['唯一', '多个', 'customerId', '明确无参', 'muad_submit_long_task', '普通 Skill', 'SKILL.md']) assert.ok(text.includes(phrase), phrase);
  assert.match(text, /读取.*不.*执行/);
  assert.doesNotMatch(text, /Reading that exact SKILL.md is the native Skill activation and audit boundary/);
  assert.match(text, /custom notes/); assert.match(text, /custom guidance/);
  writeAgentGuidance(runtime); assert.equal(readFileSync(file, 'utf8'), text);
});

test('PreflightS12 validated renderer exposes submit only to business agents and retains deterministic policy', t => {
  const { runtime } = fixture(t);
  runtime.agents[1].tools.deny = ['muad_submit_long_task'];
  const first = renderOpenClawConfig(runtime, { tools: { profile: 'coding' } });
  assert.deepEqual(renderOpenClawConfig(runtime, { tools: { profile: 'coding' } }), first);
  const alice = first.agents.list.find(a => a.id === 'alice'), main = first.agents.list.find(a => a.id === 'main');
  assert.ok(alice.tools.allow.includes('muad_submit_long_task'));
  assert.equal(alice.tools.deny?.includes('muad_submit_long_task') ?? false, false);
  assert.ok(first.tools.alsoAllow.includes('muad_submit_long_task'));
  assert.ok(main.tools.deny.includes('muad_submit_long_task'));
  assert.equal(JSON.stringify(first).includes('muad_run_skill'), false);
  assert.throws(() => renderOpenClawConfig({ ...runtime, generation: 0 }), /generation/);
});

test('PreflightS17 fixed guidance clears cancelled candidates and isolates choice context', t => {
  const { runtime } = fixture(t);
  writeAgentGuidance(runtime);
  const text = readFileSync(path.join(runtime.agents[1].workspace, 'AGENTS.md'), 'utf8');
  assert.match(text, /取消.*候选/u); assert.match(text, /改换目标/u);
  assert.match(text, /跨用户.*跨会话/u); assert.match(text, /第2个/u);
  const instructions = readFileSync(new URL('../../tools/muad-runtime-guard/skill-preflight-e2e.md', import.meta.url), 'utf8');
  assert.match(instructions, /slashIngressCommand/u);
  assert.match(instructions, /humanUserId/u);
  assert.match(instructions, /MUAD_PREFLIGHT_E2E=1/u);
});

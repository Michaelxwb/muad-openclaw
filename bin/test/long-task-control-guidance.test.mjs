import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderOpenClawConfig, writeAgentGuidance } from '../openclaw-config-renderer.mjs';
import { readRuntimeConfig } from '../runtime-config-schema.mjs';
import { prepareTransaction } from '../runtime-config-transaction.mjs';
import { createLongTaskPreflight } from '../../tools/muad-runtime-guard/src/long-task-preflight.mjs';
import { SkillPreflightContext } from '../../tools/muad-runtime-guard/src/skill-preflight-context.mjs';

function runtimeFixture(t) {
  const runtime = JSON.parse(readFileSync(new URL('./fixtures/runtime-v1.json', import.meta.url), 'utf8'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-long-task-guide-'));
  for (const agent of runtime.agents) {
    agent.workspace = path.join(root, `workspace-${agent.id}`);
    agent.agentDir = path.join(root, `agents/${agent.id}/agent`);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { runtime, root };
}

function preflightFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-long-task-preflight-s14-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'SKILL.md'), '--customer-id required\n');
  writeFileSync(path.join(root, 'muad.skill.json'), JSON.stringify({ name: 'xdr-query', longTask: true }));
  const turn = { agentId: 'alice', runId: 'run-1', sessionKey: 'agent:alice:wecom:direct:a', peerId: 'a', replyChannel: 'wecom', originalPrompt: '生成客户报告' };
  const grant = { agentId: 'alice', name: 'xdr-query', rootPath: root };
  const config = { valid: true, mainAgentId: 'main', agentProfiles: [{ agentId: 'alice' }], longTaskSkillGrants: [grant] };
  const ledger = new SkillPreflightContext();
  ledger.recordRead({ ...turn, skillName: 'xdr-query', rootPath: root });
  const checker = createLongTaskPreflight({ ledger, getConfig: () => config });
  const input = { skillName: 'xdr-query', objective: '客户报告', selectionBasis: 'explicit_name', requiredNames: [], bindings: [] };
  return { checker, turn, grant, config, input, ledger };
}

test('LongTaskControlS14 fixed guidance pins matching rules, screenshot examples and explicit_name trust', t => {
  const { runtime } = runtimeFixture(t);
  const agent = runtime.agents[1];
  mkdirSync(agent.workspace, { recursive: true });
  runtime.guidance = { userSkill: 'custom guidance' };
  writeAgentGuidance(runtime);
  const file = path.join(agent.workspace, 'AGENTS.md');
  const text = readFileSync(file, 'utf8');
  // 唯一自动、多候选选择、参考不授权
  assert.match(text, /唯一明确匹配且参数齐全：直接执行/u);
  assert.match(text, /多个合理候选：列出名称和区别/u);
  assert.match(text, /参考.*不授权运行/u);
  // 截图等价正反例与缺参/无适用 Skill
  assert.match(text, /触发判定正反例/u);
  assert.match(text, /直接调用 muad_submit_long_task/u);
  assert.match(text, /追问所缺参数/u);
  assert.match(text, /没有适用 Skill.*缺少能力|缺少能力/u);
  // explicit_name 可信来源
  assert.match(text, /explicit_name/u);
  assert.match(text, /不得自报或伪造/u);
  assert.match(text, /\/skill:<name>/u);
  assert.match(text, /custom guidance/u);
  writeAgentGuidance(runtime);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('LongTaskControlS14 explicit_name is only accepted when the trusted inbound command names the Skill', t => {
  const f = preflightFixture(t);
  const withPrompt = prompt => ({ ...f.turn, originalPrompt: prompt });
  assert.equal(f.checker.check(f.input, withPrompt('/skill:xdr-query 帮客户出报告')).ok, true);
  assert.equal(f.checker.check(f.input, withPrompt('  <skill name="xdr-query">出报告')).ok, true);
  assert.equal(f.checker.check(f.input, withPrompt('/skill:other 出报告')).reason, 'explicit_name_untrusted');
  assert.equal(f.checker.check(f.input, f.turn).reason, 'explicit_name_untrusted');
  assert.equal(f.checker.check(f.input, withPrompt('参考 xdr-query 生成周报')).reason, 'explicit_name_untrusted');
  assert.equal(f.checker.check({ ...f.input, selectionBasis: 'unique_match' }, f.turn).ok, true);
  assert.equal(f.checker.check({ ...f.input, selectionBasis: 'user_choice' }, f.turn).ok, true);
});

test('LongTaskControlS14 keeps grant, manifest, document-read and input gates for every basis', t => {
  const f = preflightFixture(t);
  const trusted = { ...f.turn, originalPrompt: '/skill:xdr-query 出报告' };
  const unread = createLongTaskPreflight({ ledger: new SkillPreflightContext(), getConfig: () => f.config });
  assert.equal(unread.check(f.input, trusted).reason, 'documentation_not_read');
  f.config.longTaskSkillGrants = [];
  assert.equal(f.checker.check(f.input, trusted).reason, 'skill_not_authorized');
  f.config.longTaskSkillGrants = [f.grant];
  writeFileSync(path.join(f.grant.rootPath, 'muad.skill.json'), JSON.stringify({ name: 'xdr-query', longTask: false }));
  assert.equal(f.checker.check(f.input, trusted).reason, 'skill_not_authorized');
  writeFileSync(path.join(f.grant.rootPath, 'muad.skill.json'), JSON.stringify({ name: 'xdr-query', longTask: true }));
  assert.equal(f.checker.check({ ...f.input, requiredNames: ['customerId'] }, trusted).reason, 'missing_input');
});

test('LongTaskControlS14 renders deterministically and prepares an isolated 0600 candidate', t => {
  const { runtime, root } = runtimeFixture(t);
  const first = renderOpenClawConfig(runtime, { tools: { profile: 'coding' } });
  assert.deepEqual(renderOpenClawConfig(runtime, { tools: { profile: 'coding' } }), first);
  assert.throws(() => renderOpenClawConfig({ ...runtime, generation: 0 }), /generation/);
  assert.throws(() => readRuntimeConfig({ env: { MUAD_RUNTIME_CONFIG: JSON.stringify({ ...runtime, generation: 0 }) } }), /generation/);
  const configPath = path.join(root, 'openclaw.json');
  writeFileSync(configPath, `${JSON.stringify(first, null, 2)}\n`, { mode: 0o600 });
  const prepared = prepareTransaction({ runtime, configPath });
  assert.equal(prepared.generation, runtime.generation);
  const candidatePath = `${configPath}.muad.candidate`;
  assert.ok(existsSync(candidatePath));
  assert.equal(statSync(candidatePath).mode & 0o777, 0o600);
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  assert.equal(candidate.plugins.entries['muad-runtime-guard'].config.generation, runtime.generation);
});

test('LongTaskControlS14 skill grants stay unique per agent and directory grants never execute', t => {
  const { runtime } = runtimeFixture(t);
  const alice = runtime.skills.agents.find(agent => agent.agentId === 'alice');
  const duplicate = {
    ...runtime,
    skills: { ...runtime.skills, agents: [{ agentId: 'alice', allowed: [
      { ...alice.allowed[0], source: 'system', rootPath: '/opt/system-skills/xdr-query' },
      { ...alice.allowed[0], source: 'public', rootPath: '/opt/openclaw-skills/xdr-query' },
    ] }] },
  };
  assert.throws(() => renderOpenClawConfig(duplicate), /duplicate Skill grant/u);
  alice.allowed = [{ ...alice.allowed[0], source: 'system', rootPath: '/opt/system-skills/xdr-query' }];
  const guard = renderOpenClawConfig(runtime).plugins.entries['muad-runtime-guard'].config;
  const grants = guard.longTaskSkillGrants.filter(grant => grant.agentId === 'alice');
  assert.deepEqual(grants.map(grant => [grant.name, grant.rootPath]), [['xdr-query', '/opt/system-skills/xdr-query']]);
  assert.ok(!guard.longTaskSkillGrants.some(grant => grant.dir === true));
  const audit = guard.skillAuditGrants.filter(grant => grant.agentId === 'alice');
  assert.ok(audit.some(grant => grant.source === 'public' && grant.dir === true));
  assert.ok(audit.some(grant => grant.source === 'private' && grant.dir === true));
  assert.ok(audit.some(grant => grant.source === 'system' && grant.name === 'xdr-query' && grant.dir !== true));
});

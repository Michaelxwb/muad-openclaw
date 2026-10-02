import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/index.mjs';
import { SharedSkillLeaseManager } from '../src/skill-lease.mjs';
import { LongTaskManager } from '../src/long-task-manager.mjs';

test('PreflightS20 plugin manifest declares the submitted tool for upstream registration', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts.tools, ['muad_submit_long_task']);
});

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-register-'));
  const skill = path.join(root, 'report'); mkdirSync(skill);
  writeFileSync(path.join(skill, 'SKILL.md'), 'customerId required');
  writeFileSync(path.join(skill, 'muad.skill.json'), JSON.stringify({ name: 'report', longTask: true }));
  const guard = { generation: 1, mainAgentId: 'main', quarantineProfile: 'quarantine',
    agentProfiles: [{ agentId: 'alice', profile: 'alice' }], sessionAgentIds: ['alice'],
    skillReadRoots: [{ agentId: 'alice', roots: [skill] }], skillAuditGrants: [{ agentId: 'alice', name: 'report', rootPath: skill, source: 'private' }],
    longTaskSkillGrants: [{ agentId: 'alice', name: 'report', rootPath: skill }],
    maxBrowserConcurrency: 1, maxSkillConcurrency: 1, maxLongTaskConcurrency: 1,
    consoleInternalURL: 'http://127.0.0.1:1/internal/v1', serviceTokenFile: '/run/secrets/muad/pod-service-token' };
  const started = [], logs = [], hooks = [], tools = [], policies = [];
  globalThis[Symbol.for('muad.skill.lease')] = new SharedSkillLeaseManager({ limit: 1, directory: path.join(root, 'leases') });
  globalThis[Symbol.for('muad.longtask.manager')] = new LongTaskManager({ limit: 1, stateFile: path.join(root, 'state.jsonl'), runTask: task => { started.push(task); return new Promise(() => {}); } });
  const api = { pluginConfig: guard, config: { agents: { list: [{ id: 'alice', workspace: root }] } },
    logger: { warn: message => logs.push(message) }, runtime: { agent: {
      resolveAgentWorkspaceDir: () => root, resolveAgentDir: () => path.join(root, 'agent'), } },
    registerCommand: () => {}, registerGatewayMethod: () => {}, registerTrustedToolPolicy: policy => policies.push(policy),
    registerTool: (factory, options) => tools.push({ factory, options }),
    on: (name, handler, options) => hooks.push({ name, handler, options }) };
  t.after(() => {
    for (const name of ['muad.longtask.manager', 'muad.browser.lease', 'muad.skill.lease', 'muad.skill.progress.manager', 'muad.skill.preflight']) {
      globalThis[Symbol.for(name)]?.close?.(); delete globalThis[Symbol.for(name)];
    }
    rmSync(root, { recursive: true, force: true });
  });
  plugin.register(api);
  const ctx = { agentId: 'alice', sessionKey: 'agent:alice:wecom:direct:a', runId: 'run-1' };
  async function fire(name, event, context = ctx) {
    for (const hook of hooks.filter(hook => hook.name === name)) await hook.handler(event, context);
  }
  return { root, skill, guard, ctx, started, logs, tools, hooks, policies, fire, api };
}
const input = { skillName: 'report', objective: 'sensitive-objective', selectionBasis: 'unique_match', requiredNames: ['customerId'], bindings: [{ name: 'customerId', value: 'sensitive-value', source: 'user_message' }] };
async function invoke(tool, value = input) { return JSON.parse((await tool.execute('call', value)).content[0].text); }

test('PreflightS25 tool discovery registration shares trusted read state with runtime hooks', async t => {
  const f = setup(t), discovered = [];
  plugin.register({ ...f.api, on: () => {}, registerTool: factory => discovered.push(factory) });
  await f.fire('before_agent_run', { prompt: '生成报告', senderId: 'a' });
  await f.fire('after_tool_call', { toolName: 'read', params: { path: path.join(f.skill, 'SKILL.md') }, result: { isError: false } });
  const tool = discovered[0]({ agentId: 'alice', sessionKey: f.ctx.sessionKey });
  assert.equal((await invoke(tool)).status, 'accepted');
  assert.equal(f.started.length, 1);
  const other = discovered[0]({ agentId: 'alice', sessionKey: 'agent:alice:wecom:direct:other' });
  assert.equal((await invoke(other)).reason, 'context_unavailable');
  await f.fire('agent_end', {});
  assert.equal((await invoke(tool)).reason, 'context_unavailable');
});

test('PreflightS11 plugin registers trusted tool and read lifecycle with shared manager and redacted logger', async t => {
  const f = setup(t);
  assert.equal(f.tools.length, 1); assert.deepEqual(f.tools[0].options, { name: 'muad_submit_long_task' });
  await f.fire('before_agent_run', { prompt: 'sensitive-prompt', senderId: 'a' });
  await f.fire('after_tool_call', { toolName: 'read', params: { path: path.join(f.skill, 'SKILL.md') }, result: { isError: false } });
  const tool = f.tools[0].factory({ agentId: 'alice', sessionKey: f.ctx.sessionKey });
  assert.equal((await invoke(tool)).status, 'accepted');
  assert.equal(f.started.length, 1); assert.equal(f.started[0].originalPrompt, 'sensitive-prompt');
  assert.equal((await invoke(f.tools[0].factory({ ...f.ctx, agentId: 'main' }))).reason, 'context_unavailable');
  assert.equal((await invoke(f.tools[0].factory({ ...f.ctx, sessionKey: f.started[0].sessionKey }))).reason, 'context_unavailable');
  assert.equal((await invoke(tool, { ...input, agentId: 'other' })).reason, 'invalid_input');
  await f.fire('agent_end', {});
  assert.equal((await invoke(tool)).reason, 'context_unavailable');
  const text = f.logs.join('\n');
  for (const value of ['sensitive-prompt', 'sensitive-objective', 'sensitive-value']) assert.equal(text.includes(value), false);
  assert.match(text, /\[muad-runtime-guard\]\[longtask-submit\]/);
});

test('PreflightS11 long-task slash preflight consumes no skill execution lease', async t => {
  const f = setup(t);
  await f.fire('before_agent_run', { prompt: '/skill:report', senderId: 'a' });
  assert.equal(globalThis[Symbol.for('muad.skill.lease')].snapshot().active, 0);
  assert.equal(f.started.length, 0);
});

test('PreflightS16 only trusted running background tasks acquire and release a real shared skill lease', async t => {
  const f = setup(t);
  await f.fire('before_agent_run', { prompt: '报告', senderId: 'a' });
  await f.fire('after_tool_call', { toolName: 'read', params: { path: path.join(f.skill, 'SKILL.md') }, result: { isError: false } });
  await invoke(f.tools[0].factory(f.ctx));
  const bg = { agentId: 'alice', sessionKey: f.started[0].sessionKey, runId: 'background-run' };
  const leaseHook = f.hooks.find(hook => hook.name === 'before_agent_run' && hook.options.priority === -1000);
  const result = await leaseHook.handler({ prompt: 'You are executing a background long task for a user.' }, bg);
  assert.equal(result.outcome, 'pass');
  assert.equal(globalThis[Symbol.for('muad.skill.lease')].snapshot().active, 1);
  await f.fire('agent_end', {}, bg);
  assert.equal(globalThis[Symbol.for('muad.skill.lease')].snapshot().active, 0);
  const forged = await leaseHook.handler({ prompt: 'background task' }, { ...bg, sessionKey: 'agent:alice:longtask:forged' });
  assert.equal(forged.outcome, 'block');
  assert.equal(globalThis[Symbol.for('muad.skill.lease')].snapshot().active, 0);
});

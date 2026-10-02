import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { SkillPreflightContext } from '../src/skill-preflight-context.mjs';
import { createLongTaskHooks } from '../src/long-task-hooks.mjs';
import { createSkillAuditHooks } from '../src/skill-audit-hooks.mjs';
import { createSkillProgressHooks } from '../src/skill-progress-hooks.mjs';
import { SkillProgressManager } from '../src/skill-progress-manager.mjs';
import { createLongTaskPreflight } from '../src/long-task-preflight.mjs';
import { createLongTaskToolFactory } from '../src/long-task-tool.mjs';

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-preflight-flow-'));
  const skillRoot = path.join(root, 'report'); mkdirSync(skillRoot);
  writeFileSync(path.join(skillRoot, 'SKILL.md'), 'report requires customerId');
  writeFileSync(path.join(skillRoot, 'run.sh'), `touch ${path.join(root, 'sentinel')}`);
  writeFileSync(path.join(skillRoot, 'reference.md'), 'reference');
  writeFileSync(path.join(skillRoot, 'muad.skill.json'), JSON.stringify({ name: 'report', longTask: true }));
  const config = { valid: true, mainAgentId: 'main', agentProfiles: [{ agentId: 'alice' }],
    longTaskSkillGrants: [{ agentId: 'alice', name: 'report', rootPath: skillRoot }],
    skillAuditGrants: [{ agentId: 'alice', name: 'report', rootPath: skillRoot, source: 'private' }] };
  const reports = [], notices = [], jobs = [], finishes = [];
  const progress = new SkillProgressManager({ rootDir: path.join(root, 'progress'), notify: async input => notices.push(input) });
  const progressHooks = createSkillProgressHooks({ manager: progress });
  const manager = new LongTaskManager({ limit: 1, stateFile: path.join(root, 'state.jsonl'), progressManager: progress,
    runTask: task => { jobs.push(task); return new Promise(resolve => finishes.push(resolve)); } });
  const ledger = new SkillPreflightContext();
  const hooks = createLongTaskHooks({ ledger, getConfig: () => config });
  const audit = createSkillAuditHooks({ config, getConfig: () => config, manager,
    client: { report: async input => reports.push(input) }, onSkillActivated: progressHooks.activate });
  const ctx = { agentId: 'alice', sessionKey: 'agent:alice:wecom:direct:a', runId: 'run-1' };
  const preflight = createLongTaskPreflight({ ledger, getConfig: () => config, getTurnContext: hooks.getTurnContext });
  const factory = createLongTaskToolFactory({ preflight, manager, getConfig: () => config });
  t.after(async () => { manager.close(); finishes.forEach(resolve => resolve({ code: 0 })); await tick(); progress.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, skillRoot, config, reports, notices, jobs, finishes, hooks, audit, ctx, factory, manager };
}
const input = { skillName: 'report', objective: '生成报告', selectionBasis: 'unique_match', requiredNames: ['customerId'], bindings: [{ name: 'customerId', value: '123', source: 'user_message' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function read(f, name, ctx = f.ctx) {
  const event = { toolName: 'read', params: { path: path.join(f.skillRoot, name) } };
  assert.equal(await f.hooks.beforeToolCall(event, ctx), undefined);
  await f.audit.beforeToolCall(event, ctx);
  const text = readFileSync(event.params.path, 'utf8');
  await f.hooks.afterToolCall({ ...event, result: { content: [{ type: 'text', text }] } }, ctx);
}
async function submit(f, ctx = f.ctx, value = input) {
  return JSON.parse((await f.factory(ctx).execute('call', value)).content[0].text);
}

test('PreflightS01 reads documents scripts and references without queue audit progress or sentinel', async t => {
  const f = setup(t);
  await f.hooks.beforeAgentRun({ prompt: '查看能力', senderId: 'a' }, f.ctx);
  await f.audit.beforeDispatch({ prompt: '/skill:report', runId: f.ctx.runId }, f.ctx);
  for (const file of ['SKILL.md', 'run.sh', 'reference.md', 'SKILL.md']) await read(f, file);
  assert.equal((await submit(f, f.ctx, { ...input, bindings: [] })).reason, 'missing_input');
  await tick();
  assert.deepEqual(f.reports, []); assert.deepEqual(f.notices, []);
  assert.deepEqual(f.jobs, []); assert.equal(f.manager.snapshot().pools.length, 0);
  assert.equal(existsSync(path.join(f.root, 'sentinel')), false);
  assert.equal(existsSync(path.join(f.root, 'state.jsonl')), false);
});

test('PreflightS06 audit follows trusted running task once and queued tasks have no execution audit', async t => {
  const f = setup(t);
  await f.hooks.beforeAgentRun({ prompt: '报告123', senderId: 'a' }, f.ctx);
  await read(f, 'SKILL.md');
  assert.equal((await submit(f)).status, 'accepted');
  const first = f.jobs[0], bg = { agentId: 'alice', sessionKey: first.sessionKey, runId: 'background-1' };
  await f.audit.beforeAgentRun({}, bg); await f.audit.beforeAgentRun({}, bg);
  await f.audit.beforeToolCall({ toolName: 'read', params: { path: path.join(f.skillRoot, 'SKILL.md') } }, bg);
  const next = { ...f.ctx, runId: 'run-2' };
  await f.hooks.beforeAgentRun({ prompt: '另一个报告', senderId: 'a' }, next); await read(f, 'SKILL.md', next);
  assert.equal((await submit(f, next)).queued, 1);
  await tick();
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].executionId, first.taskId);
  assert.equal(f.notices.length, 0); assert.equal(f.jobs.length, 1);
  f.finishes[0]({ code: 0 }); await tick();
  assert.equal(f.jobs.length, 2);
  await f.audit.beforeAgentRun({}, { ...bg, sessionKey: f.jobs[1].sessionKey, runId: 'background-2' }); await tick();
  assert.equal(f.reports.length, 2);
  await f.audit.beforeAgentRun({}, { ...bg, sessionKey: 'agent:alice:longtask:forged' }); await tick();
  assert.equal(f.reports.length, 2);
});

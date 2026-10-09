import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLongTaskHooks } from '../src/long-task-hooks.mjs';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { SkillPreflightContext } from '../src/skill-preflight-context.mjs';

function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'muad-preflight-hooks-'));
  const skillDir = path.join(root, 'report'); mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  const script = path.join(skillDir, 'scripts/run.py'); writeFileSync(script, "print('report')\n");
  writeFileSync(path.join(skillDir, 'scripts/run'), '#!/bin/sh\n');
  writeFileSync(path.join(skillDir, 'SKILL.md'), '# Real instructions\n');
  writeFileSync(path.join(skillDir, 'muad.skill.json'), JSON.stringify({ name: 'report', longTask: true }));
  const started = [];
  const manager = new LongTaskManager({ stateFile: path.join(root, 'state.jsonl'), runTask: task => { started.push(task); return new Promise(() => {}); } });
  const ledger = new SkillPreflightContext();
  const ctx = { runId: 'run-1', agentId: 'alice', sessionKey: 'agent:alice:wecom:direct:a' };
  const config = { longTaskSkillGrants: [{ agentId: 'alice', name: 'report', rootPath: skillDir }] };
  const hooks = createLongTaskHooks({ getConfig: () => config, manager, ledger });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, hooks, skillDir, script, manager, started, ledger, ctx };
}

test('PreflightE03 blocks actual script commands without submission and allows document inspection', async t => {
  const f = setup(t);
  await f.hooks.beforeAgentRun({ prompt: '生成报告', senderId: 'a' }, f.ctx);
  for (const [command, extra] of [
    [`python3 ${f.script}`], [`cd ${f.skillDir} && ./scripts/run.py`],
    [`cd ${f.skillDir} && ./scripts/run`], [`cd ${f.skillDir}/scripts && python3 run.py`],
    ['python3 run.py', { cwd: path.dirname(f.script) }], ['./scripts/run.py', { workdir: f.skillDir }],
    [`FOO=1 python3 ${f.script}`], [`sudo python3 ${f.script}`], [`timeout 60 python3 ${f.script}`],
    [`env python3 ${f.script}`], [`uv run ${f.script}`], [`ls ${f.skillDir} && python3 ${f.script}`],
  ]) {
    const result = await f.hooks.beforeToolCall({ toolName: 'bash', params: { command, ...extra } }, f.ctx);
    assert.equal(result?.block, true, command);
    assert.match(result.blockReason, /muad_submit_long_task/);
    assert.doesNotMatch(result.blockReason, /已提交|has been submitted/);
  }
  for (const command of ['ls scripts/', 'ls ./', `ls ${f.skillDir}`, `cat ${f.script}`, `grep report ${f.script}`, 'find . -name *.py', 'python3 scripts/run.py']) {
    assert.equal(await f.hooks.beforeToolCall({ toolName: 'exec', params: { command } }, f.ctx), undefined, command);
  }
  assert.equal(f.started.length, 0);
  assert.equal(f.manager.snapshot().active + f.manager.snapshot().queued, 0);
});

test('PreflightE03 read and slash remain preflight, successful reads alone update the ledger', async t => {
  const f = setup(t), document = path.join(f.skillDir, 'SKILL.md');
  assert.equal(await f.hooks.beforeDispatch({ prompt: '/skill:report' }, f.ctx), undefined);
  await f.hooks.beforeAgentRun({ prompt: '/skill:report', senderId: 'a' }, f.ctx);
  const event = { toolName: 'read', params: { path: document } };
  assert.equal(await f.hooks.beforeToolCall(event, f.ctx), undefined);
  assert.equal(readFileSync(document, 'utf8'), '# Real instructions\n');
  assert.equal(f.ledger.check({ ...f.ctx, skillName: 'report', rootPath: f.skillDir }).ok, false);
  await f.hooks.afterToolCall({ ...event, result: { isError: false } }, f.ctx);
  assert.equal(f.ledger.check({ ...f.ctx, skillName: 'report', rootPath: f.skillDir }).ok, true);
  await f.hooks.agentEnd({}, f.ctx);
  assert.equal(f.ledger.check({ ...f.ctx, skillName: 'report', rootPath: f.skillDir }).ok, false);
  assert.equal(f.started.length, 0);
});

test('background sessions may run their selected script and never enqueue recursively', async t => {
  const f = setup(t);
  assert.equal(await f.hooks.beforeToolCall({ toolName: 'bash', params: { command: `python3 ${f.script}` } }, { ...f.ctx, sessionKey: 'agent:alice:longtask:task' }), undefined);
  assert.equal(f.started.length, 0);
});


test('MSSW retains the conversation target instead of the sender ID', async t => {
  const f = setup(t);
  const target = 'mssw:v1:7b7d';
  const ctx = { ...f.ctx, sessionKey: 'agent:alice:mssw:direct:' + target };
  await f.hooks.beforeAgentRun({ prompt: '查询', senderId: 'alice', channel: 'mssw' }, ctx);
  const turn = f.hooks.getTurnContext(ctx);
  assert.equal(turn.peerId, target);
  assert.equal(turn.replyChannel, 'mssw');
});

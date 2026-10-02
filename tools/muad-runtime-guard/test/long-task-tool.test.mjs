import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { SkillPreflightContext } from '../src/skill-preflight-context.mjs';
import { createLongTaskPreflight } from '../src/long-task-preflight.mjs';
import { SharedSkillLeaseManager } from '../src/skill-lease.mjs';
import { createLongTaskToolFactory } from '../src/long-task-tool.mjs';

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'muad-submit-'));
  const ledger = new SkillPreflightContext();
  const config = { valid: true, mainAgentId: 'main', agentProfiles: [], longTaskSkillGrants: [] };
  const started = [], pending = [];
  const manager = new LongTaskManager({ stateFile: path.join(root, 'state.jsonl'), limit: 1,
    runTask: task => { started.push(task); return new Promise(resolve => pending.push(resolve)); } });
  const preflight = createLongTaskPreflight({ ledger, getConfig: () => config });
  const factory = createLongTaskToolFactory({ preflight, manager, getConfig: () => config });
  t.after(() => { manager.close(); pending.forEach(resolve => resolve({ code: 0 })); rmSync(root, { recursive: true, force: true }); });
  function user(agentId, name = 'report', scope = 'private') {
    const dir = path.join(root, agentId, scope, name); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '--customer-id required');
    writeFileSync(path.join(dir, 'muad.skill.json'), JSON.stringify({ name, longTask: true }));
    const turn = { agentId, sessionKey: `agent:${agentId}:wecom:direct:${agentId}`, runId: 'run-1', peerId: agentId, replyChannel: 'wecom' };
    config.agentProfiles.push({ agentId });
    config.longTaskSkillGrants.push({ agentId, name, rootPath: dir, scope });
    ledger.recordRead({ ...turn, skillName: name, rootPath: dir });
    return { turn, dir, tool: factory(turn) };
  }
  return { root, user, ledger, config, manager, started, factory };
}
const input = { skillName: 'report', objective: '报告', selectionBasis: 'unique_match', requiredNames: ['customerId'], bindings: [{ name: 'customerId', value: '123', source: 'user_message' }] };
async function invoke(tool, value = input) { return JSON.parse((await tool.execute('call', value)).content[0].text); }

test('PreflightS07 isolates same names, uses effective system root and deduplicates concurrent retries', async t => {
  const f = setup(t), alice = f.user('alice', 'report', 'system'), bob = f.user('bob');
  const responses = await Promise.all(Array.from({ length: 6 }, () => invoke(f.factory(alice.turn))));
  assert.equal(new Set(responses.map(r => r.taskId)).size, 1);
  assert.equal(responses[0].status, 'accepted');
  await invoke(bob.tool);
  assert.deepEqual(f.started.map(task => task.skillRoot), [alice.dir, bob.dir]);
  assert.equal(f.manager.snapshot().active, 2);
  const other = f.user('alice', 'other');
  assert.equal((await invoke(other.tool, { ...input, skillName: 'other' })).reason, 'invalid_input');
  const next = { ...alice.turn, runId: 'run-2' };
  f.ledger.recordRead({ ...next, skillName: 'report', rootPath: alice.dir });
  const result = await invoke(f.factory(next));
  assert.notEqual(result.taskId, responses[0].taskId);
  assert.equal(f.manager.snapshot().queued, 1);
  assert.equal(f.started.length, 2);
  const lease = new SharedSkillLeaseManager({ directory: path.join(f.root, 'leases'), limit: 1, waitTimeoutMs: 50 });
  try {
    const key = f.started[0].taskId;
    await lease.acquire(key);
    await assert.rejects(lease.acquire(key), /duplicate/);
    assert.equal(lease.snapshot().active, 1);
    await lease.release(key);
  } finally { lease.close(); }
});

test('PreflightE02 rejects missing, empty, unknown and untrusted input with zero queue work', async t => {
  const f = setup(t), { tool } = f.user('alice');
  for (const value of [{ ...input, bindings: [] }, { ...input, bindings: [{ ...input.bindings[0], value: ' ' }] },
    { ...input, missingNames: ['customerId'] }, { ...input, skillName: 'unavailable' }, { ...input, rootPath: '/other' }]) {
    assert.equal((await invoke(tool, value)).status, 'rejected');
  }
  assert.equal(f.started.length, 0);
  assert.equal(f.manager.snapshot().active + f.manager.snapshot().queued, 0);
});

test('PreflightE04 reports closed queue and real state I/O failures without sensitive diagnostics', async t => {
  for (const failure of ['closed', 'io', 'absent']) {
    const f = setup(t), { tool, turn } = f.user('alice');
    if (failure === 'closed') f.manager.close();
    if (failure === 'io') mkdirSync(path.join(f.root, 'state.jsonl'));
    const current = failure === 'absent' ? createLongTaskToolFactory({ preflight: createLongTaskPreflight({ ledger: f.ledger, getConfig: () => f.config }), getConfig: () => f.config })(turn) : tool;
    const result = await invoke(current);
    assert.deepEqual(result, { status: 'rejected', reason: 'queue_unavailable' });
    assert.equal(f.started.length, 0);
    assert.equal(JSON.stringify(result).includes(f.root), false);
  }
});

test('PreflightS18 retry from a session alias deduplicates in the existing same-peer pool', async t => {
  const f = setup(t), user = f.user('alice');
  await invoke(user.tool);
  const alias = { ...user.turn, sessionKey: 'agent:alice:wecom:direct:session-alias', runId: 'run-alias', verifiedPeerId: 'alice' };
  f.ledger.recordRead({ ...alias, skillName: 'report', rootPath: user.dir });
  const replies = await Promise.all(Array.from({ length: 4 }, () => invoke(f.factory(alias))));
  assert.equal(new Set(replies.map(r => r.taskId)).size, 1);
  const snapshot = f.manager.snapshot();
  assert.equal(snapshot.active, 1); assert.equal(snapshot.queued, 1);
  assert.equal(snapshot.pools[0].tasks.length, 2);
  assert.equal(f.started.length, 1);
});

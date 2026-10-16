import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import test from 'node:test';
import { createLongTaskRunController } from '../src/long-task-run-controller.mjs';

// LongTaskControlS17 [integration] 真实边界：真实本地（detached）子进程与进程组、
// 真实 signal 与退出观察；原生取消依赖以可控 stub 注入（abort/drain 语义来自
// TASK-001 契约）。断言 abort 接受 ≠ 已退出、只清理自有归属句柄、拒绝未知运行。

function spawnRunChild(t, { withGrandchild = false, lifetimeMs = 60_000 } = {}) {
  const code = withGrandchild
    ? `const {spawn}=require('node:child_process');` +
      `const g=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});` +
      `process.stdout.write(String(g.pid)+'\\n');setInterval(()=>{},${lifetimeMs});`
    : `setInterval(()=>{},${lifetimeMs});`;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  return child;
}

async function readPidLine(child) {
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk;
    const match = /(\d+)/u.exec(buffer);
    if (match) return Number(match[1]);
  }
  return 0;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

function nativeStub({ resolve = () => 'session-1', drain = () => ({ aborted: true, drained: true, forceCleared: false }) } = {}) {
  const calls = { resolve: [], abort: [] };
  return {
    calls,
    native: {
      resolveActiveEmbeddedRunSessionId: (sessionKey) => { calls.resolve.push(sessionKey); return resolve(sessionKey); },
      abortAndDrainAgentHarnessRun: async (params) => { calls.abort.push(params); return drain(params); },
    },
  };
}

test('LongTaskControlS17 abort acceptance is not an exit confirmation', async t => {
  const child = spawnRunChild(t);
  const stub = nativeStub({ drain: () => ({ aborted: true, drained: false, forceCleared: false }) });
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a', settleMs: 200, exitGraceMs: 600 });
  const binding = controller.bind(
    { taskId: 'task-1', agentId: 'alice', sessionKey: 'agent:alice:longtask:task-1' },
    { child, detached: true },
  );
  const result = await controller.cancel(binding);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'drain_timeout');
  assert.deepEqual(stub.calls.resolve, ['agent:alice:longtask:task-1']);
  assert.deepEqual(stub.calls.abort, [{
    sessionId: 'session-1',
    sessionKey: 'agent:alice:longtask:task-1',
    settleMs: 200,
    forceClear: false,
  }]);
  assert.equal(alive(child.pid), true);
});

test('LongTaskControlS17 confirms only after the owned process group really exits', async t => {
  const child = spawnRunChild(t, { withGrandchild: true });
  const grandchildPid = await readPidLine(child);
  assert.ok(grandchildPid > 0);
  const stub = nativeStub({ resolve: () => 'session-2' });
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a', settleMs: 200, exitGraceMs: 2_000 });
  const binding = controller.bind({ taskId: 'task-2', agentId: 'alice' }, { child, detached: true });
  const result = await controller.cancel(binding);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.reason, '');
  assert.equal(await waitDead(child.pid), true);
  assert.equal(await waitDead(grandchildPid), true);
});

test('LongTaskControlS17 refuses unknown or forged runs without signals', async t => {
  const child = spawnRunChild(t);
  const stub = nativeStub();
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a' });
  const other = createLongTaskRunController({ native: stub.native, workerId: 'worker-b' });
  const binding = controller.bind({ taskId: 'task-3', agentId: 'alice' }, { child, detached: true });

  const unknown = await controller.cancel({ taskId: 'task-x', workerId: 'worker-a' });
  assert.deepEqual([unknown.accepted, unknown.confirmed, unknown.reason], [false, false, 'unknown_run']);
  const foreign = await other.cancel(binding);
  assert.deepEqual([foreign.accepted, foreign.confirmed, foreign.reason], [false, false, 'unknown_run']);
  assert.equal(stub.calls.resolve.length, 0);
  assert.equal(stub.calls.abort.length, 0);
  assert.equal(alive(child.pid), true);

  assert.throws(
    () => controller.bind({ taskId: 'task-4', agentId: 'alice', sessionKey: 'agent:bob:longtask:task-4' }, { child, detached: true }),
    /sessionKey/u,
  );
  assert.throws(() => controller.bind({ taskId: 'task-5', agentId: 'alice' }, { detached: true }), /child/u);
});

test('LongTaskControlS17 treats a missing active handle as indeterminate, not stopped', async t => {
  const child = spawnRunChild(t);
  const stub = nativeStub({ resolve: () => undefined, drain: () => { throw new Error('must not drain'); } });
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a' });
  const binding = controller.bind({ taskId: 'task-6', agentId: 'alice' }, { child, detached: true });
  const result = await controller.cancel(binding);
  assert.deepEqual([result.accepted, result.confirmed, result.reason], [false, false, 'run_not_active']);
  assert.equal(stub.calls.abort.length, 0);
  assert.equal(alive(child.pid), true);
});

test('LongTaskControlS17 missing handle with an exited owned process confirms the real stop', async t => {
  // 首次取消中止会话后，运行退出触发对账；此时句柄已不在，必须以自有子进程的
  // 真实退出作为停止事实（不得复用杀 CLI 路径，也不得伪造停止）。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await once(child, 'exit');
  const stub = nativeStub({ resolve: () => undefined, drain: () => { throw new Error('must not drain'); } });
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a' });
  const binding = controller.bind({ taskId: 'task-6b', agentId: 'alice' }, { child, detached: true });
  const result = await controller.cancel(binding);
  assert.deepEqual([result.accepted, result.confirmed, result.reason], [true, true, '']);
  assert.equal(result.processExited, true);
  assert.equal(stub.calls.abort.length, 0);
});

test('LongTaskControlS17 uses an already-exited owned process as auxiliary evidence', async t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } });
  await once(child, 'exit');
  const stub = nativeStub({ resolve: () => 'session-4' });
  const controller = createLongTaskRunController({ native: stub.native, workerId: 'worker-a', settleMs: 200, exitGraceMs: 500 });
  const binding = controller.bind({ taskId: 'task-7', agentId: 'alice' }, { child, detached: true });
  const result = await controller.cancel(binding);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.processExited, true);
});

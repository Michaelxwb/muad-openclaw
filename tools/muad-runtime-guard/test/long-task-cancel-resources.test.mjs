import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { createLongTaskRunController } from '../src/long-task-run-controller.mjs';
import { createLongTaskHooks } from '../src/long-task-hooks.mjs';
import { SharedSkillLeaseManager } from '../src/skill-lease.mjs';
import { SharedBrowserLeaseManager } from '../src/browser-lease.mjs';

// LongTaskControlS18 [integration] 真实边界：真实 LongTaskManager、真实 shared
// Skill/browser 租约（shared-lease-queue 真实文件锁队列）、真实取消工具门禁与
// 进度桥清理；原生取消依赖以可控 stub 注入。

const tick = () => new Promise(resolve => setImmediate(resolve));

function leaseKey(agentId, runId, sessionKey) {
  return JSON.stringify([agentId, runId, sessionKey]);
}

function makeFakeChild(pid = 66_000) {
  const events = new EventEmitter();
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    once: events.once.bind(events),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    emitExit: (code = 0) => {
      child.exitCode = code;
      events.emit("exit", code);
    },
  };
  return child;
}

function taskInput(overrides = {}) {
  return {
    agentId: "alice",
    peerId: "wx-1",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    objective: "客户报告",
    replyChannel: "wecom",
    locale: "zh",
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

test('LongTaskControlS18 cancelling keeps the slot, gates tools, and releases only the target task once', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'muad-cancel-resources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillLeases = new SharedSkillLeaseManager({
    directory: path.join(root, "skill-queue"), limit: 3, waitTimeoutMs: 1_000, pollMs: 5,
  });
  const browserLeases = new SharedBrowserLeaseManager({
    directory: path.join(root, "browser-queue"), limit: 3, waitTimeoutMs: 1_000, pollMs: 5,
  });
  t.after(() => { skillLeases.close(); browserLeases.close(); });
  const released = { skill: [], browser: [], tasks: [] };
  const spy = (manager, target) => {
    const original = typeof manager.releaseSession === "function"
      ? manager.releaseSession.bind(manager)
      : async () => 0;
    manager.releaseSession = async (sessionKey) => {
      target.push(sessionKey);
      return original(sessionKey);
    };
  };
  spy(skillLeases, released.skill);
  spy(browserLeases, released.browser);

  const run = { child: null, releaseDrain: null };
  const native = {
    resolveActiveEmbeddedRunSessionId: () => "session-1",
    abortAndDrainAgentHarnessRun: async () => new Promise(resolve => {
      run.releaseDrain = () => {
        if (run.child) setImmediate(() => run.child.emitExit(0));
        resolve({ aborted: true, drained: true, forceCleared: false });
      };
    }),
  };
  const controller = createLongTaskRunController({
    native, workerId: "worker-s18", settleMs: 20, exitGraceMs: 500, log: () => {},
  });
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: path.join(root, "state.jsonl"),
    runController: controller,
    now: () => new Date("2026-10-15T11:00:00.000Z"),
    progressManager: {
      registerBackground: (info) => ({ registered: true, executionKey: `exec-${info.taskId}` }),
      finish: () => {},
    },
    releaseTaskResources: async (task) => {
      released.tasks.push(task.taskId);
      await skillLeases.releaseSession(task.sessionKey);
      await browserLeases.releaseSession(task.sessionKey);
    },
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions, resolve: null });
      return new Promise(resolve => { runs.at(-1).resolve = resolve; });
    },
  });
  t.after(() => manager.close());

  const targetSession = "agent:alice:longtask:task-cancel";
  const otherSession = "agent:alice:longtask:task-other";
  const foreignSession = "agent:bob:longtask:task-bob";
  await skillLeases.acquire(leaseKey("alice", "run-x", targetSession));
  await skillLeases.acquire(leaseKey("alice", "run-y", otherSession));
  await skillLeases.acquire(leaseKey("bob", "run-z", foreignSession));
  await browserLeases.acquire(leaseKey("alice", "call-x", targetSession));
  await browserLeases.acquire(leaseKey("bob", "call-z", foreignSession));

  const hooks = createLongTaskHooks({
    getConfig: () => ({ longTaskSkillGrants: [] }),
    resolveTaskStatus: taskId => manager.taskStatus(taskId),
  });
  const openExecutor = { toolName: "exec", params: { command: "ls" } };
  const targetCtx = { agentId: "alice", sessionKey: targetSession };
  const otherCtx = { agentId: "alice", sessionKey: otherSession };
  const foreignCtx = { agentId: "bob", sessionKey: foreignSession };
  const directCtx = { agentId: "alice", sessionKey: "agent:alice:wecom:direct:wx-1" };
  assert.equal(await hooks.beforeToolCall(openExecutor, targetCtx), undefined);

  manager.submit(taskInput({ taskId: "task-cancel" }));
  const child = makeFakeChild();
  run.child = child;
  runs[0].runOptions.onChild(child);
  manager.submit(taskInput({ taskId: "task-next" }));
  assert.equal(manager.snapshot().active, 1);

  const pending = manager.cancelTask("task-cancel", { requestedBy: "admin" });
  assert.equal(await waitFor(() => manager.taskStatus("task-cancel") === "cancelling"), true);
  // 取消尚未确认：槽位仍占用、下一任务未启动、任何租约都不提前释放。
  assert.equal(manager.snapshot().active, 1);
  assert.equal(runs.filter(entry => entry.task.taskId === "task-next").length, 0);
  assert.deepEqual(released.tasks, []);
  assert.deepEqual(released.skill, []);
  assert.deepEqual(released.browser, []);
  // 取消期间关闭目标任务的新工具调用；其他任务/其他用户/普通会话不受影响。
  const gated = await hooks.beforeToolCall(openExecutor, targetCtx);
  assert.equal(gated?.block, true);
  assert.match(gated.blockReason, /终止/u);
  assert.equal(await hooks.beforeToolCall(openExecutor, otherCtx), undefined);
  assert.equal(await hooks.beforeToolCall(openExecutor, foreignCtx), undefined);
  assert.equal(await hooks.beforeToolCall(openExecutor, directCtx), undefined);

  assert.equal(await waitFor(() => typeof run.releaseDrain === "function"), true);
  run.releaseDrain();
  const cancelled = await pending;
  assert.deepEqual([cancelled.outcome, cancelled.status], ["cancelled", "cancelled"]);
  // 确认停止后：仅释放目标任务的租约（各一次），下一任务启动，槽位恰好释放一次。
  assert.deepEqual(released.tasks, ["task-cancel"]);
  assert.deepEqual(released.skill, [targetSession]);
  assert.deepEqual(released.browser, [targetSession]);
  assert.equal(manager.snapshot().active, 1);
  assert.equal(runs.filter(entry => entry.task.taskId === "task-next").length, 1);
  assert.equal(await skillLeases.release(leaseKey("alice", "run-y", otherSession)), true);
  assert.equal(await skillLeases.release(leaseKey("bob", "run-z", foreignSession)), true);
  assert.equal(await browserLeases.release(leaseKey("bob", "call-z", foreignSession)), true);
  // 重复取消：already_terminal，且不重复释放。
  const repeated = await manager.cancelTask("task-cancel", { requestedBy: "admin" });
  assert.deepEqual([repeated.ok, repeated.reason], [false, "already_terminal"]);
  assert.equal((await hooks.beforeToolCall(openExecutor, targetCtx))?.block, true);
  assert.deepEqual(released.tasks, ["task-cancel"]);
  assert.deepEqual(released.skill, [targetSession]);
  assert.deepEqual(released.browser, [targetSession]);
});

test('LongTaskControlS18 cleanup failure keeps cancelling without releasing the slot', async t => {
  const root = mkdtempSync(path.join(tmpdir(), "muad-cancel-resources-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = { child: null };
  const native = {
    resolveActiveEmbeddedRunSessionId: () => "session-1",
    abortAndDrainAgentHarnessRun: async () => {
      if (run.child) setImmediate(() => run.child.emitExit(0));
      return { aborted: true, drained: true, forceCleared: false };
    },
  };
  const controller = createLongTaskRunController({ native, workerId: "worker-s18b", settleMs: 20, exitGraceMs: 300 });
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: path.join(root, "state.jsonl"),
    runController: controller,
    now: () => new Date("2026-10-15T11:30:00.000Z"),
    releaseTaskResources: async () => { throw new Error("lease cleanup failed"); },
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions, resolve: null });
      return new Promise(resolve => { runs.at(-1).resolve = resolve; });
    },
  });
  t.after(() => manager.close());
  manager.submit(taskInput({ taskId: "task-cleanup" }));
  const child = makeFakeChild(66_100);
  run.child = child;
  runs[0].runOptions.onChild(child);
  const result = await manager.cancelTask("task-cleanup", { requestedBy: "admin" });
  assert.deepEqual(
    [result.ok, result.outcome, result.status, result.detail],
    [true, "cancel_requested", "cancelling", "cleanup_failed"],
  );
  assert.equal(manager.taskStatus("task-cleanup"), "cancelling");
  assert.equal(manager.snapshot().active, 1);
  assert.equal(controller.lookup("task-cleanup") !== null, true);
});

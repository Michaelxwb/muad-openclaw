import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { createLongTaskRunController } from '../src/long-task-run-controller.mjs';
import { readLatestTaskStateRecords } from '../src/long-task-cancel-state.mjs';

// LongTaskControlB01/B02/E04 [integration] 真实边界：真实 LongTaskManager、真实状态
// JSONL、可控执行屏障（runTask promise）；原生取消依赖以可控 stub 注入。

const tick = () => new Promise(resolve => setImmediate(resolve));

function makeFakeChild(pid = 55_000) {
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
    originalPrompt: "生成报告",
    replyChannel: "wecom",
    locale: "zh",
    ...overrides,
  };
}

function setup(t, { limit = 1, drain = "confirm", progressManager } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "muad-cancel-manager-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.jsonl");
  const run = { child: null, aborts: 0, releaseDrain: null };
  const native = {
    resolveActiveEmbeddedRunSessionId: () => "session-1",
    abortAndDrainAgentHarnessRun: async () => {
      run.aborts += 1;
      if (drain === "confirm") {
        const child = run.child;
        if (child) setImmediate(() => child.emitExit(0));
        return { aborted: true, drained: true, forceCleared: false };
      }
      if (drain === "deferred") {
        return new Promise(resolve => {
          run.releaseDrain = () => {
            const child = run.child;
            if (child) setImmediate(() => child.emitExit(0));
            resolve({ aborted: true, drained: true, forceCleared: false });
          };
        });
      }
      return { aborted: true, drained: false, forceCleared: false };
    },
  };
  const controller = createLongTaskRunController({
    native,
    workerId: "worker-test",
    settleMs: 20,
    exitGraceMs: 300,
    log: () => {},
  });
  const progress = progressManager ?? {
    registered: [],
    finished: [],
    registerBackground: (info) => {
      progress.registered.push(info.taskId);
      return { registered: true, executionKey: `exec-${info.taskId}` };
    },
    finish: (key) => {
      progress.finished.push(key);
    },
  };
  const runs = [];
  const manager = new LongTaskManager({
    limit,
    stateFile,
    runController: controller,
    progressManager: progress,
    now: () => new Date("2026-10-15T10:00:00.000Z"),
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions, resolve: null });
      return new Promise(resolve => {
        runs.at(-1).resolve = resolve;
      });
    },
  });
  t.after(() => manager.close());
  const bind = (pid = 55_000) => {
    const child = makeFakeChild(pid);
    run.child = child;
    return child;
  };
  return { manager, controller, progress, runs, stateFile, run, bind, root };
}

function latestRecord(stateFile, taskId) {
  return readLatestTaskStateRecords(stateFile).get(taskId);
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

test('LongTaskControlB01 linearizes queued, spawn-gap and natural-completion cancels without double terminal', async t => {
  const f = setup(t, { limit: 1 });
  const first = f.manager.submit(taskInput({ taskId: "task-1" }));
  assert.equal(first.task.status, "running");
  f.bind();
  f.runs[0].runOptions.onChild(f.run.child);
  const queued = f.manager.submit(taskInput({ taskId: "task-2" }));
  assert.equal(queued.task.status, "queued");

  const cancelledQueued = await f.manager.cancelTask("task-2", { requestedBy: "admin" });
  assert.deepEqual(
    [cancelledQueued.ok, cancelledQueued.outcome, cancelledQueued.status],
    [true, "cancelled", "cancelled"],
  );
  assert.equal(f.runs.filter(entry => entry.task.taskId === "task-2").length, 0);
  assert.equal(latestRecord(f.stateFile, "task-2").status, "cancelled");
  assert.equal(f.runs[0].task.status, "running");

  // 排队取消后自然完成：drain 不得启动已取消任务。
  f.runs[0].resolve();
  await tick();
  assert.equal(latestRecord(f.stateFile, "task-1").status, "succeeded");
  assert.equal(f.runs.filter(entry => entry.task.taskId === "task-2").length, 0);
  f.manager.submit(taskInput({ taskId: "task-3" }));
  assert.equal(f.runs.filter(entry => entry.task.taskId === "task-3").length, 1);

  // spawn 间隙取消：先可靠写入 cancelling（占槽），绑定后自动完成停止确认。
  f.runs[1].resolve();
  await tick();
  const gap = f.manager.submit(taskInput({ taskId: "task-4" }));
  assert.equal(gap.task.status, "running");
  const requested = await f.manager.cancelTask("task-4", { requestedBy: "admin" });
  assert.deepEqual(
    [requested.ok, requested.outcome, requested.status, requested.detail],
    [true, "cancel_requested", "cancelling", "run_binding_pending"],
  );
  assert.equal(f.manager.snapshot().active, 1);
  assert.equal(latestRecord(f.stateFile, "task-4").status, "cancelling");
  assert.equal(latestRecord(f.stateFile, "task-4").cancelRequestedBy, "admin");

  f.bind();
  f.runs.find(entry => entry.task.taskId === "task-4").runOptions.onChild(f.run.child);
  assert.equal(await waitFor(() => latestRecord(f.stateFile, "task-4")?.status === "cancelled"), true);
  assert.equal(f.manager.snapshot().active, 0);
  const cancelledRecord = latestRecord(f.stateFile, "task-4");
  assert.ok(cancelledRecord.cancelledAt);
  assert.ok(cancelledRecord.stateRevision >= 2);

  // 迟到完成回调不得覆盖取消终态。
  f.runs.find(entry => entry.task.taskId === "task-4").resolve();
  await tick();
  assert.equal(latestRecord(f.stateFile, "task-4").status, "cancelled");
  assert.equal(f.manager.snapshot().active, 0);

  // 自然完成后再请求取消：already_terminal，不再调用原生。
  const abortsBefore = f.run.aborts;
  const done = f.manager.submit(taskInput({ taskId: "task-5" }));
  assert.equal(done.task.status, "running");
  f.bind(55_001);
  f.runs.find(entry => entry.task.taskId === "task-5").runOptions.onChild(f.run.child);
  f.runs.find(entry => entry.task.taskId === "task-5").resolve();
  await tick();
  const late = await f.manager.cancelTask("task-5", { requestedBy: "admin" });
  assert.deepEqual([late.ok, late.reason, late.status], [false, "already_terminal", "succeeded"]);
  assert.equal(f.run.aborts, abortsBefore);
});

test('LongTaskControlB02 repeated cancel requests stay idempotent and single-shot', async t => {
  const f = setup(t, { drain: "confirm" });
  f.manager.submit(taskInput({ taskId: "task-1" }));
  f.bind();
  f.runs[0].runOptions.onChild(f.run.child);
  const first = await f.manager.cancelTask("task-1", { requestedBy: "admin" });
  assert.deepEqual([first.outcome, first.status], ["cancelled", "cancelled"]);
  assert.equal(f.run.aborts, 1);
  assert.deepEqual(f.progress.finished, ["exec-task-1"]);
  assert.equal(f.controller.lookup("task-1"), null);
  for (const _ of [0, 1]) {
    const repeated = await f.manager.cancelTask("task-1", { requestedBy: "admin" });
    assert.deepEqual([repeated.ok, repeated.reason], [false, "already_terminal"]);
  }
  assert.equal(f.run.aborts, 1);
  assert.equal(f.progress.finished.length, 1);
  assert.equal(latestRecord(f.stateFile, "task-1").status, "cancelled");

  // 停止未确认时：重复请求不再二次调用原生；运行结束后做一次有界对账。
  const g = setup(t, { drain: "timeout" });
  g.manager.submit(taskInput({ taskId: "task-2" }));
  g.bind();
  g.runs[0].runOptions.onChild(g.run.child);
  const unsettled = await g.manager.cancelTask("task-2", { requestedBy: "admin" });
  assert.deepEqual(
    [unsettled.ok, unsettled.outcome, unsettled.status, unsettled.detail],
    [true, "cancel_requested", "cancelling", "drain_timeout"],
  );
  const repeated = await g.manager.cancelTask("task-2", { requestedBy: "admin" });
  assert.deepEqual([repeated.outcome, repeated.status], ["cancel_requested", "cancelling"]);
  assert.equal(g.run.aborts, 1);
  assert.equal(g.progress.finished.length, 0);
  g.runs[0].resolve();
  await tick();
  assert.equal(await waitFor(() => g.run.aborts >= 2), true);
  assert.equal(latestRecord(g.stateFile, "task-2").status, "cancelling");
  assert.equal(g.progress.finished.length, 0);
});

test('LongTaskControlE04 failed cancel persistence reports errors and never fabricates success', async t => {
  const f = setup(t, { drain: "confirm" });
  f.manager.submit(taskInput({ taskId: "task-1" }));
  f.bind();
  f.runs[0].runOptions.onChild(f.run.child);
  chmodSync(f.stateFile, 0o400);
  const denied = await f.manager.cancelTask("task-1", { requestedBy: "admin" });
  assert.deepEqual([denied.ok, denied.reason], [false, "state_unavailable"]);
  chmodSync(f.stateFile, 0o600);
  assert.equal(latestRecord(f.stateFile, "task-1").status, "running");
  assert.equal(f.run.aborts, 0);
  assert.equal(f.progress.finished.length, 0);

  // 停止已确认但终态写入失败：保持 cancelling，不伪造 cancelled，也不释放资源。
  const g = setup(t, { drain: "deferred" });
  g.manager.submit(taskInput({ taskId: "task-2" }));
  g.bind();
  g.runs[0].runOptions.onChild(g.run.child);
  const pending = g.manager.cancelTask("task-2", { requestedBy: "admin" });
  assert.equal(await waitFor(() => latestRecord(g.stateFile, "task-2")?.status === "cancelling"), true);
  assert.equal(await waitFor(() => typeof g.run.releaseDrain === "function"), true);
  chmodSync(g.stateFile, 0o400);
  g.run.releaseDrain();
  const result = await pending;
  chmodSync(g.stateFile, 0o600);
  assert.deepEqual(
    [result.ok, result.outcome, result.status, result.detail],
    [true, "cancel_requested", "cancelling", "state_unavailable"],
  );
  assert.equal(latestRecord(g.stateFile, "task-2").status, "cancelling");
  // 清理动作幂等（进度桥只登记一次），但槽位与绑定不得释放，也不得写入 cancelled。
  assert.equal(g.progress.finished.length, 1);
  assert.equal(g.controller.lookup("task-2") !== null, true);
  assert.equal(g.manager.snapshot().active, 1);
});

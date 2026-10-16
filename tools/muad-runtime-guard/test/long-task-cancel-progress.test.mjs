import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillProgressManager } from '../src/skill-progress-manager.mjs';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { createLongTaskRunController } from '../src/long-task-run-controller.mjs';

// LongTaskControlS19 [integration] 真实边界：真实 SkillProgressManager、真实进度
// 事件桥（真实文件 + 调度器），通知发送边界以可控 notify 注入。

function controlledNotify() {
  const calls = [];
  const resolvers = [];
  return {
    calls,
    notify: (input) => new Promise((resolve) => { calls.push(input); resolvers.push(resolve); }),
    resolveNext: (result) => resolvers.shift()?.(result),
  };
}

function backgroundInput(overrides = {}) {
  return {
    taskId: "task-1", agentId: "alice", skillName: "report-skill",
    replyChannel: "mattermost", peerId: "user-1", locale: "zh",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    type: "progress", stage: "query", text: "正在查询",
    visibility: "channel", privacy: "public", ts: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('LongTaskControlS19 cancel rejects late progress and drops the unsent queue', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "muad-cancel-progress-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const delivery = controlledNotify();
  const logs = [];
  const manager = new SkillProgressManager({
    rootDir,
    notify: delivery.notify,
    log: (message) => logs.push(message),
  });
  t.after(() => manager.close());
  const registration = manager.registerBackground(backgroundInput());
  const eventsFile = registration.env.MUAD_PROGRESS_EVENTS_FILE;
  assert.ok(eventsFile.startsWith(rootDir));

  // 真实进度桥：文件事件经调度器投递（第一条进入在途，未确认）。
  appendFileSync(eventsFile, `${JSON.stringify(event({ text: "第一条" }))}\n`);
  await waitFor(() => delivery.calls.length === 1);
  assert.match(delivery.calls[0].text, /第一条/u);

  // 队列中还有两条尚未发起。
  assert.equal(manager.reportProgress(registration.executionKey, event({ text: "排队一" })).accepted, true);
  assert.equal(manager.reportProgress(registration.executionKey, event({ text: "排队二" })).accepted, true);
  assert.equal(delivery.calls.length, 1);

  const cancelling = manager.cancel(registration.executionKey);
  // 取消后迟到事件被拒绝（与正常 finish 的 execution_finished 区分）。
  assert.deepEqual(
    manager.reportProgress(registration.executionKey, event({ text: "迟到" })),
    { accepted: false, reason: "execution_cancelled" },
  );
  // 在途消息放行一次后结算；未发起的两条被丢弃，迟到消息从未发送。
  delivery.resolveNext({ ok: true });
  const result = await cancelling;
  assert.equal(result.cancelled, true);
  assert.equal(result.dropped, 2);
  await waitFor(() => delivery.calls.length === 1 && !delivery.calls.some(call => /排队|迟到/u.test(call.text)));
  // 在途与丢弃都有可解释日志。
  assert.equal(logs.some(line => /action=deliver outcome=delivered/u.test(line)), true);
  assert.equal(logs.some(line => /action=deliver outcome=dropped reason=cancelled/u.test(line)), true);
  // 真实进度桥随取消清理（事件文件已移除）。
  assert.equal(existsSync(eventsFile), false);
  // 终态消息最多一次：再次取消不产生新消息、不报错。
  const again = await manager.cancel(registration.executionKey);
  assert.equal(again.cancelled, true);
  assert.equal(delivery.calls.length, 1);
  assert.deepEqual(manager.reportProgress(registration.executionKey, event()).accepted, false);
});

test('LongTaskControlS19 task cancel routes the progress bridge through cancel semantics', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "muad-cancel-progress-wiring-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const progress = new SkillProgressManager({ rootDir, notify: async () => ({ ok: true }), log: () => {} });
  t.after(() => progress.close());
  const cancelCalls = [];
  const finishCalls = [];
  const keys = [];
  const originalCancel = progress.cancel.bind(progress);
  const originalFinish = progress.finish.bind(progress);
  const originalRegister = progress.registerBackground.bind(progress);
  progress.cancel = async (key) => { cancelCalls.push(key); return originalCancel(key); };
  progress.finish = async (key) => { finishCalls.push(key); return originalFinish(key); };
  progress.registerBackground = (input) => {
    const registration = originalRegister(input);
    keys.push(registration.executionKey);
    return registration;
  };
  const stateFile = path.join(rootDir, "state.jsonl");
  const run = { child: null };
  const native = {
    resolveActiveEmbeddedRunSessionId: () => "session-1",
    abortAndDrainAgentHarnessRun: async () => {
      if (run.child) setImmediate(() => run.child.emitExit(0));
      return { aborted: true, drained: true, forceCleared: false };
    },
  };
  const controller = createLongTaskRunController({ native, workerId: "worker-s19", settleMs: 20, exitGraceMs: 300 });
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile,
    runController: controller,
    progressManager: progress,
    now: () => new Date("2026-10-15T09:00:00.000Z"),
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions, resolve: null });
      return new Promise(resolve => { runs.at(-1).resolve = resolve; });
    },
  });
  t.after(() => manager.close());
  manager.submit({
    agentId: "alice", peerId: "wx-1", sessionKey: "agent:alice:wecom:direct:wx-1",
    skillName: "report-skill", skillRoot: "/skills/report-skill",
    taskId: "task-wire", replyChannel: "wecom", locale: "zh",
  });
  const child = makeWiringChild();
  run.child = child;
  runs[0].runOptions.onChild(child);
  assert.equal(keys.length, 1);
  const result = await manager.cancelTask("task-wire", { requestedBy: "admin" });
  assert.deepEqual([result.outcome, result.status], ["cancelled", "cancelled"]);
  assert.deepEqual(cancelCalls, [keys[0]]);
  assert.deepEqual(finishCalls, []);
});

function makeWiringChild(pid = 67_000) {
  const events = new EventEmitter();
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once: events.once.bind(events),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    emitExit: (code = 0) => {
      if (events.listenerCount("exit") > 0) events.emit("exit", code);
      else setTimeout(() => events.emit("exit", code), 0);
    },
  };
}

test('LongTaskControlS19 normal finish keeps delivering the queued progress', async t => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "muad-cancel-progress-finish-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const delivery = controlledNotify();
  const manager = new SkillProgressManager({
    rootDir,
    notify: delivery.notify,
    log: () => {},
  });
  t.after(() => manager.close());
  const registration = manager.registerBackground(backgroundInput({ taskId: "task-2" }));
  assert.equal(manager.reportProgress(registration.executionKey, event({ text: "步骤一" })).accepted, true);
  assert.equal(manager.reportProgress(registration.executionKey, event({ text: "步骤二" })).accepted, true);
  await waitFor(() => delivery.calls.length === 1);
  delivery.resolveNext({ ok: true });
  const finished = manager.finish(registration.executionKey);
  await waitFor(() => delivery.calls.length === 2);
  delivery.resolveNext({ ok: true });
  const result = await finished;
  assert.equal(result.finished, true);
  assert.equal(delivery.calls.length, 2);
  assert.match(delivery.calls[1].text, /步骤二/u);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LongTaskManager, spawnOpenClawTask } from '../src/long-task-manager.mjs';
import { createResultDelivery, parseAgentResultPayloads } from '../src/long-task-delivery.mjs';
import { notifyUser } from '../../shared/notify-user.mjs';

// LongTaskControlS20 [integration] 真实边界：真实子进程流消费（注入 spawn 的可控
// stdout/stderr）、真实结果解析与 manager 投递仲裁；通知边界以可控 notify 注入。

const tick = () => new Promise(resolve => setImmediate(resolve));

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

function makeFakeChild() {
  const events = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 88_000;
  child.once = events.once.bind(events);
  child.on = events.on.bind(events);
  child.removeListener = events.removeListener.bind(events);
  child.emitExit = (code = 0) => {
    child.exitCode = code;
    events.emit("exit", code);
  };
  return child;
}

test('LongTaskControlS20 drains the agent stream, parses multi-segment results and never passes --deliver', async t => {
  const resultJson = JSON.stringify({
    result: {
      payloads: [
        { text: "第一段" },
        { text: "第二段" },
        { text: "带附件", media: ["/tmp/report.png"] },
      ],
    },
  });
  const calls = [];
  const child = makeFakeChild();
  const promise = spawnOpenClawTask(taskInput(), {
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => {
        // 持续消费：先推入 2MB 行式诊断输出，再给最终 JSON；全部写完才 exit。
        const filler = `${"x".repeat(199_999)}\n`;
        for (let index = 0; index < 10; index += 1) child.stdout.emit("data", filler);
        child.stdout.emit("data", `${resultJson}\n`);
        child.stderr.emit("data", "diag line\n");
        child.emitExit(0);
      });
      return child;
    },
  });
  const settled = await promise;
  assert.equal(calls[0].command, "openclaw");
  assert.equal(calls[0].args.includes("--deliver"), false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(settled.payloads.map(item => item.text), ["第一段", "第二段", "带附件"]);
  assert.deepEqual(settled.payloads[2].media, ["/tmp/report.png"]);

  // 输出溢出上限：仍持续消费不阻塞，但结果不可解析时失败要显式（fail loud）。
  const overflow = makeFakeChild();
  const failing = spawnOpenClawTask(taskInput({ taskId: "task-overflow" }), {
    spawn: () => {
      queueMicrotask(() => {
        const filler = "y".repeat(1_000_000);
        for (let index = 0; index < 8; index += 1) overflow.stdout.emit("data", filler);
        overflow.emitExit(0);
      });
      return overflow;
    },
  });
  await assert.rejects(failing, /could not be parsed/u);

  // 空输出：成功且无投递内容。
  const silent = makeFakeChild();
  const emptyResult = await spawnOpenClawTask(taskInput({ taskId: "task-silent" }), {
    spawn: () => {
      queueMicrotask(() => silent.emitExit(0));
      return silent;
    },
  });
  assert.deepEqual(emptyResult.payloads, []);

  // 解析器边界：空、非法 JSON、payloads 非数组。
  assert.deepEqual(parseAgentResultPayloads(""), { ok: true, payloads: [] });
  assert.equal(parseAgentResultPayloads("not json at all").ok, false);
  assert.equal(parseAgentResultPayloads(JSON.stringify({ result: { payloads: "nope" } })).ok, false);
});

test('LongTaskControlS20 arbitrates delivery against cancellation in the task critical section', async t => {
  const root = mkdtempSync(path.join(tmpdir(), "muad-cancel-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deliveries = [];
  const failures = [];
  const runs = [];
  const manager = new LongTaskManager({
    limit: 4,
    stateFile: path.join(root, "state.jsonl"),
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    notifyFailure: async (task, code) => { failures.push([task.taskId, code]); },
    deliverResult: async (task, payloads) => {
      deliveries.push([task.taskId, payloads.map(item => item.text)]);
      return { delivered: true, sent: payloads.length, failed: 0 };
    },
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions, resolve: null, reject: null });
      return new Promise((resolve, reject) => {
        runs.at(-1).resolve = resolve;
        runs.at(-1).reject = reject;
      });
    },
  });
  t.after(() => manager.close());

  // 正常完成：投递许可在临界区发起一次。
  manager.submit(taskInput({ taskId: "task-ok" }));
  runs[0].resolve({ payloads: [{ text: "结果 A" }, { text: "结果 B" }] });
  await tick();
  assert.deepEqual(deliveries, [["task-ok", ["结果 A", "结果 B"]]]);
  assert.deepEqual(failures, []);
  // 已在途投递视为在途：随后取消请求得到 already_terminal，不再触发第二次投递。
  const late = await manager.cancelTask("task-ok", { requestedBy: "admin" });
  assert.deepEqual([late.ok, late.reason], [false, "already_terminal"]);
  assert.equal(deliveries.length, 1);

  // 取消后迟到成功结果：不再新发成功结果，也不发通用失败通知。
  manager.submit(taskInput({ taskId: "task-cancel" }));
  const cancelled = await manager.cancelTask("task-cancel", { requestedBy: "admin" });
  assert.deepEqual([cancelled.outcome, cancelled.status], ["cancel_requested", "cancelling"]);
  runs[1].resolve({ payloads: [{ text: "迟到的结果" }] });
  await tick();
  assert.equal(deliveries.some(([taskId]) => taskId === "task-cancel"), false);
  assert.deepEqual(failures, []);

  // 取消后迟到失败：通用失败通知同样被抑制。
  manager.submit(taskInput({ taskId: "task-failed-cancel" }));
  const stopped = await manager.cancelTask("task-failed-cancel", { requestedBy: "admin" });
  assert.deepEqual([stopped.outcome, stopped.status], ["cancel_requested", "cancelling"]);
  runs[2].reject(new Error("late failure"));
  await tick();
  assert.deepEqual(failures, []);
  assert.equal(manager.taskStatus("task-failed-cancel"), "cancelling");

  // 正常失败：仍发送一次通用失败通知（与取消语义区分）。
  manager.submit(taskInput({ taskId: "task-failed" }));
  runs[3].reject(new Error("boom"));
  await tick();
  assert.equal(failures.some(([taskId, code]) => taskId === "task-failed"), true);
});

test('LongTaskControlS20 preserves segments and media through the controlled notification boundary', async t => {
  const calls = [];
  const delivery = createResultDelivery({
    notify: async (input) => {
      calls.push(input);
      return calls.length === 2 ? { ok: false, error: "simulated failure" } : { ok: true };
    },
  });
  const outcome = await delivery(
    { taskId: "task-media", replyChannel: "mattermost", peerId: "user-1" },
    [
      { text: "第一段" },
      { text: "第二段" },
      { text: "带附件", media: ["/tmp/report.png", "/tmp/data.csv"] },
      { media: "/tmp/only.png" },
    ],
  );
  assert.equal(outcome.sent, 5);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.delivered, false);
  assert.deepEqual(calls.map(call => [call.text, call.media ?? ""]), [
    ["第一段", ""],
    ["第二段", ""],
    ["带附件", ""],
    ["", "/tmp/report.png"],
    ["", "/tmp/data.csv"],
    ["", "/tmp/only.png"],
  ]);

  // 真实 notifyUser：媒体经 --media 传递；text 与 media 至少其一。
  const spawnCalls = [];
  const spawnStub = (command, args) => {
    spawnCalls.push({ command, args });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  assert.deepEqual(await notifyUser({ channel: "wecom", peerId: "wx-1", media: "/tmp/report.png", spawn: spawnStub }), { ok: true });
  assert.equal(spawnCalls[0].args.includes("--media"), true);
  assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf("--media") + 1], "/tmp/report.png");
  assert.equal(spawnCalls[0].args.includes("--message"), false);
  assert.deepEqual(await notifyUser({ channel: "wecom", peerId: "wx-1", spawn: spawnStub }), {
    ok: false, error: "notify-user: channel, peerId, and text or media are required",
  });
});

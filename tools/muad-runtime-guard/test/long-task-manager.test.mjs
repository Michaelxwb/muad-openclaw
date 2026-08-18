import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";

import { LongTaskManager, spawnOpenClawTask, longTaskMessage, taskIdLine, failureText } from "../src/long-task-manager.mjs";

test("LongTaskManager limits concurrency per agent-user pool and drains FIFO", async () => {
  const runs = [];
  let now = new Date("2026-08-09T10:00:00.000Z");
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-test-")), "state.jsonl"),
    now: () => now,
    runTask: (task) => new Promise((resolve, reject) => runs.push({ task, resolve, reject })),
  });

  const first = manager.submit(taskInput("first"));
  const second = manager.submit(taskInput("second"));

  assert.equal(first.task.status, "running");
  assert.equal(second.task.status, "queued");
  assert.equal(first.task.poolKey, "agent:alice:wecom:direct:wx-1");
  assert.equal(second.queuedAhead, 0);
  assert.equal(manager.snapshot().active, 1);
  assert.equal(manager.snapshot().queued, 1);
  assert.equal(manager.snapshot().pools[0].sessionKey, "agent:alice:wecom:direct:wx-1");
  assert.equal(runs.length, 1);

  now = new Date("2026-08-09T10:01:00.000Z");
  runs[0].resolve();
  await tick();

  const snapshot = manager.snapshot();
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.queued, 0);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].task.objective, "second");
  assert.equal(snapshot.pools[0].tasks.some((task) => task.status === "succeeded"), true);
});

test("LongTaskManager purges terminal tasks with the injected clock", async () => {
  const runs = [];
  let now = new Date("2000-01-01T00:00:00.000Z");
  const manager = new LongTaskManager({
    limit: 1,
    terminalRetentionMs: 10 * 60_000,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-clock-")), "state.jsonl"),
    now: () => now,
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
  });

  manager.submit(taskInput("old clock task"));
  runs[0].resolve();
  await tick();
  now = new Date("2000-01-01T00:05:00.000Z");

  const tasks = manager.snapshot().pools[0].tasks;
  assert.equal(tasks.some((task) => task.status === "succeeded"), true);
});

test("LongTaskManager isolates same peer id across reply channels", () => {
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-channel-")), "state.jsonl"),
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
  });

  const wecom = manager.submit(taskInput("wecom task"));
  const mattermost = manager.submit({ ...taskInput("mattermost task"), replyChannel: "mattermost" });

  assert.equal(wecom.task.status, "running");
  assert.equal(mattermost.task.status, "running");
  assert.equal(manager.snapshot().active, 2);
  assert.deepEqual(
    manager.snapshot().pools.map((pool) => pool.poolKey).sort(),
    ["agent:alice:mattermost:direct:wx-1", "agent:alice:wecom:direct:wx-1"],
  );
});

test("LongTaskManager drains queued tasks when the limit increases", () => {
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-limit-")), "state.jsonl"),
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
  });

  manager.submit(taskInput("first"));
  manager.submit(taskInput("second"));
  manager.updateLimit(2);

  const snapshot = manager.snapshot();
  assert.equal(runs.length, 2);
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.queued, 0);
});

test("LongTaskManager records rejected runs as failed", async () => {
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-reject-")), "state.jsonl"),
    runTask: () => {
      const error = new Error("spawn failed");
      error.code = "long_task_spawn_failed";
      return Promise.reject(error);
    },
  });

  manager.submit(taskInput("reject"));
  await tick();

  const tasks = manager.snapshot().pools[0].tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].terminalReason, "spawn failed");
  assert.equal(tasks[0].errorCode, "long_task_spawn_failed");
});

test("LongTaskManager restores interrupted queued or running tasks as failed", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-interrupted-"));
  const stateFile = join(root, "state.jsonl");
  writeFileSync(stateFile, `${JSON.stringify({
    taskId: "task-1",
    poolKey: "agent:alice:wecom:direct:wx-1",
    sourceSessionKey: "agent:alice:wecom:direct:wx-1",
    sessionKey: "agent:alice:longtask:task-1",
    agentId: "alice",
    peerId: "wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    status: "running",
    submittedAt: "2026-08-09T10:00:00.000Z",
    startedAt: "2026-08-09T10:00:01.000Z",
    updatedAt: "2026-08-09T10:00:01.000Z",
  })}\n`);

  const manager = new LongTaskManager({
    stateFile,
    now: () => new Date("2026-08-09T10:05:00.000Z"),
    runTask: async () => {},
  });

  const tasks = manager.snapshot().pools[0].tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].errorCode, "long_task_interrupted");
});

test("LongTaskManager compacts state file by dropping expired terminal records", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-compact-"));
  const stateFile = join(root, "state.jsonl");
  writeFileSync(stateFile, `${JSON.stringify({
    taskId: "old-terminal",
    poolKey: "agent:alice:wecom:direct:wx-1",
    sourceSessionKey: "agent:alice:wecom:direct:wx-1",
    sessionKey: "agent:alice:longtask:old-terminal",
    agentId: "alice",
    peerId: "wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    status: "succeeded",
    submittedAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:01:00.000Z",
  })}\n`);
  const manager = new LongTaskManager({
    limit: 1,
    compactEvery: 1,
    terminalRetentionMs: 10 * 60_000,
    stateFile,
    now: () => new Date("2026-08-09T10:00:00.000Z"),
    runTask: () => new Promise(() => undefined),
  });

  const submitted = manager.submit(taskInput("current"));
  const records = readFileSync(stateFile, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));

  assert.equal(records.length, 1);
  assert.equal(records[0].taskId, submitted.task.taskId);
  assert.equal(records[0].status, "running");
});

test("spawnOpenClawTask uses isolated session and independent reply channel", async () => {
  const calls = [];
  await spawnOpenClawTask({
    taskId: "task-1",
    agentId: "alice",
    peerId: "wx-1",
    sessionKey: "agent:alice:longtask:task-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    objective: "check alerts",
    originalPrompt: "/skill:xdr-query check alerts",
    replyChannel: "openclaw-weixin",
  }, {
    timeoutSeconds: 30,
    spawn: (command, args) => {
      calls.push({ command, args, message: readFileSync(args[args.indexOf("--message-file") + 1], "utf8") });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(calls[0].command, "openclaw");
  assert.equal(calls[0].args[0], "agent");
  assert.equal(calls[0].args[calls[0].args.indexOf("--agent") + 1], "alice");
  assert.equal(
    calls[0].args[calls[0].args.indexOf("--session-key") + 1],
    "agent:alice:longtask:task-1",
  );
  assert.match(calls[0].args[calls[0].args.indexOf("--message-file") + 1], /message\.txt$/u);
  assert.equal(calls[0].args.includes("--deliver"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("--reply-channel") + 1], "openclaw-weixin");
  assert.equal(calls[0].args[calls[0].args.indexOf("--reply-to") + 1], "wx-1");
  assert.equal(calls[0].args.includes("--json"), true);
  assert.equal(calls[0].args[calls[0].args.indexOf("--timeout") + 1], "30");
  assert.match(calls[0].message, /Read and follow the real Skill instructions/u);
  assert.match(calls[0].message, /任务ID：task-1/u);
  assert.match(calls[0].message, /character-for-character/u);
});

test("taskIdLine renders the task ID in the guard locale", () => {
  assert.equal(taskIdLine("zh", "task-1"), "任务ID：task-1");
  assert.equal(taskIdLine("en", "task-1"), "Task ID: task-1");
  assert.equal(taskIdLine("zh", ""), "");
});

test("longTaskMessage prefixes the final result with the task ID in the guard locale", () => {
  const zh = longTaskMessage({ ...spawnTask(), locale: "zh" });
  assert.match(zh, /任务ID：task-1/u);
  assert.match(zh, /MUST begin with the following line/u);

  const en = longTaskMessage({ ...spawnTask(), locale: "en" });
  assert.match(en, /Task ID: task-1/u);
  assert.doesNotMatch(en, /任务ID/u);

  const noId = longTaskMessage({ ...spawnTask(), taskId: "" });
  assert.doesNotMatch(noId, /任务ID/u);
  assert.doesNotMatch(noId, /Task ID/u);
});

test("spawnOpenClawTask classifies non-zero exits and timeouts", async () => {
  await assert.rejects(
    () => spawnOpenClawTask(spawnTask(), { spawn: failingSpawn(2, "boom") }),
    (error) => error.code === "long_task_spawn_failed" && error.exitCode === 2,
  );
  await assert.rejects(
    () => spawnOpenClawTask(spawnTask(), { spawn: failingSpawn(124, "timed out") }),
    (error) => error.code === "longtask.timeout" && error.exitCode === 124,
  );
});

test("LongTaskManager resolves the peer for a task session across running, queued, and terminal tasks", async () => {
  const runs = [];
  let now = new Date("2026-08-09T10:00:00.000Z");
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-peer-")), "state.jsonl"),
    now: () => now,
    runTask: (task) => new Promise((resolve, reject) => runs.push({ task, resolve, reject })),
  });

  const running = manager.submit(taskInput("running"));
  const queued = manager.submit({ ...taskInput("queued"), taskId: "task-queued" });
  assert.equal(manager.resolvePeerForTaskId(running.task.taskId), "wx-1");
  assert.equal(manager.resolvePeerForTaskId("task-queued"), "wx-1");

  runs[0].resolve();
  await tick();
  assert.equal(manager.resolvePeerForTaskId(running.task.taskId), "wx-1");

  assert.equal(manager.resolvePeerForTaskId("no-such-task"), "");
});

test("LongTaskManager notifies onChange on submit, queue, and finish", async () => {
  const runs = [];
  let now = new Date("2026-08-09T10:00:00.000Z");
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-change-")), "state.jsonl"),
    now: () => now,
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
  });

  const snapshots = [];
  manager.subscribe((snapshot) => snapshots.push(snapshot));

  // subscribe fires immediately with the current (empty) snapshot.
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].active, 0);

  manager.submit(taskInput("first"));
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].active, 1);

  manager.submit(taskInput("second"));
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[2].active, 1);
  assert.equal(snapshots[2].queued, 1);

  now = new Date("2026-08-09T10:01:00.000Z");
  runs[0].resolve();
  await tick();

  // finish → onChange, then drain starts the queued task → onChange.
  assert.equal(snapshots.length, 5);
  assert.equal(snapshots[3].pools[0].tasks.some((task) => task.status === "succeeded"), true);
  assert.equal(snapshots[4].active, 1);
  assert.equal(snapshots[4].queued, 0);
});

test("LongTaskManager unsubscribe stops onChange notifications", async () => {
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-unsub-")), "state.jsonl"),
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
  });

  const snapshots = [];
  const unsubscribe = manager.subscribe((snapshot) => snapshots.push(snapshot));
  manager.submit(taskInput("first"));
  assert.equal(snapshots.length, 2);
  unsubscribe();

  runs[0].resolve();
  await tick();
  assert.equal(snapshots.length, 2);
});

test("LongTaskManager subscribe fires immediately with restored interrupted tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-subscribe-interrupted-"));
  const stateFile = join(root, "state.jsonl");
  writeFileSync(stateFile, `${JSON.stringify({
    taskId: "task-1",
    poolKey: "agent:alice:wecom:direct:wx-1",
    sourceSessionKey: "agent:alice:wecom:direct:wx-1",
    sessionKey: "agent:alice:longtask:task-1",
    agentId: "alice",
    peerId: "wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    status: "running",
    submittedAt: "2026-08-09T10:00:00.000Z",
    startedAt: "2026-08-09T10:00:01.000Z",
    updatedAt: "2026-08-09T10:00:01.000Z",
  })}\n`);

  const manager = new LongTaskManager({
    stateFile,
    now: () => new Date("2026-08-09T10:05:00.000Z"),
    runTask: async () => {},
  });

  const snapshots = [];
  manager.subscribe((snapshot) => snapshots.push(snapshot));
  const tasks = snapshots[0].pools[0].tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].errorCode, "long_task_interrupted");
});

function failingSpawn(code, stderr) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit("data", stderr);
      child.emit("exit", code);
    });
    return child;
  };
}

function spawnTask() {
  return {
    taskId: "task-1",
    agentId: "alice",
    peerId: "wx-1",
    sessionKey: "agent:alice:longtask:task-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    objective: "check alerts",
    originalPrompt: "/skill:xdr-query check alerts",
    replyChannel: "wecom",
  };
}

test("LongTaskManager logs submit/start/finish through the injected log", async () => {
  const logs = [];
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-log-")), "state.jsonl"),
    now: () => new Date("2026-08-09T10:00:00.000Z"),
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
    log: (message) => logs.push(message),
  });

  manager.submit(taskInput("first"));
  assert.equal(logs.some((msg) => msg.includes("long task submitted") && msg.includes("xdr-query")), true);
  assert.equal(logs.some((msg) => msg.includes("long task started") && msg.includes("xdr-query")), true);

  runs[0].resolve();
  await tick();
  assert.equal(logs.some((msg) => msg.includes("long task succeeded") && msg.includes("xdr-query")), true);
});

test("spawnOpenClawTask spawns with stdout ignored so an unconsumed pipe cannot deadlock", async () => {
  const calls = [];
  await spawnOpenClawTask(spawnTask(), {
    spawn: (command, args, options) => {
      calls.push({ command, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.deepEqual(calls[0].options.stdio, ["ignore", "ignore", "pipe"]);
});

test("spawnOpenClawTask watchdog kills a never-exiting child and rejects with a timeout error", async () => {
  const killed = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { killed.push(signal); return true; };

  await assert.rejects(
    () => spawnOpenClawTask(spawnTask(), {
      watchdogMs: 25,
      spawn: () => child,
    }),
    (error) => error.code === "longtask.timeout" && error.exitCode === 124 &&
      /timeout/u.test(error.message),
  );
  assert.deepEqual(killed, ["SIGKILL"]);

  // A late exit after the watchdog must not flip the already-rejected outcome.
  child.emit("exit", 0);
  child.emit("error", new Error("late failure"));
});

test("spawnOpenClawTask watchdog does not fire when the child exits in time", async () => {
  const calls = [];
  await spawnOpenClawTask(spawnTask(), {
    watchdogMs: 60_000,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      calls.push(child);
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.equal(calls.length, 1);
});

test("LongTaskManager persists recovered interrupted tasks as failed so restarts never re-restore them", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-persist-interrupted-"));
  const stateFile = join(root, "state.jsonl");
  writeFileSync(stateFile, `${JSON.stringify(interruptedStateRecord("task-1", "running"))}\n`);

  const now = new Date("2026-08-09T10:05:00.000Z");
  const manager = new LongTaskManager({
    stateFile,
    now: () => now,
    runTask: async () => {},
  });

  // 内存视图：恢复为 failed。
  const tasks = manager.snapshot().pools[0].tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].errorCode, "long_task_interrupted");

  // 落盘：state 文件最新记录必须是 failed（terminal_reason 走终端 retention）。
  const records = readFileSync(stateFile, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(records[records.length - 1].taskId, "task-1");
  assert.equal(records[records.length - 1].status, "failed");
  assert.equal(records[records.length - 1].terminalReason, "runtime restarted before the long task finished");

  // 第二次启动：task-1 已是终态，不再恢复。
  const manager2 = new LongTaskManager({
    stateFile,
    now: () => now,
    runTask: async () => {},
  });
  assert.equal(manager2.snapshot().pools.length, 0);
});

test("LongTaskManager records the child pid and flags recovered running tasks whose orphan still lives", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-orphan-"));
  const stateFile = join(root, "state.jsonl");
  // childPid = 本进程 PID：孤儿仍在运行 → terminalReason 需标注残余风险。
  writeFileSync(stateFile, `${JSON.stringify(interruptedStateRecord("task-alive", "running", process.pid))}\n`);
  const manager = new LongTaskManager({
    stateFile,
    now: () => new Date("2026-08-09T10:05:00.000Z"),
    runTask: async () => {},
  });
  const alive = manager.snapshot().pools[0].tasks[0];
  assert.equal(alive.status, "failed");
  assert.match(alive.terminalReason, /orphaned child may still deliver/u);

  // childPid 已死/不存在 → 标准 interrupted 文案。
  const deadRoot = mkdtempSync(join(tmpdir(), "muad-long-task-orphan-dead-"));
  const deadFile = join(deadRoot, "state.jsonl");
  writeFileSync(deadFile, `${JSON.stringify(interruptedStateRecord("task-dead", "running", 999_999_999))}\n`);
  const deadManager = new LongTaskManager({
    stateFile: deadFile,
    now: () => new Date("2026-08-09T10:05:00.000Z"),
    runTask: async () => {},
  });
  const dead = deadManager.snapshot().pools[0].tasks[0];
  assert.equal(dead.status, "failed");
  assert.equal(dead.terminalReason, "runtime restarted before the long task finished");
});

test("LongTaskManager writes the spawned child pid into the state record", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-pid-record-"));
  const stateFile = join(root, "state.jsonl");
  const runs = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile,
    runTask: (task) => {
      // 模拟 runOpenClawAgent 同步 spawn 后写回 task.childPid。
      task.childPid = 4242;
      return new Promise((resolve, reject) => runs.push({ task, resolve, reject }));
    },
  });
  const submitted = manager.submit(taskInput("pid task"));
  assert.equal(runs.length, 1);
  assert.equal(submitted.task.childPid, 4242);

  // #start 在 spawn 后二次落盘，state 文件应携带 childPid（供孤儿检测）。
  const records = readFileSync(stateFile, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.ok(records.some((record) =>
    record.taskId === submitted.task.taskId && record.childPid === 4242));
  runs[0].resolve();
  await tick();
});

test("LongTaskManager notifies failure through the injected notifyFailure", async () => {
  const runs = [];
  const failures = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-fail-notify-")), "state.jsonl"),
    runTask: (task) => new Promise((resolve, reject) => runs.push({ task, resolve, reject })),
    notifyFailure: async (task, code) => { failures.push({ task, code }); },
  });

  manager.submit(taskInput("boom"));
  runs[0].reject(new Error("simulated failure"));
  await tick();

  assert.equal(failures.length, 1);
  assert.equal(failures[0].task.skillName, "xdr-query");
  assert.equal(failures[0].code, "long_task_failed");
  // 任务已标记 failed 并落盘，不因通知失败而丢失状态。
  const task = manager.snapshot().pools[0].tasks.find((item) => item.skillName === "xdr-query");
  assert.equal(task.status, "failed");
});

test("LongTaskManager skips failure notify on success", async () => {
  const runs = [];
  const failures = [];
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: join(mkdtempSync(join(tmpdir(), "muad-long-task-success-no-notify-")), "state.jsonl"),
    runTask: (task) => new Promise((resolve) => runs.push({ task, resolve })),
    notifyFailure: async () => { failures.push(1); },
  });

  manager.submit(taskInput("ok"));
  runs[0].resolve();
  await tick();

  assert.equal(failures.length, 0, "success must not trigger failure notify");
});

function taskInput(objective) {
  return {
    agentId: "alice",
    peerId: "wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    objective,
    originalPrompt: objective,
    replyChannel: "wecom",
    sessionKey: "agent:alice:wecom:direct:wx-1",
  };
}

test("failureText includes truncated real error detail and localized labels", () => {
  const task = {
    taskId: "task-1",
    skillName: "xdr-query",
    locale: "zh",
    terminalReason: "GatewayClientRequestError: FailoverError: HTTP 401: Authentication Fails, Your api key: ****dsfs is invalid",
  };
  const text = failureText(task, "long_task_spawn_failed");
  assert.match(text, /任务ID：task-1/);
  assert.match(text, /任务失败：xdr-query/);
  assert.match(text, /失败原因：任务启动失败/);
  assert.match(text, /错误信息：GatewayClientRequestError: FailoverError: HTTP 401/);
});

test("failureText truncates long error detail and omits the line when absent", () => {
  const longDetail = `ERROR: ${"x".repeat(500)}`;
  const text = failureText(
    { taskId: "t", skillName: "s", locale: "zh", terminalReason: longDetail },
    "long_task_failed",
  );
  assert.match(text, /错误信息：ERROR: x+/);
  assert.ok(text.endsWith("…"), "truncated detail must end with ellipsis");
  assert.doesNotMatch(text, /x{300}/, "detail is truncated to under 300 chars");

  const noDetail = failureText({ taskId: "t", skillName: "s", locale: "zh" }, "long_task_failed");
  assert.doesNotMatch(noDetail, /错误信息/);
});

test("failureText renders English labels for en locale", () => {
  const text = failureText(
    { taskId: "t", skillName: "s", locale: "en", terminalReason: "boom" },
    "long_task_failed",
  );
  assert.match(text, /Task ID: t/);
  assert.match(text, /Task failed: s/);
  assert.match(text, /Reason: /);
  assert.match(text, /Error: boom/);
});

function interruptedStateRecord(taskId, status, childPid) {
  return {
    taskId,
    poolKey: "agent:alice:wecom:direct:wx-1",
    sourceSessionKey: "agent:alice:wecom:direct:wx-1",
    sessionKey: `agent:alice:longtask:${taskId}`,
    agentId: "alice",
    peerId: "wx-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    status,
    submittedAt: "2026-08-09T10:00:00.000Z",
    startedAt: "2026-08-09T10:00:01.000Z",
    updatedAt: "2026-08-09T10:00:01.000Z",
    ...(Number.isInteger(childPid) ? { childPid } : {}),
  };
}

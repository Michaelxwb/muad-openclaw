import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SESSION_CANCEL_LOG,
  createSessionCancelHandler,
  createSessionPreviewHandler,
} from "../src/session-cancel-rpc.mjs";
import { createSessionCancelController } from "../src/session-cancel-controller.mjs";
import { fingerprint } from "../src/session-process-sweeper.mjs";

// E-02 / B-04 [integration/unit]：真实 RPC handler + fake procRoot。取消只按指纹
// 复核结果发信号；longtask key / PID 1 / self / 畸形参数一律拒绝或跳过。

const SESSION_KEY = "agent:alice:wecom:direct:wx-1";
const UID = 1000;
const SECRET_ENV = "MUAD_CHANNEL_TOKEN=do-not-log-this";
const CONFIG = { sessionAgentIds: ["alice", "bob"] };

function makeProcRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-cancel-rpc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "uptime"), "100.00 200.00\n");
  return root;
}

function addProcess(procRoot, { pid, uid = UID, pgid = pid, startTime = 1000, cmdline = ["node", "worker.js"], environ = [] }) {
  const dir = path.join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  const statFields = ["S", "1", String(pgid), String(pgid), "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", String(startTime), "0", "0"];
  writeFileSync(path.join(dir, "stat"), `${pid} (worker) ${statFields.join(" ")}`);
  writeFileSync(path.join(dir, "status"), `Name:\tworker\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(path.join(dir, "cmdline"), cmdline.map((part) => `${part}\u0000`).join(""));
  writeFileSync(path.join(dir, "environ"), environ.map((part) => `${part}\u0000`).join(""));
}

function readFile(file) {
  return readFileSync(file);
}

function fakeNative(overrides = {}) {
  const calls = { resolved: [], aborted: [] };
  const native = {
    resolveActiveEmbeddedRunSessionId: (sessionKey) => {
      calls.resolved.push(sessionKey);
      return "run-1";
    },
    abortAndDrainAgentHarnessRun: async (options) => {
      calls.aborted.push(options);
      return { aborted: true, drained: true, forceCleared: false };
    },
    ...overrides,
  };
  return { native, calls };
}

function handlerOptions(t, procRoot, overrides = {}) {
  const { native, calls } = fakeNative(overrides.nativeOverrides);
  const signals = [];
  const logs = [];
  const options = {
    config: CONFIG,
    capability: { available: true, version: 1, reason: "" },
    runtime: { native },
    procRoot,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => {
      signals.push([target, signal]);
      // 模拟进程在收到信号后退出（fake /proc 目录消失）。
      rmSync(path.join(procRoot, String(Math.abs(target))), { recursive: true, force: true });
    },
    sleep: async () => {},
    termWaitMs: 0,
    killWaitMs: 0,
    log: (line) => logs.push(line),
    ...overrides.options,
  };
  return { options, signals, logs, calls };
}

test("E-02 stale preview: changed startTime is skipped and no signal is sent", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, {
    pid: 4028,
    startTime: 111,
    cmdline: ["sh", "-c", "python3 scripts/run.py --seconds 180"],
    environ: [SECRET_ENV, `MUAD_SESSION_KEY=${SESSION_KEY}`],
  });
  const { options, signals, calls } = handlerOptions(t, procRoot);
  const preview = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.processes.length, 1);
  const stale = { pid: 4028, fingerprint: preview.processes[0].fingerprint };

  // 预览后 PID 被复用：同一 pid，startTime 变化。
  addProcess(procRoot, {
    pid: 4028,
    startTime: 222,
    cmdline: ["sh", "-c", "python3 scripts/run.py --seconds 180"],
    environ: [SECRET_ENV, `MUAD_SESSION_KEY=${SESSION_KEY}`],
  });
  const result = await createSessionCancelHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1", expected: [stale],
  });

  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.equal(result.drained, true);
  assert.equal(result.killed, 0);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.processes, [{ pid: 4028, outcome: "skipped", reason: "fingerprint_mismatch" }]);
  assert.deepEqual(signals, []);
  // run 级 abort 仍然执行（取消的是会话，不是过期指纹）。
  assert.deepEqual(calls.aborted.map((item) => item.sessionId), ["run-1"]);
});

test("E-02 stale preview: exited process is reported skipped when expected pid is gone", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4100, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const { options, signals } = handlerOptions(t, procRoot);
  const preview = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });
  const stale = { pid: 4100, fingerprint: preview.processes[0].fingerprint };
  rmSync(path.join(procRoot, "4100"), { recursive: true, force: true });

  const result = await createSessionCancelHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1", expected: [stale],
  });

  assert.equal(result.killed, 0);
  assert.deepEqual(signals, []);
  assert.deepEqual(result.processes, [{ pid: 4100, outcome: "skipped", reason: "not_found" }]);
});

test("B-04 rejected-targets: longtask keys, unknown agents and malformed keys are invalid", async (t) => {
  const procRoot = makeProcRoot(t);
  const { options, signals } = handlerOptions(t, procRoot);
  const preview = createSessionPreviewHandler(options);
  const cancel = createSessionCancelHandler(options);

  for (const sessionKey of [
    "agent:alice:longtask:task-1",
    "agent:alice:wecom:longtask:wx-1",
    "agent:mallory:wecom:direct:wx-1",
    "agent:alice:wecom:direct",
    "agent:alice:wecom:direct:wx-1:extra",
    "session:alice:wecom:direct:wx-1",
  ]) {
    assert.deepEqual(
      await preview({ sessionKey, requestedBy: "admin-1" }),
      { ok: false, reason: "invalid_session_key" },
      sessionKey,
    );
    assert.deepEqual(
      await cancel({ sessionKey, requestedBy: "admin-1", expected: [{ pid: 42, fingerprint: "0123456789abcdef" }] }),
      { ok: false, reason: "invalid_session_key" },
      sessionKey,
    );
  }
  assert.deepEqual(signals, []);
});

test("B-04 rejected-targets: PID 1 and self never enter candidates or receive signals", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 1, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 999, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 4200, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const { options, signals } = handlerOptions(t, procRoot);

  const preview = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });
  assert.deepEqual(preview.processes.map((item) => item.pid), [4200]);
  assert.equal(preview.processes.some((item) => item.pid === 1 || item.pid === 999), false);

  // expected 里显式带上 PID 1 被参数校验拒绝；self 指纹合法但终止时被跳过。
  const cancel = createSessionCancelHandler(options);
  assert.deepEqual(
    await cancel({ sessionKey: SESSION_KEY, requestedBy: "admin-1", expected: [{ pid: 1, fingerprint: "0123456789abcdef" }] }),
    { ok: false, reason: "invalid_expected" },
  );
  const selfFingerprint = fingerprint(SESSION_KEY, 999, 999, 1000, UID);
  const result = await cancel({
    sessionKey: SESSION_KEY,
    requestedBy: "admin-1",
    expected: [{ pid: 999, fingerprint: selfFingerprint }],
  });
  assert.equal(result.killed, 0);
  assert.deepEqual(
    result.processes.find((item) => item.pid === 999),
    { pid: 999, outcome: "skipped", reason: "protected" },
  );
  assert.deepEqual(signals, []);
});

test("preview is read-only and returns activeRun plus exact-key candidates", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, {
    pid: 4028,
    startTime: 1234567,
    cmdline: ["sh", "-c", "python3 scripts/run.py --seconds 180"],
    environ: [SECRET_ENV, `MUAD_SESSION_KEY=${SESSION_KEY}`],
  });
  addProcess(procRoot, { pid: 4029, environ: ["MUAD_SESSION_KEY=agent:alice:wecom:direct:wx-2"] });
  const { options, signals, calls } = handlerOptions(t, procRoot);

  const result = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });

  assert.deepEqual(result.activeRun, { active: true, sessionId: "run-1" });
  assert.deepEqual(calls.resolved, [SESSION_KEY]);
  assert.equal(result.agentId, "alice");
  assert.equal(result.sessionKey, SESSION_KEY);
  assert.deepEqual(result.processes, [{
    pid: 4028,
    pgid: 4028,
    startTime: 1234567,
    uid: UID,
    leader: true,
    ageSeconds: 0,
    cmdline: "sh -c python3 scripts/run.py --seconds 180",
    fingerprint: fingerprint(SESSION_KEY, 4028, 4028, 1234567, UID),
  }]);
  assert.deepEqual(result.skipped, { notOwner: 0, envMismatch: 1, permissionDenied: 0 });
  assert.deepEqual(signals, []);
  assert.deepEqual(calls.aborted, []);
});

test("preview reports an inactive run when no embedded run is registered", async (t) => {
  const procRoot = makeProcRoot(t);
  const { options } = handlerOptions(t, procRoot, {
    nativeOverrides: { resolveActiveEmbeddedRunSessionId: () => "" },
  });

  const result = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });

  assert.deepEqual(result.activeRun, { active: false });
  assert.deepEqual(result.processes, []);
});

test("capability gate: unavailable cancel chain rejects both RPCs without scanning", async (t) => {
  const procRoot = makeProcRoot(t);
  let scans = 0;
  const { options, signals } = handlerOptions(t, procRoot, {
    options: {
      capability: { available: false, version: 0, reason: "native_unavailable" },
      scan: () => { scans += 1; throw new Error("scan must not run"); },
    },
  });

  assert.deepEqual(
    await createSessionPreviewHandler(options)({ sessionKey: SESSION_KEY, requestedBy: "admin-1" }),
    { ok: false, reason: "session_cancel_unavailable" },
  );
  assert.deepEqual(
    await createSessionCancelHandler(options)({
      sessionKey: SESSION_KEY, requestedBy: "admin-1", expected: [{ pid: 4028, fingerprint: "0123456789abcdef" }],
    }),
    { ok: false, reason: "session_cancel_unavailable" },
  );
  assert.equal(scans, 0);
  assert.deepEqual(signals, []);
});

test("cancel aborts/drains the active run, terminates confirmed processes and reports real counts", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4028, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 4029, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const progress = {
    captured: [], notified: [],
    captureCancelRoute(input) {
      this.captured.push(input);
      return { route: { channel: "wecom", peerId: "user-9" }, skillName: "slow-foreground-smoke", locale: "zh" };
    },
    async notifyCancelled(notice, counts) {
      this.notified.push({ notice, counts });
      return { delivered: true };
    },
  };
  const { options, signals, calls, logs } = handlerOptions(t, procRoot, { options: { progress } });
  const preview = await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  });
  const expected = preview.processes.map((item) => ({ pid: item.pid, fingerprint: item.fingerprint }));

  const result = await createSessionCancelHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1", expected,
  });

  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.equal(result.drained, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.killed, 2);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.processes, [
    { pid: 4028, outcome: "terminated", reason: "sigterm" },
    { pid: 4029, outcome: "terminated", reason: "sigterm" },
  ]);
  assert.deepEqual(signals, [[-4028, "SIGTERM"], [-4029, "SIGTERM"]]);
  assert.deepEqual(calls.aborted, [{ sessionId: "run-1", sessionKey: SESSION_KEY, settleMs: 2000, forceClear: false }]);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.ok(line.startsWith(SESSION_CANCEL_LOG), `missing prefix: ${line}`);
    assert.equal(line.includes(SESSION_KEY), false);
    assert.equal(line.includes("admin-1"), false);
    assert.equal(line.includes("do-not-log-this"), false);
    assert.equal(line.includes("run.py"), false);
  }
  assert.deepEqual(progress.captured, [{ sessionKey: SESSION_KEY, agentId: "alice" }]);
  assert.equal(progress.notified.length, 1);
  assert.deepEqual(progress.notified[0].counts, { killed: 2, remaining: [] });
  assert.equal(progress.notified[0].notice.skillName, "slow-foreground-smoke");
});

test("empty expected aborts the run and kills no processes", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4028, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const { options, signals, calls } = handlerOptions(t, procRoot);

  const result = await createSessionCancelHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1", expected: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.equal(result.drained, true);
  assert.equal(result.killed, 0);
  assert.deepEqual(result.remaining, []);
  // 空 expected 不杀进程：扫描到的候选按 not_expected 上报，便于管理员确认。
  assert.deepEqual(result.processes, [{ pid: 4028, outcome: "skipped", reason: "not_expected" }]);
  assert.deepEqual(signals, []);
  assert.equal(calls.aborted.length, 1);
});

test("cancel still cleans processes when the run already ended", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4300, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const { options, signals } = handlerOptions(t, procRoot, {
    nativeOverrides: { resolveActiveEmbeddedRunSessionId: () => "" },
  });
  const [candidate] = (await createSessionPreviewHandler(options)({
    sessionKey: SESSION_KEY, requestedBy: "admin-1",
  })).processes;

  const result = await createSessionCancelHandler(options)({
    sessionKey: SESSION_KEY,
    requestedBy: "admin-1",
    expected: [{ pid: candidate.pid, fingerprint: candidate.fingerprint }],
  });

  assert.equal(result.aborted, false);
  assert.equal(result.drained, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.killed, 1);
  assert.deepEqual(signals, [[-4300, "SIGTERM"]]);
});

test("cancel rejects malformed requests and unwraps the gateway params envelope", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4400, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const { options } = handlerOptions(t, procRoot);
  const preview = createSessionPreviewHandler(options);
  const cancel = createSessionCancelHandler(options);

  for (const params of [
    undefined, null, [], {},
    { sessionKey: SESSION_KEY },
    { sessionKey: SESSION_KEY, requestedBy: "" },
    { sessionKey: SESSION_KEY, requestedBy: "admin-1", extra: true },
    { sessionKey: SESSION_KEY, requestedBy: "bad\nidentity" },
  ]) {
    assert.deepEqual(await preview(params), { ok: false, reason: "invalid_request" }, JSON.stringify(params));
  }
  assert.deepEqual(
    await preview({ sessionKey: `agent:alice:wecom:direct:${"x".repeat(300)}`, requestedBy: "admin-1" }),
    { ok: false, reason: "invalid_session_key" },
  );
  for (const expected of [undefined, [{ pid: 0, fingerprint: "0123456789abcdef" }],
    [{ pid: 42, fingerprint: "short" }], [{ pid: 42 }], [{ pid: "42", fingerprint: "0123456789abcdef" }]]) {
    assert.deepEqual(await cancel({ sessionKey: SESSION_KEY, requestedBy: "admin-1", expected }),
      { ok: false, reason: "invalid_expected" }, JSON.stringify(expected));
  }

  const unwrapped = await preview({ params: { sessionKey: SESSION_KEY, requestedBy: "admin-1" } });
  assert.equal(unwrapped.ok, true);
  assert.equal(unwrapped.sessionKey, SESSION_KEY);
});

test("controller bounds native resolve/abort and never forces a clear", async () => {
  const aborted = [];
  const controller = createSessionCancelController({
    native: {
      resolveActiveEmbeddedRunSessionId: () => "run-9",
      abortAndDrainAgentHarnessRun: async (options) => {
        aborted.push(options);
        return { aborted: true, drained: true, forceCleared: true };
      },
    },
    log: () => {},
  });

  const result = await controller.abort(SESSION_KEY);

  assert.equal(result.aborted, true);
  assert.equal(result.drained, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "force_clear_not_stop");
  assert.equal(aborted[0].forceClear, false);
});

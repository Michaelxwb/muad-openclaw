import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_KILL_WAIT_MS,
  DEFAULT_TERM_WAIT_MS,
  SESSION_SWEEPER_LOG,
  fingerprint,
  scanSessionProcesses,
  terminateConfirmed,
} from "../src/session-process-sweeper.mjs";

// fake procRoot 单测：验证精确 MUAD_SESSION_KEY 匹配、UID 校验、指纹复核与
// 组长/非组长的信号目标。测试自建 /proc 目录结构，信号函数与 sleep 均注入。

const SESSION_KEY = "agent:john-24c84418:wecom:direct:john-24c84418";
const UID = 1000;
const SECRET_ENV = "MUAD_CHANNEL_TOKEN=do-not-log-this";

function makeProcRoot(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-sweeper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "uptime"), "100.00 200.00\n");
  return root;
}

// 构造与 Linux procfs 字段位置一致的 stat/status/cmdline/environ。
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

function withEnvironError(read, pid, code) {
  const target = path.join("", String(pid), "environ");
  return (file) => {
    if (file.endsWith(target)) {
      const error = new Error(`${code}: injected`);
      error.code = code;
      throw error;
    }
    return read(file);
  };
}

function scan(procRoot, overrides = {}) {
  return scanSessionProcesses({
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    log: () => {},
    ...overrides,
  });
}

test("fingerprint is the first 16 hex of sha256(sessionKey|pid|pgid|startTime|uid)", () => {
  assert.equal(fingerprint(SESSION_KEY, 4028, 4028, 1234567, 1000), "6f83593224aea045");
  assert.match(fingerprint(SESSION_KEY, 1, 1, 1, 1), /^[0-9a-f]{16}$/u);
  assert.notEqual(
    fingerprint(SESSION_KEY, 4028, 4028, 1234567, 1000),
    fingerprint(SESSION_KEY, 4028, 4028, 1234568, 1000),
  );
});

test("scan matches only the exact MUAD_SESSION_KEY entry owned by the guard uid", (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, {
    pid: 4028,
    startTime: 1234567,
    cmdline: ["sh", "-c", "python3 scripts/run.py --seconds 180"],
    environ: [SECRET_ENV, `MUAD_SESSION_KEY=${SESSION_KEY}`],
  });

  const result = scan(procRoot);

  assert.equal(result.processes.length, 1);
  const [candidate] = result.processes;
  assert.deepEqual(candidate, {
    pid: 4028,
    pgid: 4028,
    startTime: 1234567,
    uid: UID,
    leader: true,
    ageSeconds: 0,
    cmdline: "sh -c python3 scripts/run.py --seconds 180",
    fingerprint: fingerprint(SESSION_KEY, 4028, 4028, 1234567, UID),
  });
  assert.deepEqual(result.skippedPids, []);
});

test("ageSeconds is derived from /proc/uptime and startTime", (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4029, startTime: 5000, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });

  const [candidate] = scan(procRoot).processes;

  assert.equal(candidate.ageSeconds, 50);
});

test("owner-and-permission: uid mismatch, EPERM environ, empty cmdline, pid 1, self and key prefixes are skipped", (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 1, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 999, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 200, uid: 2000, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 300, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 400, cmdline: [], environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 500, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}-suffix`] });
  addProcess(procRoot, { pid: 600, environ: ["OTHER=1"] });
  addProcess(procRoot, { pid: 700, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });

  const result = scan(procRoot, { readFile: withEnvironError(readFile, 300, "EPERM") });

  assert.deepEqual(result.processes.map((item) => item.pid), [700]);
  assert.deepEqual(result.skipped, {
    protected: 2,
    emptyCmdline: 1,
    permissionDenied: 1,
    notOwner: 1,
    envMismatch: 2,
    unreadable: 0,
  });
  assert.deepEqual(
    result.skippedPids.map((item) => [item.pid, item.reason]),
    [
      [1, "protected"],
      [200, "not_owner"],
      [300, "permission_denied"],
      [400, "empty_cmdline"],
      [500, "env_mismatch"],
      [600, "env_mismatch"],
      [999, "protected"],
    ],
  );
});

test("scan treats an unreadable proc entry as skipped without throwing", (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 800, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });

  const result = scan(procRoot, {
    readFile: (file) => {
      if (file.endsWith(path.join("800", "status"))) {
        const error = new Error("EIO: injected");
        error.code = "EIO";
        throw error;
      }
      return readFileSync(file);
    },
  });

  assert.deepEqual(result.processes, []);
  assert.equal(result.skipped.unreadable, 1);
});

test("B-01 pid reuse: changed startTime skips the candidate and sends no signal", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 4028, startTime: 111, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const preview = scan(procRoot);
  const [candidate] = preview.processes;
  assert.equal(candidate.startTime, 111);

  // 预览后 pid 被复用：同一 pid 的 startTime 变化。
  addProcess(procRoot, { pid: 4028, startTime: 222, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const signals = [];
  const result = await terminateConfirmed(preview.processes, [{ pid: 4028, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => signals.push([target, signal]),
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(signals, []);
  assert.equal(result.killed, 0);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.processes, [{ pid: 4028, outcome: "skipped", reason: "identity_changed" }]);
});

test("B-03 non-leader only signals the pid, never the process group", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 600, pgid: 500, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const [candidate] = scan(procRoot).processes;
  assert.equal(candidate.leader, false);

  const signals = [];
  const result = await terminateConfirmed([candidate], [{ pid: 600, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => signals.push([target, signal]),
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(signals, [[600, "SIGTERM"], [600, "SIGKILL"]]);
  assert.equal(result.killed, 0);
  assert.deepEqual(result.remaining, [600]);
});

test("leader signals the process group for TERM and KILL", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 700, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const [candidate] = scan(procRoot).processes;

  const signals = [];
  await terminateConfirmed([candidate], [{ pid: 700, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => signals.push([target, signal]),
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(signals, [[-700, "SIGTERM"], [-700, "SIGKILL"]]);
});

test("termination uses TERM, waits, then KILL and reports the real remaining set", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 810, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  addProcess(procRoot, { pid: 820, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const candidates = scan(procRoot).processes;
  const expected = candidates.map((item) => ({ pid: item.pid, fingerprint: item.fingerprint }));
  const firstSignal = new Map();

  const result = await terminateConfirmed(candidates, expected, {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => {
      const pid = Math.abs(target);
      if (!firstSignal.has(pid)) firstSignal.set(pid, signal);
      if (pid === 810 && signal === "SIGTERM") {
        // 810 在 TERM 后退出，820 忽略 TERM 直到 KILL。
        rmSync(path.join(procRoot, "810"), { recursive: true, force: true });
      }
      if (pid === 820 && signal === "SIGKILL") {
        rmSync(path.join(procRoot, "820"), { recursive: true, force: true });
      }
    },
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(firstSignal.get(810), "SIGTERM");
  assert.deepEqual(firstSignal.get(820), "SIGTERM");
  assert.deepEqual(result.processes, [
    { pid: 810, outcome: "terminated", reason: "sigterm" },
    { pid: 820, outcome: "killed", reason: "sigkill" },
  ]);
  assert.equal(result.killed, 2);
  assert.deepEqual(result.remaining, []);
});

test("processes surviving SIGKILL stay in remaining and are never reported as killed", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 830, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const [candidate] = scan(procRoot).processes;

  const result = await terminateConfirmed([candidate], [{ pid: 830, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: () => {},
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(result.processes, [{ pid: 830, outcome: "remaining", reason: "still_running" }]);
  assert.equal(result.killed, 0);
  assert.deepEqual(result.remaining, [830]);
});

test("cancel re-verifies environ and skips processes whose key no longer matches", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 840, environ: [`MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const [candidate] = scan(procRoot).processes;
  // 会话 key 变化（同一 pid 的生命周期内 environ 实际不可变，这里模拟读取到不同值）。
  addProcess(procRoot, { pid: 840, environ: ["MUAD_SESSION_KEY=agent:other:wecom:direct:other"] });
  const signals = [];

  const result = await terminateConfirmed([candidate], [{ pid: 840, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: (target, signal) => signals.push([target, signal]),
    sleep: async () => {},
    log: () => {},
  });

  assert.deepEqual(signals, []);
  assert.deepEqual(result.processes, [{ pid: 840, outcome: "skipped", reason: "env_mismatch" }]);
});

test("default wait budgets follow TERM 3s and KILL 2s", () => {
  assert.equal(DEFAULT_TERM_WAIT_MS, 3000);
  assert.equal(DEFAULT_KILL_WAIT_MS, 2000);
});

test("logs keep the stable prefix and never leak session keys, environ values or cmdlines", async (t) => {
  const procRoot = makeProcRoot(t);
  addProcess(procRoot, { pid: 850, environ: [SECRET_ENV, `MUAD_SESSION_KEY=${SESSION_KEY}`] });
  const lines = [];
  const log = (line) => lines.push(line);

  const [candidate] = scan(procRoot, { log }).processes;
  await terminateConfirmed([candidate], [{ pid: 850, fingerprint: candidate.fingerprint }], {
    procRoot,
    sessionKey: SESSION_KEY,
    uid: UID,
    selfPid: 999,
    readFile,
    kill: () => {},
    sleep: async () => {},
    log,
  });

  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.startsWith(SESSION_SWEEPER_LOG), `missing prefix: ${line}`);
    assert.ok(!line.includes(SESSION_KEY));
    assert.ok(!line.includes("do-not-log-this"));
    assert.ok(!line.includes("worker.js"));
  }
  assert.ok(lines.some((line) => line.includes(`pid=850`)));
  assert.ok(lines.some((line) => line.includes("killed=")));
});

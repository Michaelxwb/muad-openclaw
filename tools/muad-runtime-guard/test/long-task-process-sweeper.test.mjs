import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { listProcessesByMarker, sweepOrphanProcesses } from "../src/long-task-process-sweeper.mjs";

// 真实分离子进程（detached + 独立会话）与真实 /proc 读取：验证按归属标记回收
// 的设置集执行进程，zombie 视为已停止（容器 PID1 不回收），未知标记不误杀。

function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error("condition not reached before timeout")); }
    }, 50);
  });
}

test("orphan sweeper kills detached executions by ownership marker", { skip: process.platform !== "linux" ? "linux /proc required" : false }, async t => {
  const marker = `/tmp/ltc-sweeper-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)", marker], { stdio: "ignore", detached: true });
  child.unref();
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } });

  await waitFor(() => listProcessesByMarker(marker).some(item => item.pid === child.pid));
  const found = listProcessesByMarker(marker);
  assert.ok(found.some(item => item.pid === child.pid), "detached process must be found by marker");

  const result = await sweepOrphanProcesses(marker, { attempts: 60, delayMs: 100 });
  assert.equal(result.ok, true, `remaining: ${JSON.stringify(result.remaining)}`);
  await waitFor(() => listProcessesByMarker(marker).every(item => item.zombie));
  assert.deepEqual(listProcessesByMarker(marker).filter(item => !item.zombie), []);
});

test("orphan sweeper is a no-op for unknown markers and empty markers", async () => {
  assert.deepEqual(await sweepOrphanProcesses(""), { ok: true, remaining: [] });
  const result = await sweepOrphanProcesses(`/tmp/definitely-not-running-${Date.now()}`);
  assert.deepEqual(result, { ok: true, remaining: [] });
  assert.deepEqual(listProcessesByMarker(`/tmp/definitely-not-running-${Date.now()}`), []);
});

test("orphan sweeper loops until injectable enumeration reports empty", async () => {
  let calls = 0;
  const list = () => (calls++ < 2 ? [{ pid: 111, zombie: false }] : [{ pid: 111, zombie: true }]);
  const killed = [];
  const result = await sweepOrphanProcesses("marker", {
    list,
    kill: (pid, signal) => killed.push([pid, signal]),
    attempts: 5,
    delayMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(result, { ok: true, remaining: [] });
  assert.deepEqual(killed, [[111, "SIGKILL"], [111, "SIGKILL"]]);
});

test("orphan sweeper reports failure when processes survive the budget", async () => {
  const result = await sweepOrphanProcesses("marker", {
    list: () => [{ pid: 222, zombie: false }],
    kill: () => {},
    attempts: 3,
    delayMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(result, { ok: false, remaining: [222] });
});

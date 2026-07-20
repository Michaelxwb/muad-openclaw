import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserBusyError,
  BrowserLeaseManager,
  SharedBrowserLeaseManager,
} from "../src/browser-lease.mjs";
import { installBrowserLease } from "../src/index.mjs";

test("browser lease enforces the limit and grants queued calls after release", async () => {
  const leases = manager({ limit: 1 });
  await leases.acquire("call-1", { agentId: "alice" });
  const second = leases.acquire("call-2", { agentId: "bob" });
  assert.deepEqual(leases.snapshot(), { active: 1, queued: 1, limit: 1 });

  assert.equal(leases.release("call-1"), true);
  assert.equal(await second, "call-2");
  assert.deepEqual(leases.snapshot(), { active: 1, queued: 0, limit: 1 });
  assert.equal(leases.release("call-2"), true);
});

test("browser lease rejects duplicate calls and bounded queue timeouts", async () => {
  const leases = manager({ limit: 1, waitTimeoutMs: 10 });
  await leases.acquire("call-1");
  await assert.rejects(() => leases.acquire("call-1"), browserBusy);
  await assert.rejects(() => leases.acquire("call-2"), browserBusy);
  leases.close();
});

test("watchdog sweep recovers an abandoned lease and drains the queue", async () => {
  let now = 1_000;
  const leases = manager({ limit: 1, leaseTtlMs: 100, now: () => now });
  await leases.acquire("abandoned", { agentId: "alice" });
  const queued = leases.acquire("recovered", { agentId: "bob" });

  now = 1_101;
  assert.equal(leases.sweep(), 1);
  assert.equal(await queued, "recovered");
  assert.deepEqual(leases.snapshot(), { active: 1, queued: 0, limit: 1 });
  leases.close();
});

test("shared browser lease reports leases held by another plugin context", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-shared-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory, limit: 1, waitTimeoutMs: 1_000, maxQueue: 2, pollMs: 5 };
  const first = new SharedBrowserLeaseManager(options);
  const second = new SharedBrowserLeaseManager(options);
  await first.acquire("call-1");
  const waiting = second.acquire("call-2");
  await waitFor(() => first.snapshot().queued === 1);
  assert.deepEqual(second.snapshot(), { active: 1, queued: 1, limit: 1 });

  assert.equal(await first.release("call-1"), true);
  assert.equal(await waiting, "call-2");
  assert.deepEqual(first.snapshot(), { active: 1, queued: 0, limit: 1 });
  assert.equal(await second.release("call-2"), true);
});

test("shared browser lease tightens a pre-existing queue directory", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-shared-browser-open-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o777);
  const leases = new SharedBrowserLeaseManager({ directory, limit: 1 });

  await leases.acquire("call-1");

  assert.equal(statSync(directory).mode & 0o077, 0);
  assert.equal(await leases.release("call-1"), true);
});

test("shared browser lease expires when release hook is missed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-shared-browser-expire-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const leases = new SharedBrowserLeaseManager({
    directory,
    limit: 1,
    leaseTtlMs: 30,
    heartbeatMs: 5,
  });

  await leases.acquire("call-1");
  await waitFor(() => leases.snapshot().active === 0);

  assert.deepEqual(leases.snapshot(), { active: 0, queued: 0, limit: 1 });
  leases.close();
});

test("browser plugin registration reuses the shared manager for the same limit", () => {
  const globals = {};
  const first = installBrowserLease(2, globals);
  const second = installBrowserLease(2, globals);
  assert.equal(second, first);
  assert.equal(second.limit, 2);
  second.close();
  const third = installBrowserLease(2, globals);
  assert.notEqual(third, first);
  third.close();
});

function manager(overrides) {
  return new BrowserLeaseManager({
    limit: 2,
    waitTimeoutMs: 100,
    leaseTtlMs: 1_000,
    watchdogIntervalMs: 100,
    autoStart: false,
    ...overrides,
  });
}

function browserBusy(error) {
  return error instanceof BrowserBusyError && error.code === "browser_busy";
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("shared queue state timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

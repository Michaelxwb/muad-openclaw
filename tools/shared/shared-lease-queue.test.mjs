import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";

import { SharedLeaseQueue } from "./shared-lease-queue.mjs";

test("heartbeats refresh the lease expiry so long-running work is never silently released", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const dir = mkdtempSync(join(tmpdir(), "muad-lease-heartbeat-"));
  const queue = new SharedLeaseQueue({
    directory: dir,
    limit: 1,
    leaseTtlMs: 10_000,
    heartbeatMs: 1_000,
    waitTimeoutMs: 1_000,
    pollMs: 50,
  });
  const release = await queue.acquire({ key: "k" });
  const slot = join(dir, "active-0.json");
  assert.equal(exists(slot), true);

  // 5 个心跳（5s），远未到原 TTL（10s）：租赁保持。
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(exists(slot), true, "lease still held after 5s");
  assert.equal(queue.snapshot().active, 1);

  // 越过原 TTL 继续推进（累计 11s > 10s）：心跳必须续期 expiresAt，租赁不得被释放。
  t.mock.timers.tick(6_000);
  await tick();
  assert.equal(exists(slot), true, "lease must survive past the original TTL because heartbeats refresh it");
  assert.equal(queue.snapshot().active, 1);

  await release();
  assert.equal(exists(slot), false, "explicit release removes the slot");
  t.mock.timers.reset();
});

test("abandoned leases are reclaimed by the stale sweep (10x TTL) after the owner dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muad-lease-sweep-"));
  const slot = join(dir, "active-0.json");
  writeFileSync(slot, `${JSON.stringify({
    owner: "dead-owner", keyHash: "dead", createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  // 进程崩溃后无心跳：mtime 停在 60s 前，超过 10×TTL（leaseTtlMs=1s → 31s）。
  const old = new Date(Date.now() - 60_000);
  utimesSync(slot, old, old);

  const queue = new SharedLeaseQueue({
    directory: dir,
    limit: 1,
    leaseTtlMs: 1_000,
    heartbeatMs: 100,
    waitTimeoutMs: 500,
    pollMs: 50,
  });
  // acquire 前先 sweepStale：若僵尸槽未被回收，limit=1 下 acquire 只能排队并最终超时。
  const release = await queue.acquire({ key: "k" });
  const record = JSON.parse(readFileSync(slot, "utf8"));
  assert.notEqual(record.owner, "dead-owner", "stale lease reclaimed by the sweep during acquire");
  await release();
});

function exists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

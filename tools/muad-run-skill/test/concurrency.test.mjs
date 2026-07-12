import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoundedSkillQueue, SharedSkillQueue, SkillBusyError } from "../src/concurrency.mjs";

test("bounded queue serializes work and reports active and queued counts", async () => {
  const queue = new BoundedSkillQueue({ limit: 1, waitTimeoutMs: 1_000, maxQueue: 2 });
  const releaseFirst = await queue.acquire();
  const second = queue.acquire();
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 1, limit: 1 });
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(queue.snapshot(), { active: 1, queued: 0, limit: 1 });
  releaseSecond();
  assert.deepEqual(queue.snapshot(), { active: 0, queued: 0, limit: 1 });
});

test("bounded queue rejects full and timed-out waiters with skill_busy", async () => {
  const queue = new BoundedSkillQueue({ limit: 1, waitTimeoutMs: 10, maxQueue: 1 });
  const release = await queue.acquire();
  const waiting = queue.acquire();
  await assert.rejects(() => queue.acquire(), (error) => error instanceof SkillBusyError);
  await assert.rejects(() => waiting, (error) => error instanceof SkillBusyError && error.code === "skill_busy");
  release();
  assert.equal(queue.snapshot().active, 0);
});

test("aborted queue wait is removed without consuming a slot", async () => {
  const queue = new BoundedSkillQueue({ limit: 1, waitTimeoutMs: 1_000, maxQueue: 2 });
  const release = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(() => waiting, /cancelled/u);
  assert.equal(queue.snapshot().queued, 0);
  release();
});

test("shared skill queue coordinates independent plugin contexts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-shared-skill-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory, limit: 1, waitTimeoutMs: 1_000, maxQueue: 2, pollMs: 5 };
  const first = new SharedSkillQueue(options);
  const second = new SharedSkillQueue(options);
  const releaseFirst = await first.acquire();
  const waiting = second.acquire();
  await waitFor(() => second.snapshot().queued === 1);
  assert.deepEqual(first.snapshot(), { active: 1, queued: 1, limit: 1 });

  await releaseFirst();
  const releaseSecond = await waiting;
  assert.deepEqual(second.snapshot(), { active: 1, queued: 0, limit: 1 });
  await releaseSecond();
});

test("shared skill queue bounds waiters and returns skill_busy on timeout", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-shared-skill-busy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory, limit: 1, waitTimeoutMs: 20, maxQueue: 1, pollMs: 5 };
  const first = new SharedSkillQueue(options);
  const second = new SharedSkillQueue(options);
  const third = new SharedSkillQueue(options);
  const release = await first.acquire();
  const waiting = second.acquire();
  await waitFor(() => first.snapshot().queued === 1);

  await assert.rejects(() => third.acquire(), (error) => error instanceof SkillBusyError);
  await assert.rejects(() => waiting, (error) => error instanceof SkillBusyError);
  await release();
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("shared queue state timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";

import { createLongTaskStatePushTrigger } from "../src/index.mjs";
import { LongTaskStateClientError } from "../src/long-task-state-client.mjs";

test("push trigger forwards snapshots and logs the pushed task count", async () => {
  const pushed = [];
  const logs = [];
  const trigger = createLongTaskStatePushTrigger(
    { push: async (snapshot) => { pushed.push(snapshot); return { updated: 1 }; } },
    (message) => logs.push(message),
  );

  const snapshot = { active: 1, queued: 0, limit: 2, pools: [{ tasks: [1, 2, 3] }] };
  trigger(snapshot);
  await tick();

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0], snapshot);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /pushed 3 task/);
});

test("push trigger logs failures without throwing or blocking", async () => {
  const logs = [];
  const error = new LongTaskStateClientError("service_unavailable", true);
  const trigger = createLongTaskStatePushTrigger(
    { push: async () => { throw error; } },
    (message) => logs.push(message),
  );

  trigger({ active: 0, queued: 0, limit: 2, pools: [] });
  await tick();

  assert.equal(logs.length, 1);
  assert.match(logs[0], /push failed code=service_unavailable retryable=true/);
});

test("push trigger skips snapshots when the client is absent or lacks push", () => {
  const logs = [];
  const trigger = createLongTaskStatePushTrigger(null, (message) => logs.push(message));
  trigger({ active: 0, queued: 0, limit: 2, pools: [] });
  assert.equal(logs.length, 0);
});

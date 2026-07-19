import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OutboxError, SkillTelemetryOutbox } from "../src/outbox.mjs";

test("capacity failure preserves existing telemetry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-outbox-"));
  const filePath = path.join(root, "outbox.ndjson");
  const outbox = new SkillTelemetryOutbox({ filePath, maxBytes: 320 });
  await outbox.append(event("exec-1", 1, "running"));
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(
    outbox.append(event("exec-2", 1, "x".repeat(500))),
    (error) => error instanceof OutboxError && error.code === "outbox_capacity_exceeded",
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("corrupt records are isolated while valid records remain replayable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-outbox-corrupt-"));
  const filePath = path.join(root, "outbox.ndjson");
  const outbox = new SkillTelemetryOutbox({ filePath, maxBytes: 4096 });
  await outbox.append(event("exec-1", 1, "running"));
  await fs.appendFile(filePath, "{not-json}\n");

  const loaded = await outbox.load();
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.corruptCount, 1);
  assert.match(await fs.readFile(`${filePath}.corrupt`, "utf8"), /not-json/u);
  assert.doesNotMatch(await fs.readFile(filePath, "utf8"), /not-json/u);
});

function event(executionId, eventSeq, status) {
  return { executionId, eventSeq, status, errorMessage: "token=must-redact" };
}

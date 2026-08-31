import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProgressEventBridge } from "../src/progress-event-bridge.mjs";

test("ProgressEventBridge creates opaque 0700/0600 execution files", (t) => {
  const fixture = createFixture(t);
  const registration = fixture.bridge.register({
    executionKey: "agent:alice:mattermost:direct:user-1:report-skill",
  });

  assert.equal(fileMode(fixture.rootDir), 0o700);
  assert.equal(fileMode(registration.stateDir), 0o700);
  assert.equal(fileMode(registration.eventsFile), 0o600);
  assert.match(path.basename(registration.stateDir), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(registration.stateDir.includes("alice"), false);
  assert.equal(registration.stateDir.includes("user-1"), false);
  assert.equal(registration.stateDir.includes("report-skill"), false);
});

test("ProgressEventBridge E-02 preserves partial UTF-8, quarantines bad JSON, and recovers truncation", (t) => {
  const fixture = createFixture(t);
  const executionKey = "execution-e02";
  const { eventsFile } = fixture.bridge.register({ executionKey });
  const first = eventLine("partial", "第一条 😀");
  const emojiStart = first.indexOf(Buffer.from("😀"));

  appendFileSync(eventsFile, first.subarray(0, emojiStart + 2));
  assert.equal(fixture.bridge.drain(executionKey).delivered, 0);
  appendFileSync(eventsFile, Buffer.concat([
    first.subarray(emojiStart + 2),
    Buffer.from("not-json\n", "utf8"),
    eventLine("after-bad", "后续合法"),
  ]));
  fixture.bridge.drain(executionKey);

  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["partial", "after-bad"]);
  assert.equal(fixture.events[0].event.text, "第一条 😀");
  assert.equal(fixture.logs.some((line) => line.includes("reason=invalid_json")), true);
  assert.equal(fixture.logs.some((line) => line.includes("not-json")), false);
  assert.equal(fixture.bridge.drain(executionKey).delivered, 0, "events are not replayed");

  truncateSync(eventsFile, 0);
  appendFileSync(eventsFile, eventLine("after-truncate", "截断后合法"));
  fixture.bridge.drain(executionKey);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), [
    "partial", "after-bad", "after-truncate",
  ]);
  assert.equal(fixture.logs.some((line) => line.includes("reason=file_truncated")), true);
});

test("ProgressEventBridge E-02 detects truncate followed by a larger rewrite", (t) => {
  const fixture = createFixture(t);
  const executionKey = "execution-fast-rewrite";
  const { eventsFile } = fixture.bridge.register({ executionKey });
  appendFileSync(eventsFile, eventLine("before", "first"));
  fixture.bridge.drain(executionKey);

  truncateSync(eventsFile, 0);
  appendFileSync(eventsFile, eventLine("after", "x".repeat(512)));
  fixture.bridge.drain(executionKey);

  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["before", "after"]);
  assert.equal(fixture.logs.some((line) => line.includes("reason=file_truncated")), true);
});

test("ProgressEventBridge E-02 drops an oversized line and resumes at the next LF", (t) => {
  const fixture = createFixture(t, { maxLineBytes: 128 });
  const executionKey = "execution-line-capacity";
  const { eventsFile } = fixture.bridge.register({ executionKey });

  appendFileSync(eventsFile, Buffer.concat([
    Buffer.from(`${"x".repeat(129)}\n`, "utf8"),
    eventLine("recovered", "still delivered"),
  ]));
  fixture.bridge.drain(executionKey);

  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["recovered"]);
  assert.equal(
    fixture.logs.filter((line) => line.includes("reason=line_capacity_exceeded")).length,
    1,
  );
});

test("ProgressEventBridge B-05 bounds each drain while preserving order", (t) => {
  const fixture = createFixture(t, { maxEventsPerDrain: 2 });
  const executionKey = "execution-event-budget";
  const { eventsFile } = fixture.bridge.register({ executionKey });
  appendFileSync(eventsFile, Buffer.concat([
    eventLine("one", "1"), eventLine("two", "2"), eventLine("three", "3"),
  ]));

  const first = fixture.bridge.drain(executionKey);
  assert.equal(first.delivered, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["one", "two"]);
  fixture.bridge.drain(executionKey);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["one", "two", "three"]);
});

test("ProgressEventBridge B-05 enforces the byte budget per drain", (t) => {
  const firstLine = eventLine("one", "1");
  const fixture = createFixture(t, { maxReadBytesPerDrain: firstLine.length });
  const executionKey = "execution-byte-budget";
  const { eventsFile } = fixture.bridge.register({ executionKey });
  appendFileSync(eventsFile, Buffer.concat([firstLine, eventLine("two", "2")]));

  const first = fixture.bridge.drain(executionKey);
  assert.equal(first.bytesRead, firstLine.length);
  assert.equal(first.delivered, 1);
  assert.equal(first.hasMore, true);
  fixture.bridge.drain(executionKey);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["one", "two"]);
});

test("ProgressEventBridge B-05 stops at file capacity without failing the execution", (t) => {
  const accepted = Buffer.concat([eventLine("one", "1"), eventLine("two", "2")]);
  const fixture = createFixture(t, { maxFileBytes: accepted.length + 8 });
  const executionKey = "execution-file-capacity";
  const { eventsFile } = fixture.bridge.register({ executionKey });
  appendFileSync(eventsFile, Buffer.concat([accepted, Buffer.from("x".repeat(32), "utf8")]));

  const result = fixture.bridge.drain(executionKey);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["one", "two"]);
  assert.equal(result.reason, "file_capacity_exceeded");
  assert.doesNotThrow(() => appendFileSync(eventsFile, eventLine("late", "not delivered")));
  assert.equal(fixture.bridge.drain(executionKey).reason, "file_capacity_exceeded");
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["one", "two"]);
  assert.equal(
    fixture.logs.filter((line) => line.includes("reason=file_capacity_exceeded")).length,
    1,
  );
});

test("ProgressEventBridge final drain and cleanup are idempotent", async (t) => {
  const fixture = createFixture(t);
  const executionKey = "execution-finish";
  const registration = fixture.bridge.register({ executionKey });
  appendFileSync(registration.eventsFile, eventLine("final", "最后一条"));

  const first = await fixture.bridge.finish(executionKey);
  const second = await fixture.bridge.finish(executionKey);

  assert.equal(first.finished, true);
  assert.equal(second.finished, true);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["final"]);
  assert.equal(existsSync(registration.stateDir), false);
});

test("ProgressEventBridge removes startup orphans without replaying them", (t) => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "muad-progress-bridge-orphan-"));
  const rootDir = path.join(sandbox, "skill-progress");
  const orphanDir = path.join(rootDir, "a".repeat(43));
  mkdirSync(orphanDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(orphanDir, "events.jsonl"), eventLine("stale", "do not replay"), {
    mode: 0o600,
  });
  const events = [];
  const bridge = new ProgressEventBridge({ rootDir, onEvent: (key, event) => events.push({ key, event }) });
  t.after(() => {
    bridge.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  assert.equal(existsSync(orphanDir), false);
  assert.deepEqual(events, []);
});

test("ProgressEventBridge rejects a second live owner without deleting active files", (t) => {
  const fixture = createFixture(t);
  const executionKey = "execution-root-owner";
  const registration = fixture.bridge.register({ executionKey });

  assert.throws(
    () => new ProgressEventBridge({ rootDir: fixture.rootDir, onEvent: () => {} }),
    (error) => error?.code === "root_in_use",
  );
  assert.equal(existsSync(registration.eventsFile), true);
  appendFileSync(registration.eventsFile, eventLine("still-active", "delivered"));
  fixture.bridge.drain(executionKey);
  assert.deepEqual(fixture.events.map(({ event }) => event.stage), ["still-active"]);
});

function createFixture(t, limits = {}) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "muad-progress-bridge-"));
  const rootDir = path.join(sandbox, "skill-progress");
  const events = [];
  const logs = [];
  const bridge = new ProgressEventBridge({
    rootDir,
    scanIntervalMs: 60_000,
    limits,
    onEvent: (executionKey, event) => events.push({ executionKey, event }),
    log: (message) => logs.push(message),
  });
  t.after(() => {
    bridge.close();
    rmSync(sandbox, { recursive: true, force: true });
  });
  return { bridge, events, logs, rootDir };
}

function eventLine(stage, text) {
  return Buffer.from(`${JSON.stringify({ type: "progress", stage, text })}\n`, "utf8");
}

function fileMode(file) {
  return statSync(file).mode & 0o777;
}

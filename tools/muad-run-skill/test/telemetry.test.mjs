import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSkillExecutionReporter,
  createSkillTelemetryClient,
  progressSummary,
} from "../src/telemetry.mjs";

test("reports Skill execution telemetry with service token auth", async () => {
  const calls = [];
  const reporter = createSkillExecutionReporter({
    consoleInternalURL: "http://console.internal:8080",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
    execution: {
      executionId: "exec-1",
      agentId: "alice",
      skillName: "xdr-query",
      skillScope: "public",
      startedAt: "2026-07-13T00:00:00Z",
    },
    readFileImpl: async () => "token\n",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    },
  });

  assert.equal(await reporter.report({ status: "running" }), true);
  await reporter.flush();
  assert.equal(calls[0].url, "http://console.internal:8080/internal/v1/skill-executions");
  assert.equal(calls[0].options.headers.authorization, "Bearer token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    executionId: "exec-1",
    agentId: "alice",
    skillName: "xdr-query",
    skillScope: "public",
    startedAt: "2026-07-13T00:00:00Z",
    status: "running",
  });
});

test("persists failed telemetry and replays it after Console recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-telemetry-"));
  const tokenFile = path.join(root, "token");
  const outboxPath = path.join(root, "state", "outbox.ndjson");
  await fs.writeFile(tokenFile, "service-token\n");
  let available = false;
  const received = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!available) {
        response.writeHead(503).end("unavailable");
        return;
      }
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const client = createSkillTelemetryClient({
    consoleInternalURL: `http://127.0.0.1:${address.port}`,
    serviceTokenFile: tokenFile,
    outboxPath,
    retryIntervalMs: 60_000,
  });
  t.after(() => client.close());
  const reporter = client.createReporter({ execution: executionFixture() });

  assert.equal(reporter.report({ status: "running", eventSeq: 1 }), true);
  assert.equal(reporter.report({
    status: "succeeded", eventSeq: 2, errorMessage: "token=never-persist-this",
  }), true);
  await client.flush();
  assert.equal(client.snapshot().pending, 2);
  const persisted = await fs.readFile(outboxPath, "utf8");
  assert.equal(persisted.trim().split("\n").length, 2);
  assert.doesNotMatch(persisted, /never-persist-this/u);

  available = true;
  await client.flush();
  assert.deepEqual(received.map((item) => item.eventSeq), [1, 2]);
  assert.equal(client.snapshot().pending, 0);
  await assert.rejects(fs.stat(outboxPath), (error) => error.code === "ENOENT");
});

test("reports a persistent health failure when the outbox cannot be written", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-telemetry-write-fail-"));
  const tokenFile = path.join(root, "token");
  const blockedParent = path.join(root, "not-a-directory");
  await fs.writeFile(tokenFile, "service-token\n");
  await fs.writeFile(blockedParent, "keep-me");
  const logs = [];
  const client = createSkillTelemetryClient({
    consoleInternalURL: "http://console.invalid",
    serviceTokenFile: tokenFile,
    outboxPath: path.join(blockedParent, "outbox.ndjson"),
    fetchImpl: async () => ({ ok: false, status: 503 }),
    logger: { warn() {}, error: (message) => logs.push(message) },
    retryIntervalMs: 60_000,
  });
  t.after(() => client.close());
  client.createReporter({ execution: executionFixture() }).report({ status: "running", eventSeq: 1 });
  await client.flush();

  const health = client.snapshot();
  assert.equal(health.writeFailed, true);
  assert.equal(health.dropped, 1);
  assert.equal(health.lastError, "eexist");
  assert.equal(await fs.readFile(blockedParent, "utf8"), "keep-me");
  assert.match(logs.join("\n"), /skill_telemetry_outbox_write_failed/u);
});

test("spills queue overflow to the outbox instead of dropping the event", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-telemetry-overflow-"));
  const tokenFile = path.join(root, "token");
  const outboxPath = path.join(root, "outbox.ndjson");
  await fs.writeFile(tokenFile, "service-token\n");
  const client = createSkillTelemetryClient({
    consoleInternalURL: "http://console.invalid",
    serviceTokenFile: tokenFile,
    outboxPath,
    maxQueueItems: 1,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    logger: { warn() {}, error() {} },
    retryIntervalMs: 60_000,
  });
  t.after(() => client.close());
  const reporter = client.createReporter({ execution: executionFixture() });

  assert.equal(reporter.report({ status: "running", eventSeq: 1 }), true);
  assert.equal(await reporter.report({ status: "succeeded", eventSeq: 2 }), true);
  await client.flush();

  const persisted = await fs.readFile(outboxPath, "utf8");
  assert.equal(persisted.trim().split("\n").length, 2);
  assert.equal(client.snapshot().dropped, 0);
});

test("telemetry is best-effort and progress is bounded", async () => {
  const reporter = createSkillExecutionReporter({
    consoleInternalURL: "",
    serviceTokenFile: "",
    execution: {},
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });

  assert.equal(await reporter.report({ status: "running" }), false);
  const progress = progressSummary({ type: "progress", stage: "x".repeat(100), text: "y".repeat(400) });
  assert.equal(progress[0].stage.length, 80);
  assert.equal(progress[0].text.length, 256);
});

function executionFixture() {
  return {
    executionId: "exec-replay", agentId: "alice", skillName: "xdr-query",
    skillScope: "public", skillVersion: "1", entryType: "traditional-prompt",
    activationMode: "tool", startedAt: "2026-07-14T00:00:00Z",
  };
}

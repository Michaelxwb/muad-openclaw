import assert from "node:assert/strict";
import test from "node:test";

import { createSkillExecutionReporter, progressSummary } from "../src/telemetry.mjs";

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

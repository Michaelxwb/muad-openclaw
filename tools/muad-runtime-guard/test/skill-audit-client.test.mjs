import assert from "node:assert/strict";
import test from "node:test";

import { POD_SERVICE_TOKEN_FILE } from "../src/binding-client.mjs";
import { SkillAuditClient, SkillAuditClientError } from "../src/skill-audit-client.mjs";

test("skill audit client posts to the fixed contract path and reads the pod token", async () => {
  const calls = [];
  const tokenPaths = [];
  const client = new SkillAuditClient({
    baseURL: "http://console.internal:8080/internal/v1",
    readToken: async (filePath) => { tokenPaths.push(filePath); return " pod-token\n"; },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ code: 0, data: { recorded: true } }), { status: 200 });
    },
  });

  const request = { executionId: "exec-1", agentId: "alice", skillName: "xdr-query", skillScope: "system" };
  await client.report(request);

  assert.deepEqual(tokenPaths, [POD_SERVICE_TOKEN_FILE]);
  assert.equal(calls[0].url, "http://console.internal:8080/internal/v1/skill-executions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer pod-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
});

test("skill audit client treats 401 as non-retryable", async () => {
  const client = new SkillAuditClient({
    baseURL: "http://console.internal:8080",
    readToken: async () => "pod-token",
    fetch: async () => new Response(JSON.stringify({ code: 40101 }), { status: 401 }),
  });
  await assert.rejects(
    () => client.report({ executionId: "e", agentId: "alice", skillName: "x", skillScope: "system" }),
    (error) => error instanceof SkillAuditClientError && error.code === "service_unavailable" &&
      error.retryable === false,
  );
});

test("skill audit client treats 5xx as retryable and network failures as service_unavailable", async () => {
  const client = new SkillAuditClient({
    baseURL: "http://console.internal:8080",
    readToken: async () => "pod-token",
    fetch: async () => new Response("boom", { status: 502 }),
  });
  await assert.rejects(
    () => client.report({ executionId: "e", agentId: "alice", skillName: "x", skillScope: "system" }),
    (error) => error instanceof SkillAuditClientError && error.retryable === true,
  );
  const down = new SkillAuditClient({
    baseURL: "http://console.internal:8080",
    readToken: async () => "pod-token",
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    () => down.report({ executionId: "e", agentId: "alice", skillName: "x", skillScope: "system" }),
    (error) => error instanceof SkillAuditClientError && error.code === "service_unavailable" &&
      error.retryable === true,
  );
});

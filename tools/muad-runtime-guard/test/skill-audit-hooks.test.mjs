import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createSkillAuditHooks } from "../src/skill-audit-hooks.mjs";

const config = {
  valid: true,
  mainAgentId: "main",
  agentProfiles: [{ agentId: "alice", profile: "profile-alice" }],
  skillAuditGrants: [
    { agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query", source: "system" },
  ],
};

test("skill audit hooks report explicit Skill commands with the minimal contract", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  const result = await hooks.beforeDispatch(
    { runId: "run-1", prompt: "/skill:xdr-query now" },
    context("run-1"),
  );
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.deepEqual(Object.keys(client.reports[0]).sort(), [
    "agentId", "executionId", "skillName", "skillScope", "startedAt",
  ]);
  assert.equal(client.reports[0].agentId, "alice");
  assert.equal(client.reports[0].skillName, "xdr-query");
  assert.equal(client.reports[0].skillScope, "system");
  assert.equal(client.reports[0].startedAt, fixedNow.toISOString());
  assert.match(client.reports[0].executionId, /^[0-9a-f-]{36}$/u);
});

test("skill audit hooks report natural-language reads of a granted SKILL.md", async (t) => {
  const root = skillRoot(t);
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: root, source: "system" },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-2", prompt: "帮我查下 xdr" }, context("run-2"));
  const result = await hooks.beforeToolCall(
    { runId: "run-2", toolName: "read", params: { path: join(root, "SKILL.md") } },
    context("run-2"),
  );
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.equal(client.reports[0].skillName, "xdr-query");
  assert.equal(client.reports[0].agentId, "alice");
});

test("skill audit hooks skip non-skill reads, normal chat and ungranted skills", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  // Non-skill tool call (not a read).
  assert.equal(await hooks.beforeToolCall(
    { runId: "run-3", toolName: "exec", params: { command: "id" } }, context("run-3"),
  ), undefined);
  // Plain chat dispatch.
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-3", prompt: "你好" }, context("run-3"),
  ), undefined);
  // Skill the agent is not granted.
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-3", prompt: "/skill:admin-tool" }, context("run-3"),
  ), undefined);
  await flush();
  assert.equal(client.reports.length, 0);
});

test("skill audit hooks report only once per runId and skill", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  await hooks.beforeDispatch({ runId: "run-4", prompt: "/skill:xdr-query now" }, context("run-4"));
  await hooks.beforeDispatch({ runId: "run-4", prompt: "/skill:xdr-query again" }, context("run-4"));
  await flush();

  assert.equal(client.reports.length, 1);
});

test("skill audit hooks are fire-and-forget: client failures never block the turn", async () => {
  const client = {
    reports: [],
    async report(request) {
      this.reports.push(request);
      throw new Error("network down");
    },
  };
  const logs = [];
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow, log: (message) => logs.push(message) });

  const result = await hooks.beforeDispatch({ runId: "run-5", prompt: "/skill:xdr-query now" }, context("run-5"));
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.ok(logs.some((message) => message.includes("report failed")), "failure must be logged, not thrown");
});

test("skill audit hooks skip long-task sessions", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  const longTaskCtx = { ...context("run-6"), sessionKey: "agent:alice:longtask:task-1" };
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-6", prompt: "/skill:xdr-query now" }, longTaskCtx,
  ), undefined);
  await flush();
  assert.equal(client.reports.length, 0);
});

test("skill audit hooks tolerate a missing client entirely", async () => {
  const hooks = createSkillAuditHooks({ config, client: null, now: () => fixedNow });
  const result = await hooks.beforeDispatch({ runId: "run-7", prompt: "/skill:xdr-query now" }, context("run-7"));
  assert.equal(result, undefined);
});

const fixedNow = new Date("2026-08-12T09:30:00.000Z");

function recordingClient() {
  return { reports: [], async report(request) { this.reports.push(request); } };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function context(runId) {
  return {
    agentId: "alice",
    sessionKey: "agent:alice:wecom:direct:user",
    runId,
  };
}

function skillRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-audit-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "# XDR\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

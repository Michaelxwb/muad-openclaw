import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillExecutionHooks,
  SkillExecutionLifecycle,
} from "../src/hook-lifecycle.mjs";
import { createUseSkillTool } from "../src/activation.mjs";
import { normalizeSkillPolicies, resolveSkillGrant } from "../src/skill-policy.mjs";

const CONTEXT = {
  agentId: "alice",
  runId: "run-1",
  sessionKey: "agent:alice:wecom:direct:user-a",
};

test("keeps a tool failure as progress until the agent reports failure", () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const grant = grantFor("xdr-query");
  lifecycle.activate({ context: CONTEXT, grant, activationMode: "tool", inputSummary: "query" });
  const hooks = createSkillExecutionHooks({ lifecycle, policies: policiesFor(grant) });

  hooks.before({ toolName: "browser", params: { token: "do-not-store" }, runId: "run-1" }, CONTEXT);
  hooks.after({
    toolName: "browser",
    params: {},
    runId: "run-1",
    durationMs: 80,
    error: "request failed token=secret-value Authorization: Bearer abc.def",
  }, CONTEXT);
  hooks.agentEnd({ runId: "run-1", success: false, messages: [], error: "later error" }, CONTEXT);

  const updates = reports.get("execution-1");
  assert.deepEqual(updates.map((item) => item.status), [
    "running", "running", "running", "failed",
  ]);
  assert.deepEqual(updates.map((item) => item.eventSeq), [1, 2, 3, 4]);
  assert.equal(updates[2].progress.at(-1).type, "tool-failed");
  assert.doesNotMatch(updates[2].progress.at(-1).text, /secret-value|abc\.def/u);
  assert.match(updates[2].progress.at(-1).text, /\[REDACTED\]/u);
  assert.equal(updates[3].lastToolName, "browser");
  assert.equal(updates[3].terminalReason, "agent_end");
  assert.equal(updates[3].errorCode, "agent_failed");
  assert.equal(updates[3].errorMessage, "later error");
});

test("allows a successful agent result after a recoverable tool failure", () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const grant = grantFor("web-tools-guide");
  lifecycle.activate({ context: CONTEXT, grant, activationMode: "tool" });

  lifecycle.beforeTool({ context: CONTEXT, toolName: "browser", toolCallId: "call-1" });
  lifecycle.afterTool({
    context: CONTEXT,
    toolName: "browser",
    toolCallId: "call-1",
    durationMs: 80,
    error: "browser timed out",
  });
  lifecycle.beforeTool({ context: CONTEXT, toolName: "web_fetch", toolCallId: "call-2" });
  lifecycle.afterTool({
    context: CONTEXT,
    toolName: "web_fetch",
    toolCallId: "call-2",
    durationMs: 20,
  });
  lifecycle.agentEnd({ context: CONTEXT, success: true });

  const updates = reports.get("execution-1");
  assert.equal(updates.at(-1).status, "succeeded");
  assert.equal(updates.at(-1).terminalReason, "agent_end");
  assert.equal(updates.at(-1).lastToolName, "web_fetch");
  assert.deepEqual(
    updates.at(-1).progress.map((item) => item.type),
    ["tool-start", "tool-failed", "tool-start", "tool-complete"],
  );
});

test("closes the prior Skill with handoff on the same run", () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const first = lifecycle.activate({
    context: CONTEXT,
    grant: grantFor("xdr-query"),
    activationMode: "tool",
  });
  const second = lifecycle.activate({
    context: CONTEXT,
    grant: grantFor("sdsp-report"),
    activationMode: "tool",
  });

  assert.notEqual(first.executionId, second.executionId);
  const firstTerminal = reports.get(first.executionId).at(-1);
  assert.equal(firstTerminal.status, "succeeded");
  assert.equal(firstTerminal.terminalReason, "handoff");
  assert.equal(firstTerminal.eventSeq, 2);
  assert.deepEqual(reports.get(second.executionId).map((item) => item.eventSeq), [1]);
});

test("path detection activates an authorized traditional Skill before tool progress", () => {
  const reports = new Map();
  const warnings = [];
  const lifecycle = createLifecycle(reports, {
    warn(message) {
      warnings.push(message);
    },
  });
  const grant = grantFor("web-tools-guide");
  const hooks = createSkillExecutionHooks({ lifecycle, policies: policiesFor(grant) });

  hooks.before({
    toolName: "read",
    params: { path: "/opt/openclaw-skills/web-tools-guide/SKILL.md" },
  }, { agentId: "alice", sessionKey: CONTEXT.sessionKey });

  const updates = reports.get("execution-1");
  assert.equal(updates[0].activationMode, "path-detected");
  assert.equal(updates[1].lastToolName, "read");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing_run_id/u);
});

test("path detection ignores non-instruction files inside a Skill root", () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const grant = grantFor("web-tools-guide");
  const hooks = createSkillExecutionHooks({ lifecycle, policies: policiesFor(grant) });

  hooks.before({
    toolName: "read",
    params: { path: "/opt/openclaw-skills/web-tools-guide/guide.md" },
  }, CONTEXT);

  assert.equal(reports.size, 0);
});

test("expires an abandoned run when agent_end never arrives", () => {
  const reports = new Map();
  let nowMs = 1_721_000_000_000;
  const lifecycle = createLifecycle(reports, undefined, {
    now: () => new Date(nowMs),
    contextTimeoutMs: 1_000,
  });
  lifecycle.activate({
    context: CONTEXT,
    grant: grantFor("web-tools-guide"),
    activationMode: "tool",
  });

  nowMs += 1_001;
  assert.equal(lifecycle.sweepExpired(), 1);

  const updates = reports.get("execution-1");
  assert.deepEqual(updates.map((item) => item.status), ["running", "cancelled"]);
  assert.equal(updates[1].terminalReason, "timeout");
  assert.equal(updates[1].errorCode, "execution_timeout");
  assert.equal(lifecycle.getActive(CONTEXT), null);
});

test("closes active runs when the gateway stops", () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  lifecycle.activate({
    context: CONTEXT,
    grant: grantFor("web-tools-guide"),
    activationMode: "tool",
  });

  lifecycle.close();

  const terminal = reports.get("execution-1").at(-1);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.terminalReason, "gateway_stop");
  assert.equal(lifecycle.getActive(CONTEXT), null);
});

test("correlates a Tool without runId to the Hook run lifecycle", async () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const grant = grantFor("web-tools-guide");
  const policies = policiesFor(grant);
  const hooks = createSkillExecutionHooks({ lifecycle, policies });
  const toolContext = {
    agentId: CONTEXT.agentId,
    sessionKey: CONTEXT.sessionKey,
    workspaceDir: "/home/node/.openclaw/workspace-alice",
  };
  const tool = createUseSkillTool({
    lifecycle,
    policies,
    toolContext,
    readFileImpl: async () => "# Web Tools\nUse browser carefully.",
  });

  hooks.before({
    toolName: "muad_use_skill", toolCallId: "call-activate", runId: CONTEXT.runId, params: {},
  }, CONTEXT);
  await tool.execute("call-activate", { skill_name: grant.name });
  hooks.after({
    toolName: "muad_use_skill", toolCallId: "call-activate", runId: CONTEXT.runId, params: {},
  }, CONTEXT);
  hooks.before({ toolName: "browser", runId: CONTEXT.runId, params: {} }, CONTEXT);
  hooks.after({ toolName: "browser", runId: CONTEXT.runId, params: {} }, CONTEXT);
  hooks.agentEnd({ runId: CONTEXT.runId, success: true, messages: [] }, CONTEXT);

  assert.equal(reports.size, 1);
  const updates = reports.get("execution-1");
  assert.deepEqual(updates.map((item) => item.status), [
    "running", "running", "running", "succeeded",
  ]);
  assert.equal(updates.at(-1).terminalReason, "agent_end");
});

test("promotes a conversation-only Tool activation when agent_end supplies runId", async () => {
  const reports = new Map();
  const lifecycle = createLifecycle(reports);
  const grant = grantFor("web-tools-guide");
  const policies = policiesFor(grant);
  const hooks = createSkillExecutionHooks({ lifecycle, policies });
  const tool = createUseSkillTool({
    lifecycle,
    policies,
    toolContext: {
      agentId: CONTEXT.agentId,
      sessionKey: CONTEXT.sessionKey,
      workspaceDir: "/home/node/.openclaw/workspace-alice",
    },
    readFileImpl: async () => "# Web Tools\nUse browser carefully.",
  });

  await tool.execute("call-without-hook-correlation", { skill_name: grant.name });
  hooks.agentEnd({ runId: CONTEXT.runId, success: true, messages: [] }, CONTEXT);

  const updates = reports.get("execution-1");
  assert.deepEqual(updates.map((item) => item.status), ["running", "succeeded"]);
  assert.equal(updates.at(-1).terminalReason, "agent_end");
});

function createLifecycle(reports, logger = { warn() {}, error() {} }, options = {}) {
  let id = 0;
  let tick = 0;
  return new SkillExecutionLifecycle({
    logger,
    randomUUID: () => `execution-${++id}`,
    now: options.now ?? (() => new Date(1_721_000_000_000 + tick++ * 100)),
    contextTimeoutMs: options.contextTimeoutMs,
    reporterFactory: ({ execution }) => ({
      report(update) {
        const values = reports.get(execution.executionId) ?? [];
        values.push({ ...execution, ...update });
        reports.set(execution.executionId, values);
        return Promise.resolve(true);
      },
    }),
  });
}

function grantFor(name) {
  return {
    name,
    source: "public",
    skillId: `skill-${name}`,
    version: "sha256:test",
    entryType: "traditional-prompt",
    rootPath: `/opt/openclaw-skills/${name}`,
    scriptFiles: [],
  };
}

function policiesFor(grant) {
  const policies = normalizeSkillPolicies([{ agentId: "alice", allowed: [grant] }]);
  assert.deepEqual(resolveSkillGrant(policies, "alice", grant.name), grant);
  return policies;
}

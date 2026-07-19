import assert from "node:assert/strict";
import test from "node:test";

import { createSkillAgentEventSubscription } from "../src/agent-event-lifecycle.mjs";
import { createUseSkillTool } from "../src/activation.mjs";
import { SkillExecutionLifecycle } from "../src/hook-lifecycle.mjs";
import { normalizeSkillPolicies } from "../src/skill-policy.mjs";

const SESSION_KEY = "agent:alice:wecom:direct:user-a";
const GRANT = {
  name: "web-tools-guide",
  source: "public",
  skillId: "skill-web-tools-guide",
  version: "sha256:test",
  entryType: "traditional-prompt",
  rootPath: "/opt/openclaw-skills/web-tools-guide",
  scriptFiles: [],
};

test("agent events correlate Tool activation and persist a successful terminal record", async () => {
  const reports = [];
  let flushCount = 0;
  const sharedState = { active: new Map(), toolContexts: new Map() };
  const eventLifecycle = createLifecycle(reports, sharedState);
  const toolLifecycle = createLifecycle(reports, sharedState);
  const policies = normalizeSkillPolicies([{ agentId: "alice", allowed: [GRANT] }]);
  const subscription = createSkillAgentEventSubscription({
    lifecycle: eventLifecycle,
    flush: async () => { flushCount += 1; },
  });
  const tool = createUseSkillTool({
    lifecycle: toolLifecycle,
    policies,
    toolContext: {
      agentId: "alice",
      sessionKey: SESSION_KEY,
      workspaceDir: "/home/node/.openclaw/workspace-alice",
    },
    readFileImpl: async () => "# Web Tools\nUse browser carefully.",
  });

  subscription.handle(agentEvent("tool", {
    phase: "start", name: "muad_use_skill", toolCallId: "call-1",
  }));
  await tool.execute("call-1", { skill_name: GRANT.name });
  subscription.handle(agentEvent("tool", {
    phase: "result", name: "muad_use_skill", toolCallId: "call-1", durationMs: 10,
  }));
  subscription.handle(agentEvent("tool", {
    phase: "start", name: "browser", toolCallId: "call-2",
  }));
  subscription.handle(agentEvent("tool", {
    phase: "result", name: "browser", toolCallId: "call-2", durationMs: 25,
  }));
  await subscription.handle(agentEvent("lifecycle", { phase: "end" }));

  assert.deepEqual(reports.map((item) => item.status), [
    "running", "running", "running", "succeeded",
  ]);
  assert.equal(reports.at(-1).terminalReason, "agent_end");
  assert.equal(reports.at(-1).lastToolName, "browser");
  assert.equal(reports.at(-1).eventSeq, 4);
  assert.equal(flushCount, 1);
});

test("agent lifecycle errors close the active Skill as failed", async () => {
  const reports = [];
  const lifecycle = createLifecycle(reports);
  lifecycle.activate({
    context: { agentId: "alice", runId: "run-1", sessionKey: SESSION_KEY },
    grant: GRANT,
    activationMode: "tool",
  });
  const subscription = createSkillAgentEventSubscription({ lifecycle });

  await subscription.handle(agentEvent("lifecycle", { phase: "error", error: "provider failed" }));

  assert.deepEqual(reports.map((item) => item.status), ["running", "failed"]);
  assert.equal(reports.at(-1).errorMessage, "provider failed");
});

test("agent lifecycle success wins after an intermediate Tool error", async () => {
  const reports = [];
  const lifecycle = createLifecycle(reports);
  lifecycle.activate({
    context: { agentId: "alice", runId: "run-1", sessionKey: SESSION_KEY },
    grant: GRANT,
    activationMode: "tool",
  });
  const subscription = createSkillAgentEventSubscription({ lifecycle });

  subscription.handle(agentEvent("tool", {
    phase: "start", name: "browser", toolCallId: "call-1",
  }));
  subscription.handle(agentEvent("tool", {
    phase: "result", name: "browser", toolCallId: "call-1", isError: true,
    toolErrorSummary: "browser timed out",
  }));
  await subscription.handle(agentEvent("lifecycle", { phase: "end" }));

  assert.deepEqual(reports.map((item) => item.status), [
    "running", "running", "running", "succeeded",
  ]);
  assert.equal(reports.at(-1).terminalReason, "agent_end");
  assert.equal(reports.at(-1).progress.at(-1).type, "tool-failed");
});

function createLifecycle(reports, sharedState) {
  return new SkillExecutionLifecycle({
    sharedState,
    logger: { info() {}, warn() {}, error() {} },
    randomUUID: () => "execution-1",
    now: () => new Date("2026-07-15T00:00:00.000Z"),
    reporterFactory: ({ execution }) => ({
      report(update) {
        reports.push({ ...execution, ...update });
        return Promise.resolve(true);
      },
    }),
  });
}

function agentEvent(stream, data) {
  return {
    runId: "run-1",
    seq: 1,
    stream,
    ts: Date.now(),
    data,
  };
}

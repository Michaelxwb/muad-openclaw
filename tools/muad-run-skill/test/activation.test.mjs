import assert from "node:assert/strict";
import test from "node:test";

import {
  registerSkillActivationPromptHook,
  registerUseSkillTool,
  SkillActivationError,
} from "../src/activation.mjs";
import { SkillExecutionLifecycle } from "../src/hook-lifecycle.mjs";
import { normalizeSkillPolicies } from "../src/skill-policy.mjs";

const TOOL_CONTEXT = {
  agentId: "alice",
  runId: "run-1",
  sessionKey: "agent:alice:wecom:direct:user-a",
  workspaceDir: "/home/node/.openclaw/workspace-alice",
};

test("injects a per-turn Skill activation protocol for agents with grants", () => {
  let registered;
  const policies = normalizeSkillPolicies([{
    agentId: "alice",
    allowed: [{
      name: "web-tools-guide",
      source: "public",
      skillId: "skill-web",
      version: "sha256:abc",
      entryType: "traditional-prompt",
      rootPath: "/opt/openclaw-skills/web-tools-guide",
      scriptFiles: [],
    }],
  }]);
  registerSkillActivationPromptHook({
    on(name, handler, options) {
      registered = { name, handler, options };
    },
  }, policies);

  assert.equal(registered.name, "before_prompt_build");
  assert.equal(registered.options.priority, 500);
  assert.equal(registered.handler({}, { agentId: "main" }), undefined);
  const result = registered.handler({}, { agentId: "alice" });
  assert.match(result.appendSystemContext, /every user turn/iu);
  assert.match(result.appendSystemContext, /retry|follow-up/iu);
  assert.match(result.appendSystemContext, /read the exact .*SKILL\.md/iu);
  assert.match(result.appendSystemContext, /muad_use_skill/u);
});

test("rejects unauthorized activation without exposing Skill content", async () => {
  const reports = [];
  const lifecycle = createLifecycle(reports);
  let registered;
  let reads = 0;
  const api = {
    registerTool(factory, options) {
      registered = { factory, options };
    },
  };
  registerUseSkillTool(api, {
    lifecycle,
    policies: normalizeSkillPolicies([]),
    readFileImpl: async () => {
      reads += 1;
      return "must not be exposed";
    },
    formatResult: (value) => value,
  });

  assert.equal(registered.options.name, "muad_use_skill");
  const tool = registered.factory(TOOL_CONTEXT);
  await assert.rejects(
    tool.execute("call-1", { skill_name: "private-report", input_summary: "run report" }),
    (error) => error instanceof SkillActivationError && error.code === "skill_not_authorized",
  );

  assert.equal(reads, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, "rejected");
  assert.equal(reports[0].errorCode, "skill_not_authorized");
  assert.equal(reports[0].terminalReason, "rejected");
  assert.doesNotMatch(JSON.stringify(reports), /must not be exposed/u);
});

test("returns authorized traditional Skill instructions and starts one execution", async () => {
  const reports = [];
  const lifecycle = createLifecycle(reports);
  let registered;
  const policies = normalizeSkillPolicies([{
    agentId: "alice",
    allowed: [{
      name: "web-tools-guide",
      source: "public",
      skillId: "skill-web",
      version: "sha256:abc",
      entryType: "traditional-prompt",
      rootPath: "/opt/openclaw-skills/web-tools-guide",
      scriptFiles: [],
    }],
  }]);
  registerUseSkillTool({
    registerTool(factory, options) {
      registered = { factory, options };
    },
  }, {
    lifecycle,
    policies,
    readFileImpl: async (file) => {
      assert.equal(file, "/opt/openclaw-skills/web-tools-guide/SKILL.md");
      return "# Web Tools\nUse browser carefully.";
    },
    formatResult: (value) => value,
  });

  const result = await registered.factory(TOOL_CONTEXT).execute(
    "call-1",
    { skill_name: "web-tools-guide", input_summary: "fetch pull requests" },
  );
  assert.equal(result.skillName, "web-tools-guide");
  assert.equal(result.entryType, "traditional-prompt");
  assert.match(result.instructions, /Use browser carefully/u);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, "running");
  assert.equal(reports[0].activationMode, "tool");
  assert.equal(reports[0].eventSeq, 1);
});

function createLifecycle(reports) {
  return new SkillExecutionLifecycle({
    randomUUID: () => `execution-${reports.length + 1}`,
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    reporterFactory: ({ execution }) => ({
      report(update) {
        reports.push({ ...execution, ...update });
        return Promise.resolve(true);
      },
    }),
  });
}

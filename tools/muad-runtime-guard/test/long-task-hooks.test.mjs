import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLongTaskHooks } from "../src/long-task-hooks.mjs";

test("long task hooks submit explicit Skill commands before dispatch", async () => {
  const { hooks, submissions } = setupHooks();

  const result = await hooks.beforeDispatch({
    prompt: "/skill:xdr-query check alerts",
    channelId: "openclaw-weixin",
    senderId: "openclaw-weixin:wx-1",
  }, context());

  assert.equal(result.handled, true);
  assert.equal(result.reason, "muad-long-task-submitted");
  assert.match(result.text, /任务已提交：xdr-query/u);
  assert.match(result.text, /当前排队：0 ｜ 执行中：1/u);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].objective, "check alerts");
  assert.equal(submissions[0].peerId, "wx-1");
  assert.equal(submissions[0].replyChannel, "openclaw-weixin");
});

test("long task hooks rewrite natural Skill reads and submit marker replies", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "Please use xdr-query for alert triage",
    channelId: "openclaw-weixin",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));

  const rewritten = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));

  assert.equal(rewritten.params.path, join(realpathSync(skillDir), "_longtask_submit.md"));
  assert.equal(
    await hooks.beforeToolCall({ runId: "run-1", toolName: "exec", params: {} }, context({ runId: "run-1" })),
    undefined,
  );

  const submitted = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "MUAD_TASK|xdr-query|triage alert batch\nignored detail",
    channel: "openclaw-weixin",
    sessionKey: "agent:alice:openclaw-weixin:direct:wx-1",
    runId: "run-1",
  }, context({ runId: "run-1", senderId: "wx-1" }));

  assert.equal(submitted.action, "revise");
  assert.match(submitted.reason, /任务已提交：xdr-query/u);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].objective, "triage alert batch");
  assert.equal(submissions[0].originalPrompt, "Please use xdr-query for alert triage");
  assert.equal(submissions[0].replyChannel, "openclaw-weixin");
  assert.equal(submissions[0].peerId, "wx-1");
});

test("long task hooks pass through non-marker replies and skip task sessions", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({ runId: "run-1", prompt: "use xdr-query", senderId: "wx-1" }, context({ runId: "run-1" }));
  await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));

  const plain = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "I will do it now.",
    channel: "wecom",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    runId: "run-1",
  }, context({ runId: "run-1", senderId: "wx-1" }));
  assert.equal(plain, undefined);
  assert.equal(submissions.length, 0);

  const skipped = await hooks.beforeDispatch(
    { prompt: "/skill:xdr-query check alerts" },
    context({ sessionKey: "agent:alice:longtask:task-1" }),
  );
  assert.equal(skipped, undefined);

  const skippedReply = await hooks.beforeAgentFinalize(
    { lastAssistantMessage: "MUAD_TASK|xdr-query|nested task", channel: "wecom", sessionKey: "agent:alice:longtask:task-1" },
    context({ sessionKey: "agent:alice:longtask:task-1" }),
  );
  assert.equal(skippedReply, undefined);
  assert.equal(submissions.length, 0);
});

test("long task hooks submit from context without pending read, replace unknown markers, and clean up on agent end", async () => {
  const { hooks, submissions } = setupHooks();
  const submitted = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "MUAD_TASK|xdr-query|direct marker\nignored",
    channel: "openclaw-weixin",
    sessionKey: "agent:alice:openclaw-weixin:direct:wx-1",
    runId: "run-direct",
  }, context({ runId: "run-direct", senderId: "openclaw-weixin:wx-1", channel: "openclaw-weixin" }));
  assert.equal(submitted.action, "revise");
  assert.match(submitted.reason, /任务已提交：xdr-query/u);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].objective, "direct marker");
  assert.equal(submissions[0].originalPrompt, "direct marker");
  assert.equal(submissions[0].peerId, "wx-1");
  assert.equal(submissions[0].replyChannel, "openclaw-weixin");

  await hooks.agentEnd({ runId: "run-ended" }, context({ runId: "run-ended" }));

  const unknown = await hooks.beforeAgentFinalize(
    { lastAssistantMessage: "MUAD_TASK|no-such-skill|task", channel: "wecom", sessionKey: "agent:alice:wecom:direct:wx-1" },
    context({ sessionKey: "agent:alice:wecom:direct:wx-1", senderId: "wx-1" }),
  );
  assert.equal(unknown.action, "revise");
  assert.match(unknown.reason, /未识别的长任务 Skill/u);
  assert.equal(submissions.length, 1);
});

function setupHooks(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-hook-"));
  const skillDir = join(root, "xdr-query");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# XDR\n");
  writeFileSync(join(skillDir, "muad.skill.json"), JSON.stringify({ name: "xdr-query", longTask: true }));
  const submissions = [];
  const manager = {
    submit(input) {
      submissions.push(input);
      return {
        task: { status: submissions.length === 1 ? "running" : "queued" },
        queuedAhead: Math.max(0, submissions.length - 1),
        queued: Math.max(0, submissions.length - 1),
        active: 1,
        limit: 2,
      };
    },
  };
  const hooks = createLongTaskHooks({
    config: {
      longTaskSkillGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: skillDir },
      ],
    },
    manager,
    ...overrides,
  });
  return { hooks, skillDir, submissions };
}

function context(overrides = {}) {
  return {
    runId: "run-0",
    agentId: "alice",
    sessionKey: "agent:alice:wx-1",
    channel: "wecom",
    ...overrides,
  };
}

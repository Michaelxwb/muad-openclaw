import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillAuditHooks } from "../src/skill-audit-hooks.mjs";
import { createSkillProgressHooks } from "../src/skill-progress-hooks.mjs";
import { SkillProgressManager } from "../src/skill-progress-manager.mjs";

test("SkillProgressHooks E-04 activates only an authorized explicit direct Skill run", async () => {
  const fixture = createFixture();
  const progress = createSkillProgressHooks({ manager: fixture.manager, autoStart: false });
  const audit = createSkillAuditHooks({
    config: auditConfig(), client: null, onSkillActivated: progress.activate,
  });
  const ctx = context();

  await audit.beforeDispatch({ runId: "run-1", prompt: "/skill:xdr-query now" }, ctx);
  const env = await progress.resolveExecEnv({ toolName: "exec", runId: "run-1" }, ctx);
  assert.match(env.MUAD_PROGRESS_EVENTS_FILE, /events\.jsonl$/u);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.equal((await progress.resolveExecEnv(
    { toolName: "exec", runId: "run-2" }, { ...ctx, runId: "run-2" },
  )), undefined);
  assert.equal((await progress.resolveExecEnv(
    { toolName: "read", runId: "run-1" }, ctx,
  )), undefined);

  await progress.agentEnd({ runId: "run-1" }, ctx);
  assert.equal((await progress.resolveExecEnv({ toolName: "exec", runId: "run-1" }, ctx)), undefined);
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks resolves the OpenClaw 2026.7.1 exec event shape without runId", async () => {
  const fixture = createFixture();
  const progress = createSkillProgressHooks({ manager: fixture.manager, autoStart: false });
  const ctx = context({ runId: undefined });
  progress.activate({ ...context({ runId: "run-real" }), skillName: "xdr-query" });

  const env = await progress.resolveExecEnv(
    { toolName: "exec", sessionKey: ctx.sessionKey, host: "gateway" },
    { agentId: ctx.agentId, sessionKey: ctx.sessionKey },
  );

  assert.match(env.MUAD_PROGRESS_EVENTS_FILE, /events\.jsonl$/u);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks fails closed when a run-less exec matches multiple foreground executions", async () => {
  const fixture = createFixture();
  const progress = createSkillProgressHooks({ manager: fixture.manager, autoStart: false });
  const shared = context();
  progress.activate({ ...shared, runId: "run-a", skillName: "xdr-query" });
  progress.activate({ ...shared, runId: "run-b", skillName: "xdr-query" });

  const env = await progress.resolveExecEnv(
    { toolName: "exec", sessionKey: shared.sessionKey },
    { agentId: shared.agentId, sessionKey: shared.sessionKey },
  );

  assert.equal(env, undefined);
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks E-04 reuses the audit grant resolver for natural SKILL.md reads", async (t) => {
  const skillRoot = mkdtempSync(path.join(tmpdir(), "muad-progress-natural-skill-"));
  writeFileSync(path.join(skillRoot, "SKILL.md"), "# Skill\n");
  t.after(() => rmSync(skillRoot, { recursive: true, force: true }));
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const progress = createSkillProgressHooks({ manager: fixture.manager, autoStart: false });
  t.after(() => progress.close());
  const audit = createSkillAuditHooks({
    config: auditConfig([{ agentId: "alice", name: "xdr-query", rootPath: skillRoot, source: "system" }]),
    client: null,
    onSkillActivated: progress.activate,
  });
  const ctx = context({ runId: "run-natural" });

  await audit.beforeAgentRun({ runId: "run-natural", prompt: "查一下" }, ctx);
  await audit.beforeToolCall({
    runId: "run-natural", toolName: "read", params: { path: path.join(skillRoot, "SKILL.md") },
  }, ctx);

  const env = await progress.resolveExecEnv({ toolName: "exec", runId: "run-natural" }, ctx);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
});

test("SkillProgressHooks E-04 rejects group, forged identity, and unactivated contexts", async () => {
  const fixture = createFixture();
  const progress = createSkillProgressHooks({ manager: fixture.manager, autoStart: false });
  const audit = createSkillAuditHooks({
    config: auditConfig(), client: null, onSkillActivated: progress.activate,
  });
  const direct = context();

  assert.equal(await progress.resolveExecEnv({ toolName: "exec", runId: "missing" }, direct), undefined);
  await audit.beforeDispatch(
    { runId: "group-run", prompt: "/skill:xdr-query" },
    context({ runId: "group-run", sessionKey: "agent:alice:mattermost:channel:group-1" }),
  );
  assert.equal(await progress.resolveExecEnv(
    { toolName: "exec", runId: "group-run" },
    context({ runId: "group-run", sessionKey: "agent:alice:mattermost:channel:group-1" }),
  ), undefined);

  await audit.beforeDispatch({ runId: "run-1", prompt: "/skill:xdr-query" }, direct);
  assert.equal(await progress.resolveExecEnv(
    { toolName: "exec", runId: "run-1" }, context({ agentId: "bob" }),
  ), undefined);
  assert.equal(await progress.resolveExecEnv(
    { toolName: "exec", runId: "run-1", sessionKey: "agent:alice:wecom:direct:other" }, direct,
  ), undefined);
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks promotes a run-less dispatch activation when the agent run starts", async () => {
  const fixture = createFixture();
  const logs = [];
  const progress = createSkillProgressHooks({
    manager: fixture.manager, autoStart: false, log: (message) => logs.push(message),
  });
  const audit = createSkillAuditHooks({
    config: auditConfig(), client: null, onSkillActivated: progress.activate,
  });
  const ctx = context({ runId: undefined });

  // dispatch 发生在 run 创建之前（无 runId）：激活进入 pending 而非静默丢弃
  await audit.beforeDispatch({ prompt: "/skill:xdr-query now", senderId: "user-9" }, ctx);
  assert.equal(logs.some((line) => line.includes("action=pending outcome=accepted")), true);

  // before_agent_run 携带 runId/senderId 后补注册
  await progress.beforeAgentRun({ runId: "run-9", senderId: "user-9" }, ctx);
  assert.equal(logs.some((line) => line.includes("reason=promoted_from_pending")), true);

  const env = await progress.resolveExecEnv({ toolName: "exec" }, { ...ctx, runId: "run-9" });
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.match(env.MUAD_PROGRESS_EVENTS_FILE, /events\.jsonl$/u);

  await progress.agentEnd({ runId: "run-9" }, ctx);
  assert.equal(await progress.resolveExecEnv({ toolName: "exec" }, { ...ctx, runId: "run-9" }), undefined);
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks rejects non-direct sessions and conflicting skills for pending activations", async () => {
  const fixture = createFixture();
  const logs = [];
  const progress = createSkillProgressHooks({
    manager: fixture.manager, autoStart: false, log: (message) => logs.push(message),
  });
  const audit = createSkillAuditHooks({
    config: auditConfig(), client: null, onSkillActivated: progress.activate,
  });

  // 非直连会话不进入 pending
  await audit.beforeDispatch(
    { prompt: "/skill:xdr-query now" },
    context({ runId: undefined, sessionKey: "agent:alice:mattermost:channel:group-1" }),
  );
  assert.equal(logs.some((line) => line.includes("action=pending outcome=rejected reason=identity_invalid")), true);

  // 同一会话不同 skill 的 pending 冲突被拒绝
  await audit.beforeDispatch(
    { prompt: "/skill:xdr-query now", senderId: "user-9" },
    context({ runId: undefined }),
  );
  progress.activate({ ...context({ runId: undefined }), skillName: "other-skill", senderId: "user-9" });
  assert.equal(logs.some((line) => line.includes("action=pending outcome=rejected reason=skill_conflict")), true);

  await progress.beforeAgentRun({ runId: "run-9", senderId: "user-9" }, context({ runId: undefined }));
  const env = await progress.resolveExecEnv({ toolName: "exec" }, context({ runId: "run-9" }));
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  progress.close();
  fixture.cleanup();
});

test("SkillProgressHooks expires abandoned foreground runs through the shared TTL sweep", async () => {
  let current = 1_000;
  const finished = [];
  const manager = {
    registerForeground: () => ({
      registered: true,
      executionKey: "opaque-execution",
      env: { MUAD_PROGRESS_EVENTS_FILE: "/tmp/opaque/events.jsonl", MUAD_SKILL_NAME: "xdr-query" },
    }),
    async finish(executionKey) { finished.push(executionKey); },
  };
  const progress = createSkillProgressHooks({
    manager, now: () => current, ttlMs: 10, autoStart: false,
  });
  progress.activate({ ...context(), skillName: "xdr-query" });

  current += 11;
  progress.sweep();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(finished, ["opaque-execution"]);
  assert.equal(await progress.resolveExecEnv({ toolName: "exec", runId: "run-1" }, context()), undefined);
  progress.close();
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-hooks-"));
  const manager = new SkillProgressManager({
    rootDir: path.join(root, "events"), notify: async () => ({ ok: true }),
  });
  return { manager, cleanup: () => {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

function auditConfig(grants) {
  return {
    locale: "zh",
    agentProfiles: [{ agentId: "alice" }],
    skillAuditGrants: grants ?? [
      { agentId: "alice", name: "xdr-query", rootPath: "/skills/xdr-query", source: "system" },
    ],
  };
}

function context(overrides = {}) {
  return {
    runId: "run-1", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:user-1",
    ...overrides,
  };
}

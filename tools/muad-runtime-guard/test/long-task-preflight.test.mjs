import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillPreflightContext } from "../src/skill-preflight-context.mjs";
import { createLongTaskPreflight } from "../src/long-task-preflight.mjs";

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "muad-preflight-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "SKILL.md"), "--customer-id required\n");
  writeFileSync(path.join(root, "muad.skill.json"), JSON.stringify({ name: "report", longTask: true }));
  const turn = { agentId: "alice", runId: "run-1", sessionKey: "agent:alice:wecom:direct:a", peerId: "a", replyChannel: "wecom", originalPrompt: "生成客户报告" };
  const grant = { agentId: "alice", name: "report", rootPath: root };
  const config = { valid: true, mainAgentId: "main", agentProfiles: [{ agentId: "alice" }], longTaskSkillGrants: [grant] };
  const ledger = new SkillPreflightContext();
  ledger.recordRead({ ...turn, skillName: "report", rootPath: root });
  const checker = createLongTaskPreflight({ ledger, getConfig: () => config });
  const input = { skillName: "report", objective: "报告", selectionBasis: "unique_match", requiredNames: ["customerId"], bindings: [{ name: "customerId", value: "123", source: "user_message" }] };
  return { checker, turn, grant, config, input, ledger };
}

test("PreflightE05 derives authorized root and delivery only from trusted context", (t) => {
  const { checker, turn, input, grant } = setup(t);
  const result = checker.check(input, turn);
  assert.equal(result.ok, true);
  assert.equal(result.grant.rootPath, grant.rootPath);
  assert.equal(result.turn.peerId, "a");
  for (const field of ["agentId", "peerId", "sessionKey", "rootPath", "replyChannel"]) {
    assert.equal(checker.check({ ...input, [field]: "other" }, turn).reason, "invalid_input");
  }
});

test("PreflightE05 rejects cross-agent sessions, main, background and missing identity", (t) => {
  const { checker, turn, input } = setup(t);
  for (const context of [{}, { ...turn, agentId: "bob" }, { ...turn, agentId: "main" },
    { ...turn, sessionKey: "agent:bob:wecom:direct:a" },
    { ...turn, sessionKey: "agent:alice:longtask:task-1" },
    { ...turn, peerId: "other" }, { ...turn, runId: "" }]) {
    assert.equal(checker.check(input, context).reason, "context_unavailable");
  }
});

test("PreflightE05 rechecks authorization and the disk manifest after reading", (t) => {
  const { checker, turn, input, config, grant } = setup(t);
  config.longTaskSkillGrants = [];
  assert.equal(checker.check(input, turn).reason, "skill_not_authorized");
  config.longTaskSkillGrants = [grant];
  assert.equal(checker.check({ ...input, skillName: "../report" }, turn).reason, "invalid_input");
  writeFileSync(path.join(grant.rootPath, "muad.skill.json"), JSON.stringify({ name: "other", longTask: true }));
  assert.equal(checker.check(input, turn).reason, "skill_not_authorized");
  writeFileSync(path.join(grant.rootPath, "muad.skill.json"), JSON.stringify({ name: "report", longTask: false }));
  assert.equal(checker.check(input, turn).reason, "skill_not_authorized");
});

test('PreflightS15 actual turn sender overrides a session alias while untrusted peer and identities cannot', async t => {
  const f = setup(t);
  const { createLongTaskHooks } = await import('../src/long-task-hooks.mjs');
  const hooks = createLongTaskHooks({ ledger: f.ledger, getConfig: () => f.config });
  const checker = createLongTaskPreflight({ ledger: f.ledger, getConfig: () => f.config, getTurnContext: hooks.getTurnContext });
  const ctx = { agentId: 'alice', sessionKey: 'agent:alice:wecom:direct:alice', runId: 'shared-run' };
  await hooks.beforeAgentRun({ prompt: '生成报告', senderId: 'wecom:actual-user' }, ctx);
  await hooks.afterToolCall({ toolName: 'read', params: { path: path.join(f.grant.rootPath, 'SKILL.md') }, result: { isError: false } }, ctx);
  const result = checker.check(f.input, { agentId: 'alice', sessionKey: ctx.sessionKey });
  assert.equal(result.ok, true); assert.equal(result.turn.peerId, 'actual-user');
  assert.equal(checker.check({ ...f.input, verifiedPeerId: 'other' }, ctx).reason, 'invalid_input');
  assert.equal(checker.check(f.input, { ...ctx, agentId: 'bob' }).reason, 'context_unavailable');
  assert.equal(checker.check(f.input, { ...ctx, sessionKey: 'agent:alice:wecom:direct:other' }).reason, 'context_unavailable');
  assert.equal(f.checker.check(f.input, { ...f.turn, peerId: 'other' }).reason, 'context_unavailable');
});

test('PreflightS15 same run IDs across agents preserve isolated turns and cleanup', async t => {
  const f = setup(t);
  const { createLongTaskHooks } = await import('../src/long-task-hooks.mjs');
  const hooks = createLongTaskHooks({ ledger: f.ledger, getConfig: () => f.config });
  const alice = { agentId: 'alice', sessionKey: 'session:agent:alice:wecom:direct:alice', runId: 'shared-run' };
  const bob = { agentId: 'bob', sessionKey: 'agent:bob:wecom:direct:bob', runId: 'shared-run' };
  await hooks.beforeAgentRun({ senderId: 'wecom:user-a' }, alice);
  await hooks.beforeAgentRun({ senderId: 'wecom:user-b' }, bob);
  assert.equal(hooks.getTurnContext(alice).peerId, 'user-a');
  assert.equal(hooks.getTurnContext(alice).sessionKey, 'agent:alice:wecom:direct:alice');
  assert.equal(hooks.getTurnContext(bob).peerId, 'user-b');
  await hooks.agentEnd({}, alice);
  assert.equal(hooks.getTurnContext(alice), null);
  assert.equal(hooks.getTurnContext(bob).peerId, 'user-b');
});

test('PreflightS21 Mattermost user delivery prefix matches the same trusted session only', async t => {
  const f = setup(t);
  const { createLongTaskHooks } = await import('../src/long-task-hooks.mjs');
  const hooks = createLongTaskHooks({ ledger: f.ledger, getConfig: () => f.config });
  const checker = createLongTaskPreflight({ ledger: f.ledger, getConfig: () => f.config, getTurnContext: hooks.getTurnContext });
  const ctx = { agentId: 'alice', sessionKey: 'agent:alice:mattermost:direct:a', runId: 'cli-run' };
  await hooks.beforeAgentRun({ prompt: '生成报告' }, ctx);
  await hooks.afterToolCall({ toolName: 'read', params: { path: path.join(f.grant.rootPath, 'SKILL.md') }, result: { isError: false } }, ctx);
  const result = checker.check(f.input, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.turn.peerId, 'user:a');
  assert.equal(checker.check(f.input, { ...ctx, sessionKey: 'agent:alice:mattermost:direct:b' }).reason, 'context_unavailable');
  const direct = createLongTaskPreflight({ ledger: f.ledger, getConfig: () => f.config });
  assert.equal(direct.check(f.input, { ...hooks.getTurnContext(ctx), peerId: 'user:b' }).reason, 'context_unavailable');
  assert.equal(direct.check(f.input, { ...f.turn, peerId: 'user:a' }).reason, 'context_unavailable');
});

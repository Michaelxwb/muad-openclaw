import assert from "node:assert/strict";
import test from "node:test";

import { createSkillOutputHooks } from "../src/skill-output-hooks.mjs";

test("resolve_exec_env injects SKILL_OUTPUT_DIR for a long task session from the manager's peerId", async () => {
  const { hooks, mkdirs } = setupHooks({ manager: { resolvePeerForTaskId: (id) => id === "task-9" ? "user:wx-9" : "" } });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:longtask:task-9" },
    context(),
  );

  assert.deepEqual(env, { SKILL_OUTPUT_DIR: "/state/skill-outputs/alice/wx-9" });
  assert.deepEqual(mkdirs, [{ dir: "/state/skill-outputs/alice/wx-9", opts: { recursive: true, mode: 0o700 } }]);
});

test("resolve_exec_env injects SKILL_OUTPUT_DIR for a normal business session from the session key", async () => {
  const { hooks, mkdirs } = setupHooks();

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:wecom:direct:wx-1" },
    context(),
  );

  assert.deepEqual(env, { SKILL_OUTPUT_DIR: "/state/skill-outputs/alice/wx-1" });
  assert.deepEqual(mkdirs, [{ dir: "/state/skill-outputs/alice/wx-1", opts: { recursive: true, mode: 0o700 } }]);
});

test("resolve_exec_env injects SKILL_OUTPUT_DIR for the main session", async () => {
  const { hooks } = setupHooks();

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:main:main" },
    context(),
  );

  assert.deepEqual(env, { SKILL_OUTPUT_DIR: "/state/skill-outputs/main/main" });
});

test("resolve_exec_env skips non-exec tools", async () => {
  const { hooks } = setupHooks();

  const env = await hooks.resolveExecEnv(
    { toolName: "bash", sessionKey: "agent:alice:wecom:direct:wx-1" },
    context(),
  );

  assert.equal(env, undefined);
});

test("resolve_exec_env skips long task sessions with no matching task", async () => {
  const { hooks } = setupHooks({ manager: { resolvePeerForTaskId: () => "" } });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:longtask:missing-task" },
    context(),
  );

  assert.equal(env, undefined);
});

test("resolve_exec_env skips when the state root cannot be resolved", async () => {
  const { hooks } = setupHooks({ resolveStateRoot: () => "" });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:wecom:direct:wx-1" },
    context(),
  );

  assert.equal(env, undefined);
});

test("resolve_exec_env skips when the output directory cannot be created", async () => {
  const { hooks } = setupHooks({
    mkdir: () => { throw new Error("read-only"); },
  });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:wecom:direct:wx-1" },
    context(),
  );

  assert.equal(env, undefined);
});

test("resolve_exec_env ignores empty or non-agent session keys", async () => {
  const { hooks } = setupHooks();

  const noKey = await hooks.resolveExecEnv(
    { toolName: "exec" },
    { agentId: "alice" },
  );
  const notAgent = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "session-1" },
    context({ sessionKey: "" }),
  );

  assert.equal(noKey, undefined);
  assert.equal(notAgent, undefined);
});

test("resolve_exec_env sanitizes peerId into a directory segment", async () => {
  const { hooks } = setupHooks({
    manager: { resolvePeerForTaskId: () => "user:team/内部&客户" },
  });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:alice:longtask:task-1" },
    context(),
  );

  // user: prefix stripped, remaining ":" and unsafe chars become "-"; unicode kept.
  assert.equal(env.SKILL_OUTPUT_DIR, "/state/skill-outputs/alice/team-内部-客户");
});

function setupHooks(overrides = {}) {
  const mkdirs = [];
  const hooks = createSkillOutputHooks({
    resolveStateRoot: () => "/state",
    manager: { resolvePeerForTaskId: () => "" },
    mkdir: (dir, opts) => mkdirs.push({ dir, opts }),
    ...overrides,
  });
  return { hooks, mkdirs };
}

function context(overrides = {}) {
  return { agentId: "alice", sessionKey: "agent:alice:wecom:direct:wx-1", ...overrides };
}

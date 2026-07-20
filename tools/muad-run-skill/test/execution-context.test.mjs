import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkillEnvironment,
  sanitizeBaseEnvironment,
  SkillContextError,
  trustedExecutionContext,
} from "../src/execution-context.mjs";

test("trusted Tool Context is required and main cannot execute script Skills", () => {
  const context = trustedExecutionContext({
    agentId: "alice",
    runId: "run-1",
    sessionKey: "agent:alice:wecom:direct:user-a",
    workspaceDir: "/home/node/.openclaw/workspace-alice",
  });
  assert.equal(context.agentId, "alice");
  assert.equal(context.runId, "run-1");
  for (const invalid of [
    {},
    { agentId: "main", sessionKey: "x", workspaceDir: "/state/workspace" },
    { agentId: "alice", sessionKey: "x", workspaceDir: "relative" },
  ]) {
    assert.throws(() => trustedExecutionContext(invalid), SkillContextError);
  }
});

test("trusted context overrides ambient MUAD values", () => {
  const env = buildSkillEnvironment({
    baseEnv: { MUAD_AGENT_ID: "mallory", MUAD_SESSION_KEY: "forged" },
    context: { agentId: "alice", sessionKey: "trusted", workspaceDir: "/state/workspace-alice" },
    manifest: { name: "xdr-query" },
    input: "query",
    args: { agentId: "bob" },
    eventFile: "/state/events",
    workDir: "/state/work",
  });
  assert.equal(env.MUAD_AGENT_ID, "alice");
  assert.equal(env.MUAD_SESSION_KEY, "trusted");
  assert.equal(env.MUAD_WORKSPACE_DIR, "/state/workspace-alice");
  assert.equal(JSON.parse(env.MUAD_SKILL_ARGS_JSON).agentId, "bob");
});

test("skill child environment strips secrets and keeps only allowlisted base vars", () => {
  const sanitized = sanitizeBaseEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/node",
    LANG: "C.UTF-8",
    LLM_API_KEY: "sk-secret",
    WECOM_SECRET: "wecom-secret",
    OPENCLAW_GATEWAY_TOKEN: "gateway-token",
    MUAD_SERVICE_TOKEN: "service-token",
    HTTP_PROXY: "http://proxy.internal:8080",
    EMPTY: "",
  });
  assert.deepEqual(sanitized, {
    PATH: "/usr/bin",
    HOME: "/home/node",
    LANG: "C.UTF-8",
  });

  const env = buildSkillEnvironment({
    baseEnv: {
      PATH: "/usr/bin",
      LLM_API_KEY: "sk-secret",
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      MUAD_AGENT_ID: "mallory",
    },
    context: { agentId: "alice", sessionKey: "trusted", workspaceDir: "/state/workspace-alice" },
    manifest: { name: "xdr-query" },
    input: "query",
    args: {},
    eventFile: "/state/events",
    workDir: "/state/work",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.MUAD_AGENT_ID, "alice");
  assert.equal(env.LLM_API_KEY, undefined);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
});

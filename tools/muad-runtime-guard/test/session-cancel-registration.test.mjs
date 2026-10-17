import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import plugin from "../src/index.mjs";
import { LongTaskManager } from "../src/long-task-manager.mjs";
import {
  SESSION_CANCEL_CAPABILITY_VERSION,
  SESSION_CANCEL_METHOD,
  SESSION_CANCEL_SCOPE,
  SESSION_PREVIEW_METHOD,
  installSessionCancelCapability,
  sessionCancelCapabilityOf,
} from "../src/session-cancel-rpc.mjs";
import { runtimeHealth } from "../src/health.mjs";
import { parseGuardConfig } from "../src/config.mjs";

// 注册与能力 [integration]：真实插件 register 与 host API spy。两个 RPC 只以
// operator.write 注册，绝不成为模型工具；health 上报 sessionCancel 能力。

const SYMBOLS = [
  "muad.session-manager.health", "muad.browser.lease", "muad.skill.lease",
  "muad.longtask.manager", "muad.skill.progress.manager", "muad.longtask.cancel",
  "muad.session.cancel", "muad.longtask.worker-instance",
];
const SESSION_KEY = "agent:alice:wecom:direct:wx-1";

function cleanupSymbols(t) {
  t.after(() => {
    for (const name of SYMBOLS) {
      globalThis[Symbol.for(name)]?.close?.();
      delete globalThis[Symbol.for(name)];
    }
  });
}

function validConfig() {
  return {
    generation: 7,
    mainAgentId: "main",
    quarantineProfile: "quarantine",
    agentProfiles: [
      { agentId: "alice", profile: "alice" },
      { agentId: "bob", profile: "bob" },
    ],
    skillReadRoots: [
      { agentId: "alice", roots: [] },
      { agentId: "bob", roots: [] },
    ],
    skillAuditGrants: [],
    sessionAgentIds: ["alice", "bob"],
    maxBrowserConcurrency: 2,
    maxSkillConcurrency: 4,
    maxLongTaskConcurrency: 2,
    longTaskSkillGrants: [],
    consoleInternalURL: "http://console.internal:8080/internal/v1",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
  };
}

function openClawConfig() {
  return {
    agents: { list: [
      { id: "main", workspace: "/state/workspace", agentDir: "/state/agents/main/agent" },
      { id: "alice", workspace: "/state/workspace-alice", agentDir: "/state/agents/alice/agent" },
      { id: "bob", workspace: "/state/workspace-bob", agentDir: "/state/agents/bob/agent" },
    ] },
  };
}

function registerPlugin(t) {
  const root = mkdtempSync(path.join(tmpdir(), "session-cancel-reg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new LongTaskManager({
    limit: 2,
    stateFile: path.join(root, "state.jsonl"),
    runTask: () => new Promise(() => {}),
  });
  const registration = { tools: [], methods: [], warnings: [] };
  t.after(() => manager.close());
  plugin.register({
    pluginConfig: validConfig(),
    config: openClawConfig(),
    logger: { warn: (message) => registration.warnings.push(message) },
    runtime: { agent: {
      resolveAgentWorkspaceDir: (_config, agentId) => `/state/workspace-${agentId}`,
      resolveAgentDir: (_config, agentId) => `/state/agents/${agentId}/agent`,
    } },
    registerTool: (_factory, options) => { registration.tools.push(options?.name ?? ""); },
    registerCommand: () => {},
    registerTrustedToolPolicy: () => {},
    on: () => {},
    registerGatewayMethod: (method, handler, options) => {
      registration.methods.push({ method, handler, options });
    },
    registerReload: () => {},
  });
  return { registration, manager };
}

test("session-cancel RPCs register as operator.write only and never as model tools", async (t) => {
  cleanupSymbols(t);
  const { registration } = registerPlugin(t);

  const preview = registration.methods.find((entry) => entry.method === SESSION_PREVIEW_METHOD);
  const cancel = registration.methods.find((entry) => entry.method === SESSION_CANCEL_METHOD);
  assert.ok(preview, "preview RPC registered");
  assert.ok(cancel, "cancel RPC registered");
  assert.equal(SESSION_PREVIEW_METHOD, "muad.session.preview");
  assert.equal(SESSION_CANCEL_METHOD, "muad.session.cancel");
  assert.equal(SESSION_CANCEL_SCOPE, "operator.write");
  assert.equal(preview.options.scope, SESSION_CANCEL_SCOPE);
  assert.equal(cancel.options.scope, SESSION_CANCEL_SCOPE);
  assert.equal(SESSION_CANCEL_CAPABILITY_VERSION, 1);

  // 绝不注册为模型工具。
  assert.deepEqual(registration.tools, ["muad_submit_long_task"]);
  assert.equal(registration.tools.some((name) => /session|cancel/iu.test(name)), false);

  // 能力未就绪：明确不可用，不危险兜底。
  const capability = sessionCancelCapabilityOf(globalThis);
  assert.equal(capability.available, false);
  assert.deepEqual(
    await preview.handler({ sessionKey: SESSION_KEY, requestedBy: "admin-1" }),
    { ok: false, reason: "session_cancel_unavailable" },
  );
  assert.deepEqual(
    await cancel.handler({
      sessionKey: SESSION_KEY, requestedBy: "admin-1",
      expected: [{ pid: 4028, fingerprint: "0123456789abcdef" }],
    }),
    { ok: false, reason: "session_cancel_unavailable" },
  );

  // 原生加载失败后能力保持不可用，并携带稳定 reason。
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [capability.available, capability.version, capability.reason],
    [false, 0, "sdk_unavailable"],
  );
});

test("health reports sessionCancel availability and logs carry the stable prefix", async (t) => {
  cleanupSymbols(t);
  const { registration } = registerPlugin(t);
  const healthHandler = registration.methods.find((entry) => entry.method === "muad.runtime.health").handler;

  await new Promise((resolve) => setImmediate(resolve));
  let health = await healthHandler({ params: {} });
  assert.deepEqual(health.sessionCancel, { available: false, version: 0, reason: "sdk_unavailable" });
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).sessionCancel.available, false);

  // 能力就绪（原生运行环境加载成功后注入）：version=1、reason 为空。
  installSessionCancelCapability(globalThis, { available: true, version: 1, reason: "" });
  health = await healthHandler({ params: {} });
  assert.deepEqual(health.sessionCancel, { available: true, version: 1, reason: "" });
  assert.deepEqual(runtimeHealth(parseGuardConfig(validConfig())).sessionCancel,
    { available: true, version: 1, reason: "" });

  const lines = registration.warnings.filter((message) => message.includes("[muad-runtime-guard][session-cancel]"));
  assert.ok(lines.length > 0, "session-cancel runtime diagnostics logged");
  assert.equal(lines.some((line) => line.includes("pod-service-token")), false);
});

test("health fails closed when no session-cancel capability marker exists", (t) => {
  cleanupSymbols(t);
  globalThis[Symbol.for("muad.session-manager.health")] = { loaded: true, version: 1 };
  globalThis[Symbol.for("muad.browser.lease")] = { snapshot: () => ({ active: 0, queued: 0, limit: 2 }) };
  globalThis[Symbol.for("muad.skill.lease")] = { snapshot: () => ({ active: 0, queued: 0, limit: 4 }) };
  globalThis[Symbol.for("muad.longtask.manager")] = { snapshot: () => ({ active: 0, queued: 0, limit: 2 }) };

  assert.deepEqual(runtimeHealth(parseGuardConfig(validConfig())).sessionCancel,
    { available: false, version: 0, reason: "native_unavailable" });
});

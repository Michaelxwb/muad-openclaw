import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../src/index.mjs';
import { parseGuardConfig } from '../src/config.mjs';
import { LongTaskManager } from '../src/long-task-manager.mjs';
import { runtimeHealth } from '../src/health.mjs';
import {
  LONG_TASK_CANCEL_METHOD,
  LONG_TASK_CANCEL_SCOPE,
  cancelCapabilityOf,
  installCancelCapability,
  loadNativeCancelRuntime,
} from '../src/long-task-cancel-rpc.mjs';

// LongTaskControlS21 [integration] 真实边界：真实插件 register/hooks/manager 与 host
// API spy、真实健康输出；原生取消依赖按公开 SDK 契约以可控 importer 注入。

const SYMBOLS = [
  "muad.session-manager.health", "muad.browser.lease", "muad.skill.lease",
  "muad.longtask.manager", "muad.skill.progress.manager", "muad.longtask.cancel",
];

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
    skillReadRoots: [{ agentId: "alice", roots: ["/opt/openclaw-skills/web-tools-guide"] }],
    skillAuditGrants: [{
      agentId: "alice", name: "web-tools-guide",
      rootPath: "/opt/openclaw-skills/web-tools-guide", source: "system",
    }],
    sessionAgentIds: ["alice", "bob"],
    maxBrowserConcurrency: 2,
    maxSkillConcurrency: 4,
    maxLongTaskConcurrency: 2,
    longTaskSkillGrants: [{ agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query" }],
    consoleInternalURL: "http://console.internal:8080/internal/v1",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
  };
}

function openClawConfig() {
  return {
    agents: { list: [
      { id: "main", workspace: "/state/workspace", agentDir: "/state/agents/main/agent" },
      { id: "alice", workspace: "/state/workspace-alice", agentDir: "/state/agents/alice/agent", model: { primary: "pod-default/deepseek-chat" } },
      { id: "bob", workspace: "/state/workspace-bob", agentDir: "/state/agents/bob/agent", model: { primary: "pod-default/deepseek-chat" } },
    ] },
    models: { providers: { "pod-default": { models: [{ id: "deepseek-chat", name: "deepseek-chat" }] } } },
  };
}

function registerPlugin(t, manager) {
  const registration = { tools: [], methods: [], warnings: [], runs: [] };
  t.after(() => manager?.close());
  globalThis[Symbol.for("muad.longtask.manager")] = manager;
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
  return registration;
}

function taskInput(overrides = {}) {
  return {
    agentId: "alice",
    peerId: "wx-1",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    skillName: "xdr-query",
    skillRoot: "/opt/openclaw-skills/xdr-query",
    objective: "客户报告",
    replyChannel: "wecom",
    locale: "zh",
    ...overrides,
  };
}

test('LongTaskControlS21 cancel RPC is operator-only, chain-gated and never a model tool', async t => {
  cleanupSymbols(t);
  const root = mkdtempSync(path.join(tmpdir(), "muad-cancel-rpc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = [];
  const manager = new LongTaskManager({
    limit: 2,
    stateFile: path.join(root, "state.jsonl"),
    now: () => new Date("2026-10-15T13:00:00.000Z"),
    runTask: (task, runOptions) => {
      runs.push({ task, runOptions });
      return new Promise(() => {});
    },
  });
  const registration = registerPlugin(t, manager);

  // 仅 operator.write 的内部 RPC；绝不注册为模型工具或进入业务 allowlist。
  const cancel = registration.methods.find(entry => entry.method === LONG_TASK_CANCEL_METHOD);
  assert.ok(cancel, "cancel RPC registered");
  assert.equal(cancel.options.scope, LONG_TASK_CANCEL_SCOPE);
  assert.equal(LONG_TASK_CANCEL_METHOD, "muad.long-task.cancel");
  assert.equal(LONG_TASK_CANCEL_SCOPE, "operator.write");
  assert.deepEqual(registration.tools, ["muad_submit_long_task"]);
  assert.equal(registration.tools.some(name => /cancel/iu.test(name)), false);

  // 身份不可信/畸形请求：稳定拒绝且不触碰 manager。
  const cancelCalls = [];
  const original = manager.cancelTask.bind(manager);
  manager.cancelTask = async (taskId, options) => {
    cancelCalls.push([taskId, options]);
    return original(taskId, options);
  };
  for (const params of [
    undefined, null, {}, ["task"], { taskId: "task" },
    { taskId: "", requestedBy: "operator-secret-77" },
    { taskId: "task", requestedBy: "" },
    { taskId: "task", requestedBy: "operator-secret-77", extra: true },
    { taskId: "x".repeat(200), requestedBy: "operator-secret-77" },
    { taskId: "task", requestedBy: "bad\nidentity" },
    { taskId: 42, requestedBy: "operator-secret-77" },
  ]) {
    const result = await cancel.handler(params);
    assert.deepEqual([result.ok, result.reason], [false, "invalid_request"], JSON.stringify(params));
  }
  assert.deepEqual(cancelCalls, []);

  // 取消链不完整（本环境无法加载原生 SDK）：稳定不可用，不触碰 manager。
  const unavailable = await cancel.handler({ taskId: "task-a", requestedBy: "operator-secret-77" });
  assert.deepEqual([unavailable.ok, unavailable.reason], [false, "cancel_unavailable"]);
  assert.deepEqual(cancelCalls, []);
  const healthBefore = await registration.methods
    .find(entry => entry.method === "muad.runtime.health").handler({});
  assert.deepEqual(healthBefore.longTaskCancel, { available: false, version: 0 });
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).longTaskCancel.available, false);

  // 链完整（原生加载成功注入）：handler 经真实 manager 执行并回传终态。
  installCancelCapability(globalThis, { available: true, version: 1 });
  assert.equal(cancelCapabilityOf(globalThis).available, true);
  const submitted = manager.submit(taskInput({ taskId: "task-rpc" }));
  assert.equal(submitted.task.status, "running");
  const result = await cancel.handler({ taskId: "task-rpc", requestedBy: "operator-secret-77" });
  assert.deepEqual(
    [result.ok, result.outcome, result.status],
    [true, "cancel_requested", "cancelling"],
  );
  assert.deepEqual(cancelCalls, [["task-rpc", { requestedBy: "operator-secret-77" }]]);
  const healthAfter = await registration.methods
    .find(entry => entry.method === "muad.runtime.health").handler({});
  assert.deepEqual(healthAfter.longTaskCancel, { available: true, version: 1 });

  // 取消终态再次请求：already_terminal 原样回传，不误报成功。
  const task2 = manager.submit(taskInput({ taskId: "task-rpc-2" }));
  assert.equal(task2.task.status, "running");
  await cancel.handler({ taskId: "task-rpc-2", requestedBy: "operator-secret-77" });
  const repeated = await cancel.handler({ taskId: "task-rpc-2", requestedBy: "operator-secret-77" });
  assert.deepEqual([repeated.ok, repeated.outcome, repeated.status], [true, "cancel_requested", "cancelling"]);

  // 日志：稳定 [muad-runtime-guard][longtask-cancel] 前缀，仅 ID/状态/原因，不含 requestedBy。
  const cancelLogs = registration.warnings.filter(message => message.includes("longtask-cancel"));
  assert.ok(cancelLogs.length > 0, "cancel diagnostics logged");
  assert.equal(cancelLogs.some(message => message.includes("operator-secret-77")), false);

  // 原生加载契约：公开导出存在才报告可用，缺失/异常明确不可用。
  const fakeNative = {
    resolveActiveEmbeddedRunSessionId: () => "run-1",
    abortAndDrainAgentHarnessRun: async () => ({ aborted: true, drained: true, forceCleared: false }),
    signalProcessTree: () => {},
  };
  const loaded = await loadNativeCancelRuntime({
    importer: async specifier => specifier.includes("agent-harness-runtime") ? fakeNative : { killProcessTree: () => {}, signalProcessTree: () => {} },
  });
  assert.equal(loaded.available, true);
  assert.equal(typeof loaded.native.abortAndDrainAgentHarnessRun, "function");
  const missing = await loadNativeCancelRuntime({ importer: async () => { throw new Error("not installed"); } });
  assert.deepEqual([missing.available, missing.reason], [false, "sdk_unavailable"]);
  const incomplete = await loadNativeCancelRuntime({ importer: async () => ({}) });
  assert.deepEqual([incomplete.available, incomplete.reason], [false, "native_unavailable"]);
});

test('LongTaskControlS21 cancel RPC unwraps the gateway params wrapper', async t => {
  cleanupSymbols(t);
  const root = mkdtempSync(path.join(tmpdir(), "muad-cancel-rpc-wrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = new LongTaskManager({
    limit: 2,
    stateFile: path.join(root, "state.jsonl"),
    runTask: () => new Promise(() => {}),
  });
  const registration = registerPlugin(t, manager);
  const cancel = registration.methods.find(entry => entry.method === LONG_TASK_CANCEL_METHOD);
  assert.ok(cancel, "cancel RPC registered");
  installCancelCapability(globalThis, { available: true, version: 1 });

  // 真实 gateway 传输形状：handler 收到 {params: {...}} 包装时必须解包。
  const submitted = manager.submit(taskInput({ taskId: "task-wrap" }));
  assert.equal(submitted.task.status, "running");
  const result = await cancel.handler({ params: { taskId: "task-wrap", requestedBy: "operator-9" } });
  assert.deepEqual([result.ok, result.outcome, result.status], [true, "cancel_requested", "cancelling"]);

  // 包装下畸形请求仍被稳定拒绝。
  const bad = await cancel.handler({ params: { taskId: "task-wrap", requestedBy: "x", extra: 1 } });
  assert.deepEqual([bad.ok, bad.reason], [false, "invalid_request"]);
});

import path from "node:path";
import { createBrowserLeaseHooks } from "./browser-hooks.mjs";
import { SharedBrowserLeaseManager } from "./browser-lease.mjs";
import { createBindCommand } from "./bind-command.mjs";
import { BindingClient, BindingClientError } from "./binding-client.mjs";
import { parseGuardConfig } from "./config.mjs";
import { createCrossUserGuard } from "./cross-user-guard.mjs";
import { createHealthHandler } from "./health.mjs";
import { createLongTaskHooks } from "./long-task-hooks.mjs";
import { LongTaskManager } from "./long-task-manager.mjs";
import { LongTaskStateClient, LongTaskStateClientError } from "./long-task-state-client.mjs";
import { createMainBindingReply } from "./main-binding-reply.mjs";
import { createModelConfigDispatch } from "./model-config-reply.mjs";
import { createRouteVerifier } from "./route-verifier.mjs";
import { createSkillAuditHooks } from "./skill-audit-hooks.mjs";
import { SkillAuditClient, SkillAuditClientError } from "./skill-audit-client.mjs";
import { createSkillLeaseHooks } from "./skill-hooks.mjs";
import { createSkillOutputHooks } from "./skill-output-hooks.mjs";
import { SharedSkillLeaseManager } from "./skill-lease.mjs";
import {
  createAgentFilesPolicy,
  createBrowserProfilePolicy,
  createMainDenyPolicy,
} from "./tool-policies.mjs";

const plugin = {
  id: "muad-runtime-guard",
  name: "Muad Runtime Guard",
  description: "Enforces Muad multi-user runtime bindings and trusted execution boundaries.",
  register(api) {
    const config = parseGuardConfig(api.pluginConfig);
    const leaseManager = installBrowserLease(config.maxBrowserConcurrency);
    const skillLeaseManager = installSkillLease(config.maxSkillConcurrency);
    const longTaskManager = installLongTaskManager(
      config.maxLongTaskConcurrency,
      globalThis,
      (message) => api.logger?.warn?.(message),
    );
    installLongTaskStatePush(longTaskManager, config, api);
    registerMainBindingReply(api, config);
    registerModelConfigDispatch(api, config);
    registerToolPolicies(api, config);
    registerBrowserLeaseHooks(api, config, leaseManager);
    registerSkillLeaseHooks(api, config, skillLeaseManager);
    registerLongTaskHooks(api, config, longTaskManager);
    registerSkillOutputHooks(api, longTaskManager);
    registerCrossUserGuard(api, config);
    registerSkillAuditHooks(api, config, createSkillAuditClient(config));
    registerExecFailureLog(api);
    registerReloadPolicy(api);
    const client = createBindingClient(config);
    api.registerCommand(createBindCommand({
      client,
      mainAgentId: config.mainAgentId,
      onRejected: ({ code, reason }) => api.logger?.warn?.(
        `[muad-runtime-guard] bind rejected code=${code} reason=${reason}`,
      ),
    }));
    api.registerGatewayMethod("muad.runtime.health", createHealthHandler(config), {
      scope: "operator.read",
    });
    api.registerGatewayMethod("muad.runtime.verify-routes", createRouteVerifier(api), {
      scope: "operator.read",
    });
  },
};

function registerExecFailureLog(api) {
  // exec 子进程（skill 脚本 → session-manager CLI）的 stderr 不进 openclaw 日志，
  // 这里在 exec 失败时把 stderr 转发到 openclaw 日志，便于排查 session-manager 登录失败。
  api.on("after_tool_call", (event) => {
    if (event?.toolName !== "exec" && event?.toolName !== "bash") return;
    const error = event?.error;
    if (!error) return;
    const message = typeof error === "string"
      ? error
      : (typeof error === "object" && error !== null
        ? (error.stderr || error.message || error.output || "")
        : String(error));
    if (!message) return;
    api.logger?.warn?.(`[muad-runtime-guard][exec-failed] tool=${event.toolName} ${String(message).slice(0, 2000)}`);
  }, { priority: 900, timeoutMs: 1_000 });
}

function registerReloadPolicy(api) {
  api.registerReload?.({
    noopPrefixes: ["plugins.entries.muad-runtime-guard.config.generation"],
  });
}

function registerMainBindingReply(api, config) {
  api.on(
    "before_agent_reply",
    createMainBindingReply({ mainAgentId: config.mainAgentId }),
    { priority: -1000, timeoutMs: 1_000 },
  );
}

function registerModelConfigDispatch(api, config) {
  api.on(
    "before_dispatch",
    createModelConfigDispatch({
      mainAgentId: config.mainAgentId,
      config: api.config,
      onInvalid: ({ agentId, reason }) => api.logger?.warn?.(
        `[muad-runtime-guard] model config unavailable agent=${agentId || "unknown"} reason=${reason}`,
      ),
    }),
    { priority: -1000, timeoutMs: 1_000 },
  );
}

function registerToolPolicies(api, config) {
  const report = ({ agentId, reason }) => api.logger?.warn?.(
    `[muad-runtime-guard] browser policy denied agent=${agentId || "unknown"} reason=${reason}`,
  );
  api.registerTrustedToolPolicy(createBrowserProfilePolicy({ config, onViolation: report }));
  api.registerTrustedToolPolicy(createMainDenyPolicy(config));
  api.registerTrustedToolPolicy(createAgentFilesPolicy({
    config,
    resolvePaths: createAgentPathResolver(api),
  }));
}

function registerBrowserLeaseHooks(api, config, leaseManager) {
  const hooks = createBrowserLeaseHooks({
    config,
    leaseManager,
    log: (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  });
  api.on("before_tool_call", hooks.before, { priority: -1000, timeoutMs: 35_000 });
  api.on("after_tool_call", hooks.after, { priority: 1000, timeoutMs: 1_000 });
}

function registerSkillLeaseHooks(api, config, leaseManager) {
  const hooks = createSkillLeaseHooks({
    config,
    leaseManager,
    log: (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  });
  api.on("before_agent_run", hooks.before, { priority: -1000, timeoutMs: 35_000 });
  api.on("agent_end", hooks.end, { priority: 1000, timeoutMs: 1_000 });
}

function registerLongTaskHooks(api, config, manager) {
  const hooks = createLongTaskHooks({
    config,
    manager,
    resolveWorkspace: (agentId) => resolveWorkspace(api, agentId),
    log: (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  });
  api.on("before_dispatch", hooks.beforeDispatch, { priority: -1100, timeoutMs: 1_000 });
  api.on("before_agent_run", hooks.beforeAgentRun, { priority: -900, timeoutMs: 1_000 });
  api.on("before_tool_call", hooks.beforeToolCall, { priority: -900, timeoutMs: 1_000 });
  api.on("before_agent_finalize", hooks.beforeAgentFinalize, { priority: -900, timeoutMs: 1_000 });
  api.on("reply_payload_sending", hooks.replyPayloadSending, { priority: -900, timeoutMs: 1_000 });
  api.on("agent_end", hooks.agentEnd, { priority: 900, timeoutMs: 1_000 });
}

function registerSkillOutputHooks(api, manager) {
  const hooks = createSkillOutputHooks({
    manager,
    resolveWorkspace: (agentId) => resolveWorkspace(api, agentId),
  });
  api.on("resolve_exec_env", hooks.resolveExecEnv, { priority: -800, timeoutMs: 1_000 });
}

function registerCrossUserGuard(api, config) {
  const hooks = createCrossUserGuard({
    config,
    log: (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  });
  api.on("before_tool_call", hooks.beforeToolCall, { priority: -950, timeoutMs: 1_000 });
  api.on("reply_payload_sending", hooks.replyPayloadSending, { priority: -850, timeoutMs: 1_000 });
}

function registerSkillAuditHooks(api, config, client) {
  const hooks = createSkillAuditHooks({
    config,
    client,
    log: (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  });
  api.on("before_dispatch", hooks.beforeDispatch, { priority: -100, timeoutMs: 1_000 });
  api.on("before_agent_run", hooks.beforeAgentRun, { priority: -100, timeoutMs: 1_000 });
  api.on("before_tool_call", hooks.beforeToolCall, { priority: -100, timeoutMs: 1_000 });
}

function resolveWorkspace(api, agentId) {
  try {
    const workspace = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return "";
    return path.resolve(workspace);
  } catch {
    return "";
  }
}

export function installBrowserLease(limit, globals = globalThis) {
  const symbol = Symbol.for("muad.browser.lease");
  const existing = globals[symbol];
  if (existing?.shared === true && existing.closed !== true && existing.limit === limit) return existing;
  existing?.close?.();
  const manager = new SharedBrowserLeaseManager({ limit });
  globals[symbol] = manager;
  return manager;
}

export function installLongTaskManager(limit, globals = globalThis, log = () => {}) {
  const symbol = Symbol.for("muad.longtask.manager");
  const existing = globals[symbol];
  if (existing?.shared === true && existing.closed !== true) {
    existing.updateLimit?.(limit);
    return existing;
  }
  existing?.close?.();
  const manager = new LongTaskManager({ limit, log });
  globals[symbol] = manager;
  return manager;
}

export function installLongTaskStatePush(longTaskManager, config, api) {
  if (!longTaskManager?.subscribe) return;
  longTaskManager.subscribe(createLongTaskStatePushTrigger(
    createLongTaskStateClient(config),
    (message) => api.logger?.warn?.(`[muad-runtime-guard]${message}`),
  ));
}

export function createLongTaskStatePushTrigger(client, log = () => {}) {
  // 串行化 push：每次快照接在上一个 push 之后，保证 console 收到的顺序与状态变更
  // 顺序一致，避免两个快速状态变更的 push 乱序完成、旧快照覆盖新快照的计数。
  // catch 吞掉错误，chain 不会变 rejected，后续 push 照常排队执行。
  let chain = Promise.resolve();
  return (snapshot) => {
    if (!client || typeof client.push !== "function") return;
    chain = chain
      .then(() => client.push(snapshot))
      .then(() => log(`[longtask-push] pushed ${countTasks(snapshot)} task(s)`))
      .catch((error) => {
        const code = error?.code ?? "unknown";
        const retryable = error?.retryable === true;
        log(`[longtask-push] snapshot push failed code=${code} retryable=${retryable}`);
      });
  };
}

function createLongTaskStateClient(config) {
  if (!config.valid) {
    return { push: async () => { throw new LongTaskStateClientError("service_unavailable", true); } };
  }
  return new LongTaskStateClient({
    baseURL: config.consoleInternalURL,
    tokenFile: config.serviceTokenFile,
  });
}

function countTasks(snapshot) {
  if (!Array.isArray(snapshot?.pools)) return 0;
  return snapshot.pools.reduce((sum, pool) => sum + (Array.isArray(pool?.tasks) ? pool.tasks.length : 0), 0);
}

export function installSkillLease(limit, globals = globalThis) {
  const symbol = Symbol.for("muad.skill.lease");
  const existing = globals[symbol];
  if (existing?.shared === true && existing.closed !== true && existing.limit === limit) return existing;
  existing?.close?.();
  const manager = new SharedSkillLeaseManager({ limit });
  globals[symbol] = manager;
  return manager;
}

export function createAgentPathResolver(api) {
  return (agentId) => {
    try {
      const workspace = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
      const agentDir = api.runtime.agent.resolveAgentDir(api.config, agentId);
      if (!path.isAbsolute(workspace) || !path.isAbsolute(agentDir)) return null;
      return {
        workspace: path.resolve(workspace),
        agentDir: path.resolve(agentDir),
        sessionStore: path.resolve(path.dirname(agentDir), "session-store"),
        outputs: path.resolve(workspace, "skill-outputs"),
      };
    } catch {
      return null;
    }
  };
}

function createBindingClient(config) {
  if (!config.valid) {
    return { activate: async () => { throw new BindingClientError("service_unavailable", true); } };
  }
  return new BindingClient({
    baseURL: config.consoleInternalURL,
    tokenFile: config.serviceTokenFile,
  });
}

function createSkillAuditClient(config) {
  if (!config.valid) {
    return { report: async () => { throw new SkillAuditClientError("service_unavailable", true); } };
  }
  return new SkillAuditClient({
    baseURL: config.consoleInternalURL,
    tokenFile: config.serviceTokenFile,
  });
}

export default plugin;

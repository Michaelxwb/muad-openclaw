import path from "node:path";
import { createBrowserLeaseHooks } from "./browser-hooks.mjs";
import { SharedBrowserLeaseManager } from "./browser-lease.mjs";
import { createBindCommand } from "./bind-command.mjs";
import { BindingClient, BindingClientError } from "./binding-client.mjs";
import { parseGuardConfig } from "./config.mjs";
import { createHealthHandler } from "./health.mjs";
import { createMainBindingReply } from "./main-binding-reply.mjs";
import { createModelConfigDispatch } from "./model-config-reply.mjs";
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
    registerMainBindingReply(api, config);
    registerModelConfigDispatch(api, config);
    registerToolPolicies(api, config);
    registerBrowserLeaseHooks(api, config, leaseManager);
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
  },
};

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
  const hooks = createBrowserLeaseHooks({ config, leaseManager });
  api.on("before_tool_call", hooks.before, { priority: -1000, timeoutMs: 35_000 });
  api.on("after_tool_call", hooks.after, { priority: 1000, timeoutMs: 1_000 });
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

export default plugin;

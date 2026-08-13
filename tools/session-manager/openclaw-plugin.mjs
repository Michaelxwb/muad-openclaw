import {
  createBrowserSessionApplier,
  createSessionGetStateTool,
  ResolverClient,
  SessionService,
} from "./dist/index.js";

const ID_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;

export function createPluginTool({ toolContext, service }) {
  const core = createSessionGetStateTool(toolContext, service);
  return {
    name: core.name,
    label: core.label,
    description: core.description,
    parameters: core.parameters,
    execute: async (_toolCallId, rawParams) => jsonResult(await core.execute(rawParams)),
  };
}

const plugin = {
  id: "session-manager",
  name: "Session Manager",
  description: "Provides isolated business-platform session state for the active agent.",
  register(api) {
    const baseURL = resolveConsoleURL(api.pluginConfig, process.env);
    const agentProfiles = parseAgentProfiles(api.pluginConfig);
    const browserApplier = createPluginBrowserApplier(api, agentProfiles);
    api.registerTool((toolContext) => createPluginTool({
      toolContext,
      service: new SessionService(
        new ResolverClient({ baseURL }),
        {
          ...(browserApplier ? { browserApplier } : {}),
          log: (message) => api.logger?.warn?.(message),
        },
      ),
    }), { name: "session_get_state" });
    globalThis[Symbol.for("muad.session-manager.health")] = { loaded: true, version: 1 };
  },
};

function resolveConsoleURL(pluginConfig, env) {
  const configured = pluginConfig && typeof pluginConfig === "object"
    ? String(pluginConfig.consoleInternalURL ?? "").trim()
    : "";
  return configured || String(env.MUAD_CONSOLE_INTERNAL_URL ?? "").trim();
}

function parseAgentProfiles(pluginConfig) {
  const value = pluginConfig && typeof pluginConfig === "object" ? pluginConfig.agentProfiles : undefined;
  if (!Array.isArray(value)) return new Map();
  const profiles = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return new Map();
    const agentId = String(entry.agentId ?? "").trim();
    const profile = String(entry.profile ?? "").trim();
    if (!ID_PATTERN.test(agentId) || !ID_PATTERN.test(profile) || profiles.has(agentId)) {
      return new Map();
    }
    profiles.set(agentId, profile);
  }
  return profiles;
}

function createPluginBrowserApplier(api, agentProfiles) {
  if (agentProfiles.size === 0 || typeof api.runtime?.gateway?.request !== "function") {
    return undefined;
  }
  return createBrowserSessionApplier({
    request: (method, params, options) => api.runtime.gateway.request(method, params ?? {}, options),
    profileForAgent: (agentId) => agentProfiles.get(agentId),
  });
}

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  };
}

export default plugin;

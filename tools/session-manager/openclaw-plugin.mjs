import {
  createSessionGetStateTool,
  ResolverClient,
  SessionService,
} from "./dist/index.js";

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
    api.registerTool((toolContext) => createPluginTool({
      toolContext,
      service: new SessionService(new ResolverClient({ baseURL })),
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

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  };
}

export default plugin;

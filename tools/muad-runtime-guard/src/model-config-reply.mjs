export const MODEL_CONFIG_REPLY =
  "当前智能体模型配置不可用，请联系管理员检查模型配置后重试。";

export function createModelConfigGate({ mainAgentId, config, onInvalid }) {
  const state = resolveModelState(config);
  return (_event, context) => {
    const reason = resolveInvalidReason({ state, mainAgentId, context });
    if (!reason) return undefined;
    const agentId = resolveAgentId({ context });
    onInvalid?.({ agentId: safeId(agentId), reason });
    return {
      outcome: "block",
      reason: "muad-model-config-unavailable",
      message: MODEL_CONFIG_REPLY,
      category: "model_config",
    };
  };
}

export function createModelConfigDispatch({ mainAgentId, config, onInvalid }) {
  const state = resolveModelState(config);
  return (event, context) => {
    const reason = resolveInvalidReason({ state, mainAgentId, event, context });
    if (!reason) return undefined;
    const agentId = resolveAgentId({ event, context });
    onInvalid?.({ agentId: safeId(agentId), reason });
    return {
      handled: true,
      text: MODEL_CONFIG_REPLY,
      reason: "muad-model-config-unavailable",
    };
  };
}

export function createModelConfigReply({ mainAgentId, config, onInvalid }) {
  const state = resolveModelState(config);
  return (_event, context) => {
    const reason = resolveInvalidReason({ state, mainAgentId, context });
    if (!reason) return undefined;
    const agentId = resolveAgentId({ context });
    onInvalid?.({ agentId: safeId(agentId), reason });
    return {
      handled: true,
      reply: { text: MODEL_CONFIG_REPLY },
      reason: "muad-model-config-unavailable",
    };
  };
}

export function resolveModelState(config) {
  const agents = new Map();
  for (const agent of recordArray(config?.agents?.list)) {
    const id = String(agent.id ?? "").trim();
    const primary = String(agent.model?.primary ?? "").trim();
    if (id) agents.set(id, primary);
  }
  const providers = new Map();
  const source = isRecord(config?.models?.providers) ? config.models.providers : {};
  for (const [providerId, provider] of Object.entries(source)) {
    const models = recordArray(provider.models)
      .map((model) => String(model.id ?? "").trim())
      .filter(Boolean);
    providers.set(providerId, new Set(models));
  }
  return { agents, providers };
}

function resolveInvalidReason({ state, mainAgentId, event, context }) {
  const agentId = resolveAgentId({ event, context });
  if (!agentId || agentId === mainAgentId) return "";
  return invalidModelReason(state, agentId);
}

function resolveAgentId({ event, context }) {
  const explicit = String(context?.agentId ?? event?.agentId ?? "").trim();
  if (explicit) return explicit;
  return parseAgentIdFromSessionKey(context?.sessionKey) || parseAgentIdFromSessionKey(event?.sessionKey);
}

function parseAgentIdFromSessionKey(value) {
  const sessionKey = String(value ?? "").trim();
  const match = /^session:agent:([^:]+)(?::|$)/u.exec(sessionKey);
  return match?.[1] ?? "";
}

function invalidModelReason(state, agentId) {
  const ref = state.agents.get(agentId);
  if (!ref) return "agent_model_missing";
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return "agent_model_invalid";
  const providerId = ref.slice(0, separator);
  const modelId = ref.slice(separator + 1);
  const models = state.providers.get(providerId);
  if (!models) return "provider_missing";
  return models.has(modelId) ? "" : "model_missing";
}

function recordArray(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) ? value : "invalid";
}

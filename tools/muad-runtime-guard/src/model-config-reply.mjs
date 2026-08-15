export const MODEL_CONFIG_REPLY =
  "当前智能体模型配置不可用，请联系管理员检查模型配置后重试。";

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
  // fail-closed：无法解析调用方身份时拦截，避免身份缺失的调用绕过模型配置门禁
  // （long-task-manager 生成的 session key 为无前缀 agent:<id>:... 形式，必须能解析）。
  if (!agentId) return "agent_identity_unresolved";
  if (agentId === mainAgentId) return "";
  return invalidModelReason(state, agentId);
}

function resolveAgentId({ event, context }) {
  const explicit = String(context?.agentId ?? event?.agentId ?? "").trim();
  if (explicit) return explicit;
  return parseAgentIdFromSessionKey(context?.sessionKey) || parseAgentIdFromSessionKey(event?.sessionKey);
}

// 兼容两种格式：带 session: 前缀（OpenClaw 运行时）与无前缀 agent:<id>:...（长任务
// 会话密钥 agent:<agentId>:longtask:<taskId>）。
function parseAgentIdFromSessionKey(value) {
  const sessionKey = String(value ?? "").trim();
  const match = /^(?:session:)?agent:([^:]+)(?::|$)/u.exec(sessionKey);
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

// Blocks the last reachable cross-agent vector in a multi-user pod: a business
// agent reaching another user's session artifacts (or the pod resolver token) by
// raw path through shell/file tools, forging its execution identity, or leaking
// session data into the channel. Skill scripts are the only sanctioned path to
// session state — via the trusted session-manager CLI and the injected
// MUAD_SESSION_KEY — so direct path access and credential dumps fail closed here.

const SESSION_ARTIFACT_PATTERNS = [
  // any agent's session-store directory (word boundary catches -name/-path globs)
  /\bsession-store\b/u,
  // the platform cookie bundle written by session-manager
  /\bbundle\.json\b/u,
  // per-skill session state files (<skill>.session.json)
  /\.session\.json\b/u,
  // the pod service token is the resolver credential; reading it enables direct
  // credential resolution for any agent in the pod
  /\/run\/secrets\/muad\/pod-service-token\b/u,
];

// resolve_exec_env injects MUAD_SESSION_KEY for every exec; an inline assignment
// is the one way a command can re-assert its identity and is never legitimate.
const FORGED_SESSION_KEY_PATTERN = /MUAD_SESSION_KEY\s*=/u;

// High-precision markers of dumped session files: JSON keys that only appear in
// session-manager artifacts, never in ordinary conversation about sessions.
const SESSION_DUMP_PATTERNS = [
  /"(?:storageState|credentialFingerprint)"\s*:/u,
  /"(?:httpOnly|sameSite)"\s*:\s*(?:true|false)\b/u,
];

const EXEC_TOOLS = new Set(["exec", "bash"]);
const FILE_CONTENT_TOOLS = new Set(["write", "edit", "apply_patch"]);

const SESSION_ACCESS_REASON =
  "session files are not readable through shell or scripts; use the trusted session-manager CLI";
const FORGED_KEY_REASON =
  "re-asserting MUAD_SESSION_KEY is disabled; the trusted execution context is injected automatically";
const SESSION_LEAK_REASON = "reply contains protected session data";

export function createCrossUserGuard({ config, log = () => {} }) {
  const mainAgentId = config?.mainAgentId;
  const refusal = refusalText(config?.locale);
  return {
    beforeToolCall: async (event, ctx) => {
      if (ctx?.agentId === mainAgentId) return undefined;
      const reason = scanToolCall(event);
      if (!reason) return undefined;
      diag(log, `blocked agent=${safeId(ctx?.agentId)} tool=${safeId(event?.toolName)} reason=${reason}`);
      return { block: true, blockReason: reason };
    },
    replyPayloadSending: async (event, ctx) => {
      const text = event?.payload?.text;
      if (typeof text !== "string" || !SESSION_DUMP_PATTERNS.some((pattern) => pattern.test(text))) {
        return undefined;
      }
      diag(log, `blocked reply leak agent=${safeId(ctx?.agentId)}`);
      return { payload: { ...event.payload, text: refusal }, reason: SESSION_LEAK_REASON };
    },
  };
}

function scanToolCall(event) {
  const toolName = safeId(event?.toolName);
  const text = EXEC_TOOLS.has(toolName)
    ? shellCommandText(event)
    : FILE_CONTENT_TOOLS.has(toolName) ? fileContentText(event) : "";
  if (!text) return "";
  if (FORGED_SESSION_KEY_PATTERN.test(text)) return FORGED_KEY_REASON;
  return SESSION_ARTIFACT_PATTERNS.some((pattern) => pattern.test(text)) ? SESSION_ACCESS_REASON : "";
}

function shellCommandText(event) {
  const params = record(event?.params);
  const parts = [];
  for (const key of ["command", "script", "cmd"]) {
    if (typeof params[key] === "string") parts.push(params[key]);
  }
  if (Array.isArray(params.commands)) {
    for (const item of params.commands) {
      if (typeof item === "string") parts.push(item);
    }
  }
  return parts.join("\n");
}

function fileContentText(event) {
  const params = record(event?.params);
  const parts = [];
  for (const key of ["content", "text"]) {
    if (typeof params[key] === "string") parts.push(params[key]);
  }
  if (typeof params.patch === "string") parts.push(params.patch);
  return parts.join("\n");
}

function refusalText(locale) {
  return locale === "en"
    ? "This reply contained protected session data and was blocked by the security policy. Session credentials are only available through trusted Skills; use the relevant Skill to check your session."
    : "该回复包含受保护的会话数据，已被安全策略拦截。会话凭据只能通过受信 Skill 读取，如需检查会话状态请使用对应 Skill。";
}

function diag(log, message) {
  log(`[cross-user] ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeId(value) {
  return typeof value === "string" ? value.trim() : "unknown";
}

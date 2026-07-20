import path from "node:path";

const AGENT_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const MAX_SESSION_KEY_LENGTH = 512;
const MAX_RUN_ID_LENGTH = 512;

// Never forward gateway secrets into skill children (channel tokens, LLM keys, etc.).
const BASE_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_PATH",
  "NODE_OPTIONS",
  "SHELL",
]);

export class SkillContextError extends Error {
  constructor() {
    super("trusted skill execution context is unavailable");
    this.name = "SkillContextError";
    this.code = "invalid_skill_context";
  }
}

export function trustedExecutionContext(toolContext) {
  const context = trustedRunContext(toolContext, toolContext);
  const workspaceDir = String(toolContext?.workspaceDir ?? "").trim();
  if (!path.isAbsolute(workspaceDir)) {
    throw new SkillContextError();
  }
  return { ...context, workspaceDir: path.resolve(workspaceDir) };
}

export function trustedRunContext(event, hookContext = {}) {
  const agentId = String(hookContext?.agentId ?? event?.agentId ?? "").trim();
  const sessionKey = String(hookContext?.sessionKey ?? event?.sessionKey ?? "").trim();
  const runId = String(event?.runId ?? hookContext?.runId ?? "").trim();
  if (!validAgent(agentId) || !validSession(sessionKey) || runId.length > MAX_RUN_ID_LENGTH) {
    throw new SkillContextError();
  }
  return { agentId, sessionKey, ...(runId ? { runId } : {}) };
}

export function sanitizeBaseEnvironment(baseEnv = process.env) {
  const source = baseEnv && typeof baseEnv === "object" ? baseEnv : {};
  const env = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return env;
}

export function buildSkillEnvironment({ baseEnv, context, manifest, input, args, eventFile, workDir }) {
  return {
    ...sanitizeBaseEnvironment(baseEnv),
    MUAD_AGENT_ID: context.agentId,
    MUAD_SESSION_KEY: context.sessionKey,
    MUAD_WORKSPACE_DIR: context.workspaceDir,
    MUAD_SKILL_NAME: manifest.name,
    MUAD_SKILL_INPUT: input,
    MUAD_SKILL_ARGS_JSON: JSON.stringify(args ?? {}),
    MUAD_PROGRESS_EVENTS_FILE: eventFile,
    MUAD_PROGRESS_STATE_DIR: workDir,
  };
}

function validAgent(agentId) {
  return AGENT_PATTERN.test(agentId) && agentId !== "main";
}

function validSession(sessionKey) {
  return sessionKey.length > 0 && sessionKey.length <= MAX_SESSION_KEY_LENGTH;
}

import path from "node:path";

const AGENT_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const MAX_SESSION_KEY_LENGTH = 512;

export class SkillContextError extends Error {
  constructor() {
    super("trusted skill execution context is unavailable");
    this.name = "SkillContextError";
    this.code = "invalid_skill_context";
  }
}

export function trustedExecutionContext(toolContext) {
  const agentId = String(toolContext?.agentId ?? "").trim();
  const sessionKey = String(toolContext?.sessionKey ?? "").trim();
  const workspaceDir = String(toolContext?.workspaceDir ?? "").trim();
  if (!AGENT_PATTERN.test(agentId) || agentId === "main" || !sessionKey ||
    sessionKey.length > MAX_SESSION_KEY_LENGTH || !path.isAbsolute(workspaceDir)) {
    throw new SkillContextError();
  }
  return { agentId, sessionKey, workspaceDir: path.resolve(workspaceDir) };
}

export function buildSkillEnvironment({ baseEnv, context, manifest, input, args, eventFile, workDir }) {
  return {
    ...baseEnv,
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

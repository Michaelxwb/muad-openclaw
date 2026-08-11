import { AGENT_PATTERN, MAX_SESSION_KEY_LENGTH } from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { TrustedContext } from "./types.js";

export type CLIConfig = {
  consoleInternalURL: string;
  trustedContext: TrustedContext;
};

export function loadCLIConfig(env: NodeJS.ProcessEnv): CLIConfig {
  const sessionKey = String(env.MUAD_SESSION_KEY ?? "").trim();
  const consoleInternalURL = String(env.MUAD_CONSOLE_INTERNAL_URL ?? "").trim();
  const agentId = sessionAgentId(sessionKey);
  if (!agentId || sessionKey.length > MAX_SESSION_KEY_LENGTH || !consoleInternalURL) {
    throw new SessionManagerError("invalid_context");
  }
  return { consoleInternalURL, trustedContext: { agentId, sessionKey } };
}

function sessionAgentId(sessionKey: string): string {
  const normalized = sessionKey.startsWith("session:") ? sessionKey.slice("session:".length) : sessionKey;
  const [prefix, agentId] = normalized.split(":");
  if (prefix !== "agent" || !agentId || !AGENT_PATTERN.test(agentId)) return "";
  return agentId;
}

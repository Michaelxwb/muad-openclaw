import { AGENT_PATTERN, MAX_SESSION_KEY_LENGTH } from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { TrustedContext } from "./types.js";

export type CLIConfig = {
  consoleInternalURL: string;
  trustedContext: TrustedContext;
};

export function loadCLIConfig(env: NodeJS.ProcessEnv): CLIConfig {
  const agentId = String(env.MUAD_AGENT_ID ?? "").trim();
  const sessionKey = String(env.MUAD_SESSION_KEY ?? "").trim();
  const consoleInternalURL = String(env.MUAD_CONSOLE_INTERNAL_URL ?? "").trim();
  if (!AGENT_PATTERN.test(agentId) || !sessionKey || sessionKey.length > MAX_SESSION_KEY_LENGTH) {
    throw new SessionManagerError("invalid_context");
  }
  if (!consoleInternalURL) throw new SessionManagerError("invalid_context");
  return { consoleInternalURL, trustedContext: { agentId, sessionKey } };
}

import { AGENT_PATTERN, MAX_SESSION_KEY_LENGTH, PLATFORM_PATTERN } from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { SessionStateResult, TrustedContext } from "./types.js";

export const SESSION_GET_STATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["platform"],
  properties: {
    platform: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
  },
} as const;

export type OpenClawToolContext = {
  agentId?: string;
  sessionKey?: string;
};

export type SessionStateProvider = {
  getState(context: TrustedContext, platform: string): Promise<SessionStateResult>;
};

export function createSessionGetStateTool(
  toolContext: OpenClawToolContext,
  service: SessionStateProvider,
) {
  return {
    name: "session_get_state",
    label: "Session Get State",
    description: "Prepare the current user's isolated business-platform browser session state.",
    parameters: SESSION_GET_STATE_PARAMETERS,
    execute: async (rawParams: unknown): Promise<SessionStateResult> => {
      const context = trustedContext(toolContext);
      return service.getState(context, platformParam(rawParams));
    },
  };
}

function trustedContext(value: OpenClawToolContext): TrustedContext {
  const agentId = String(value.agentId ?? "").trim();
  const sessionKey = String(value.sessionKey ?? "").trim();
  if (!AGENT_PATTERN.test(agentId) || !sessionKey || sessionKey.length > MAX_SESSION_KEY_LENGTH) {
    throw new SessionManagerError("invalid_context");
  }
  return { agentId, sessionKey };
}

function platformParam(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.platform !== "string") {
    throw new SessionManagerError("invalid_arguments");
  }
  const platform = value.platform.trim();
  if (!PLATFORM_PATTERN.test(platform)) throw new SessionManagerError("invalid_arguments");
  return platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

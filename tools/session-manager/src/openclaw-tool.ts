import {
  AGENT_PATTERN,
  MAX_SESSION_KEY_LENGTH,
  PLATFORM_PATTERN,
  SKILL_PATTERN,
} from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { SessionStateResult, TrustedContext } from "./types.js";

export const SESSION_GET_STATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["skillName"],
  properties: {
    skillName: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    platform: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
  },
} as const;

export type OpenClawToolContext = {
  agentId?: string;
  sessionKey?: string;
};

export type SessionStateProvider = {
  getState(context: TrustedContext, skillName: string, platform?: string): Promise<SessionStateResult>;
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
      const params = stateParams(rawParams);
      return service.getState(context, params.skillName, params.platform);
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

function stateParams(value: unknown): { skillName: string; platform?: string } {
  if (!isRecord(value) || !validStateParamKeys(value) || typeof value.skillName !== "string") {
    throw new SessionManagerError("invalid_arguments");
  }
  const skillName = value.skillName.trim();
  if (!SKILL_PATTERN.test(skillName)) throw new SessionManagerError("invalid_arguments");
  const platform = typeof value.platform === "string" ? value.platform.trim() : "";
  if (platform && !PLATFORM_PATTERN.test(platform)) throw new SessionManagerError("invalid_arguments");
  return { skillName, ...(platform ? { platform } : {}) };
}

function validStateParamKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length >= 1 && keys.length <= 2 && keys.every((key) => key === "skillName" || key === "platform");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

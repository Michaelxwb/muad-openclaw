import {
  AGENT_PATTERN,
  MAX_SESSION_KEY_LENGTH,
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
  },
} as const;

export type OpenClawToolContext = {
  agentId?: string;
  sessionKey?: string;
};

export type SessionStateProvider = {
  getState(context: TrustedContext, skillName: string): Promise<SessionStateResult>;
};

/** Model-safe view: never exposes the private skill-scoped session file path. */
export type ModelSessionState = Omit<SessionStateResult, "sessionStateFile">;

export function createSessionGetStateTool(
  toolContext: OpenClawToolContext,
  service: SessionStateProvider,
) {
  return {
    name: "session_get_state",
    label: "Session Get State",
    description: "Prepare the current user's isolated business-platform browser session state.",
    parameters: SESSION_GET_STATE_PARAMETERS,
    execute: async (rawParams: unknown): Promise<ModelSessionState> => {
      const context = trustedContext(toolContext);
      const params = stateParams(rawParams);
      return modelSessionState(await service.getState(context, params.skillName));
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

function stateParams(value: unknown): { skillName: string } {
  if (!isRecord(value) || !validStateParamKeys(value) || typeof value.skillName !== "string") {
    throw new SessionManagerError("invalid_arguments");
  }
  const skillName = value.skillName.trim();
  if (!SKILL_PATTERN.test(skillName)) throw new SessionManagerError("invalid_arguments");
  return { skillName };
}

function validStateParamKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "skillName";
}

function modelSessionState(result: SessionStateResult): ModelSessionState {
  return {
    version: result.version,
    status: result.status,
    source: result.source,
    humanUserId: result.humanUserId,
    podId: result.podId,
    agentId: result.agentId,
    skillName: result.skillName,
    platforms: result.platforms,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

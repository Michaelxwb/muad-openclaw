export type SessionErrorCode =
  | "invalid_arguments"
  | "invalid_context"
  | "not_configured"
  | "platform_disabled"
  | "agent_not_active"
  | "credential_service_unavailable"
  | "adapter_failed";

const EXIT_CODES: Record<SessionErrorCode, number> = {
  invalid_arguments: 2,
  invalid_context: 3,
  not_configured: 10,
  platform_disabled: 11,
  credential_service_unavailable: 12,
  adapter_failed: 13,
  agent_not_active: 14,
};

const MESSAGES: Record<SessionErrorCode, string> = {
  invalid_arguments: "invalid session-manager arguments",
  invalid_context: "trusted agent context is unavailable",
  not_configured: "platform credential is not configured",
  platform_disabled: "platform is disabled",
  credential_service_unavailable: "credential service is unavailable",
  adapter_failed: "platform session adapter failed",
  agent_not_active: "agent is not active",
};

export class SessionManagerError extends Error {
  readonly code: SessionErrorCode;
  readonly exitCode: number;
  readonly retryable: boolean;

  constructor(code: SessionErrorCode, retryable = false) {
    super(MESSAGES[code]);
    this.name = "SessionManagerError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.retryable = retryable;
  }
}

export function normalizeSessionError(error: unknown): SessionManagerError {
  if (error instanceof SessionManagerError) return error;
  return new SessionManagerError("credential_service_unavailable", true);
}

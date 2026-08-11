import { PlatformAdapterError, type LoginFailReason } from "./adapters/types.js";

export type SessionErrorCode =
  | "invalid_arguments"
  | "invalid_context"
  | "not_configured"
  | "platform_disabled"
  | "invalid_skill"
  | "platform_not_bound"
  | "agent_not_active"
  | "credential_service_unavailable"
  | "adapter_failed"
  | "browser_apply_failed";

const EXIT_CODES: Record<SessionErrorCode, number> = {
  invalid_arguments: 2,
  invalid_context: 3,
  not_configured: 10,
  platform_disabled: 11,
  invalid_skill: 17,
  platform_not_bound: 16,
  credential_service_unavailable: 12,
  adapter_failed: 13,
  agent_not_active: 14,
  browser_apply_failed: 18,
};

const MESSAGES: Record<SessionErrorCode, string> = {
  invalid_arguments: "invalid session-manager arguments",
  invalid_context: "trusted agent context is unavailable",
  not_configured: "platform credential is not configured",
  platform_disabled: "platform is disabled",
  invalid_skill: "skill is invalid or not available",
  platform_not_bound: "platform is not bound to this Skill",
  credential_service_unavailable: "credential service is unavailable",
  adapter_failed: "platform session adapter failed",
  agent_not_active: "agent is not active",
  browser_apply_failed: "browser session apply failed",
};

export class SessionManagerError extends Error {
  readonly code: SessionErrorCode;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly reason: LoginFailReason;
  readonly businessCode: number | undefined;
  readonly platform: string | undefined;

  constructor(
    code: SessionErrorCode,
    retryable = false,
    reason: LoginFailReason = "unknown",
    message?: string,
    businessCode?: number,
    platform?: string,
  ) {
    super(message ?? MESSAGES[code]);
    this.name = "SessionManagerError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.retryable = retryable;
    this.reason = reason;
    this.businessCode = businessCode;
    this.platform = platform;
  }

  static fromAdapter(error: PlatformAdapterError, platform?: string): SessionManagerError {
    return new SessionManagerError(
      "adapter_failed",
      error.retryable,
      error.reason,
      error.message,
      error.businessCode,
      platform,
    );
  }
}

export function normalizeSessionError(error: unknown): SessionManagerError {
  if (error instanceof SessionManagerError) return error;
  return new SessionManagerError("credential_service_unavailable", true, "unknown");
}

export function withSessionErrorPlatform(
  error: SessionManagerError,
  platform: string,
): SessionManagerError {
  if (error.platform === platform) return error;
  return new SessionManagerError(
    error.code,
    error.retryable,
    error.reason,
    error.message,
    error.businessCode,
    platform,
  );
}

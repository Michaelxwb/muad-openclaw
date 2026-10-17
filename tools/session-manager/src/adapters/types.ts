import type { ScopedCredential } from "../types.js";

export type SameSite = "Strict" | "Lax" | "None";

export type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
};

export type StorageOrigin = {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
};

export type BrowserStorageState = {
  cookies: SessionCookie[];
  origins: StorageOrigin[];
};

export type AdapterSessionState = {
  cookies: SessionCookie[];
  storageState: BrowserStorageState;
  expiresAt: string;
};

export type AdapterRefreshInput = {
  credential: ScopedCredential;
  signal: AbortSignal;
};

export type AdapterValidateInput = AdapterRefreshInput & {
  state: AdapterSessionState;
};

export type RequestProfileCsrf = {
  cookie: string;
  header: string;
};

/**
 * Request-shaping hints written to the skill-scoped session file. The SDK reads
 * this profile to build platform headers; values never go to CLI stdout.
 */
export type PlatformRequestProfile = {
  baseUrl: string;
  hostHeader: Record<string, string>;
  referer?: string;
  csrf: RequestProfileCsrf[];
  staticHeaders: Record<string, string>;
  traceHeader: string | null;
  extraAllowed: boolean;
};

export type PlatformAdapter = {
  readonly platform: string;
  refresh(input: AdapterRefreshInput): Promise<AdapterSessionState>;
  validate?(input: AdapterValidateInput): Promise<boolean>;
  requestProfile?(credential: ScopedCredential): PlatformRequestProfile;
};

export type LoginFailReason =
  | "auth_failed"
  | "params_error"
  | "service_error"
  | "account_locked"
  | "rate_limited"
  | "missing_credential"
  | "network"
  | "unknown";

export class PlatformAdapterError extends Error {
  readonly authenticationFailed: boolean;
  readonly retryable: boolean;
  readonly reason: LoginFailReason;
  readonly businessCode: number | undefined;
  constructor(
    authenticationFailed = false,
    retryable = false,
    reason: LoginFailReason = "unknown",
    message?: string,
    businessCode?: number,
  ) {
    super(message ?? "platform session adapter failed");
    this.name = "PlatformAdapterError";
    this.authenticationFailed = authenticationFailed;
    this.retryable = retryable;
    this.reason = reason;
    this.businessCode = businessCode;
  }
}

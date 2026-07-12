import type { ResolvedCredential } from "../types.js";

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
  credential: ResolvedCredential;
  signal: AbortSignal;
};

export type PlatformAdapter = {
  readonly platform: string;
  refresh(input: AdapterRefreshInput): Promise<AdapterSessionState>;
};

export class PlatformAdapterError extends Error {
  readonly authenticationFailed: boolean;
  readonly retryable: boolean;

  constructor(authenticationFailed = false, retryable = false) {
    super("platform session adapter failed");
    this.name = "PlatformAdapterError";
    this.authenticationFailed = authenticationFailed;
    this.retryable = retryable;
  }
}

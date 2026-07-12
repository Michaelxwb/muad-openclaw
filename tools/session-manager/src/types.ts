import { RESOLVER_PURPOSE, SESSION_MANAGER_VERSION } from "./constants/runtime.js";

export type TrustedContext = {
  agentId: string;
  sessionKey: string;
};

export type ResolveRequest = {
  agentId: string;
  platform: string;
  purpose: typeof RESOLVER_PURPOSE;
};

export type ResolvedCredential = {
  humanUserId: string;
  podId: string;
  agentId: string;
  platform: string;
  credentialFingerprint: string;
  platformConfigFingerprint: string;
  apiKey: string;
  sessionMode: string;
  adapter: string;
  platformConfig: Record<string, unknown>;
};

export type Resolver = {
  resolve(request: ResolveRequest): Promise<ResolvedCredential>;
};

export type SessionStateResult = {
  version: typeof SESSION_MANAGER_VERSION;
  status: "ready";
  source: "cache" | "refresh";
  platform: string;
  cookiesPath: string;
  storageStatePath: string;
  expiresAt: string;
  credentialFingerprint: string;
  platformConfigFingerprint: string;
};

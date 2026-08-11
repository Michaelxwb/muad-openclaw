import { RESOLVER_PURPOSE, SESSION_MANAGER_VERSION } from "./constants/runtime.js";
import type { AdapterSessionState } from "./adapters/types.js";

export type TrustedContext = {
  agentId: string;
  sessionKey: string;
};

export type ResolveRequest = {
  agentId: string;
  skillName: string;
  purpose: typeof RESOLVER_PURPOSE;
};

export type ResolvedPlatformCredential = {
  platform: string;
  credentialFingerprint: string;
  credentials: Record<string, unknown>;
};

/**
 * Full Resolver response: one credential bundle per platform the skill depends on.
 * The Resolver never sets `platform`/`credentialFingerprint`/`credentials` directly;
 * those are scoped per-platform by SessionService when iterating `platforms`.
 */
export type ResolvedCredential = {
  humanUserId: string;
  podId: string;
  agentId: string;
  skillName: string;
  platforms: ResolvedPlatformCredential[];
};

/**
 * Per-platform view of a ResolvedCredential, used by SessionStore and adapters.
 * Carries the scalar `platform`/`credentialFingerprint`/`credentials` they expect.
 */
export type ScopedCredential = {
  humanUserId: string;
  podId: string;
  agentId: string;
  skillName: string;
  platform: string;
  credentialFingerprint: string;
  credentials: Record<string, unknown>;
};

export type Resolver = {
  resolve(request: ResolveRequest): Promise<ResolvedCredential>;
};

export type PlatformSessionSource = "cache" | "refresh";
export type SessionStateSource = PlatformSessionSource | "mixed";

export type BrowserSessionApplyInput = {
  context: TrustedContext;
  credential: ScopedCredential;
  state: AdapterSessionState;
  source: PlatformSessionSource;
};

export type BrowserSessionApplyResult = {
  applied: true;
  profile: string;
};

export type BrowserSessionApplier = {
  apply(input: BrowserSessionApplyInput): Promise<BrowserSessionApplyResult>;
};

export type PlatformSessionState = {
  platform: string;
  source: PlatformSessionSource;
  expiresAt: string;
  credentialFingerprint: string;
  browser?: BrowserSessionApplyResult;
};

export type SessionStateResult = {
  version: typeof SESSION_MANAGER_VERSION;
  status: "ready";
  source: SessionStateSource;
  sessionStateFile: string;
  humanUserId: string;
  podId: string;
  agentId: string;
  skillName: string;
  platforms: PlatformSessionState[];
};

/** One platform's cookie view inside the skill-scoped session file (private cache). */
export type SkillSessionPlatform = {
  platform: string;
  source: PlatformSessionSource;
  expiresAt: string;
  credentialFingerprint: string;
  cookies: AdapterSessionState["cookies"];
  storageState: AdapterSessionState["storageState"];
};

export type SkillSessionInput = {
  agentId: string;
  skillName: string;
  humanUserId: string;
  podId: string;
  platforms: SkillSessionPlatform[];
};

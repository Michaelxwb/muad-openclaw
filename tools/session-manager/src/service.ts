import { AdapterRegistry, createInstalledAdapterRegistry } from "./adapters/registry.js";
import { PlatformAdapterError, type AdapterSessionState } from "./adapters/types.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS, SESSION_MANAGER_VERSION } from "./constants/runtime.js";
import {
  SessionManagerError,
  normalizeSessionError,
  withSessionErrorPlatform,
} from "./errors.js";
import { RefreshLock, type RefreshLockOptions } from "./refresh-lock.js";
import { makeResolveRequest } from "./resolver-client.js";
import { SessionStore, type StoredSession } from "./session-store.js";
import {
  type BrowserSessionApplyResult,
  type BrowserSessionApplier,
  type PlatformSessionState,
  type PlatformSessionSource,
  type ResolvedCredential,
  type ResolvedPlatformCredential,
  type Resolver,
  type ScopedCredential,
  type SessionStateResult,
  type SkillSessionPlatform,
  type TrustedContext,
} from "./types.js";

export type SessionServiceOptions = {
  store?: SessionStore;
  adapters?: AdapterRegistry;
  adapterTimeoutMs?: number;
  lock?: RefreshLockOptions;
  browserApplier?: BrowserSessionApplier;
};

export class SessionService {
  readonly #resolver: Resolver;
  readonly #store: SessionStore;
  readonly #adapters: AdapterRegistry;
  readonly #adapterTimeoutMs: number;
  readonly #lockOptions: RefreshLockOptions;
  readonly #browserApplier: BrowserSessionApplier | undefined;

  constructor(resolver: Resolver, options: SessionServiceOptions = {}) {
    this.#resolver = resolver;
    this.#store = options.store ?? new SessionStore();
    this.#adapters = options.adapters ?? createInstalledAdapterRegistry();
    this.#adapterTimeoutMs = positive(options.adapterTimeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS);
    this.#lockOptions = options.lock ?? {};
    this.#browserApplier = options.browserApplier;
  }

  async getState(
    context: TrustedContext, skillName: string,
  ): Promise<SessionStateResult> {
    const credential = await this.#resolveState(context, skillName);
    validateCredential(credential, context, skillName);
    const perPlatform = await Promise.all(
      credential.platforms.map((platform) => this.#getStateForPlatform(context, credential, platform)),
    );
    const sessionStateFile = await this.#store.writeSkillSession({
      agentId: credential.agentId,
      skillName: credential.skillName,
      humanUserId: credential.humanUserId,
      podId: credential.podId,
      platforms: perPlatform.map((entry) => skillSessionPlatform(entry.state, entry.stored)),
    });
    return {
      version: SESSION_MANAGER_VERSION,
      status: "ready",
      source: aggregateSource(perPlatform.map((entry) => entry.state)),
      sessionStateFile,
      humanUserId: credential.humanUserId,
      podId: credential.podId,
      agentId: credential.agentId,
      skillName: credential.skillName,
      platforms: perPlatform.map((entry) => entry.state),
    };
  }

  async #getStateForPlatform(
    context: TrustedContext, credential: ResolvedCredential, platform: ResolvedPlatformCredential,
  ): Promise<{ state: PlatformSessionState; stored: StoredSession }> {
    const scoped = scopedCredential(credential, platform);
    const cached = await this.#store.read(scoped);
    if (cached && await this.#cacheIsValid(scoped, cached)) {
      return { state: await this.#platformState(context, scoped, cached, "cache"), stored: cached };
    }
    const paths = this.#store.paths(scoped.agentId, scoped.platform);
    await this.#store.ensureDirectory(paths);
    const lock = new RefreshLock(paths.refreshLock, this.#lockOptions);
    const resolved = await lock.run<{ stored: StoredSession; source: "cache" | "refresh" }>(
      async () => {
        const stored = await this.#store.read(scoped);
        return stored ? { stored, source: "cache" as const } : null;
      },
      async () => ({ stored: await this.#refresh(scoped), source: "refresh" as const }),
    );
    return {
      state: await this.#platformState(context, scoped, resolved.stored, resolved.source),
      stored: resolved.stored,
    };
  }

  async #resolve(context: TrustedContext, skillName: string): Promise<ResolvedCredential> {
    try {
      return await this.#resolver.resolve(makeResolveRequest(context.agentId, skillName));
    } catch (error) {
      throw normalizeSessionError(error);
    }
  }

  async #resolveState(context: TrustedContext, skillName: string): Promise<ResolvedCredential> {
    try {
      return await this.#resolve(context, skillName);
    } catch (error) {
      // Definitive authorization/config failures mean this skill can no longer
      // hold a session here; drop the stale cookie-bearing output file instead
      // of leaving it readable. Transient/unknown errors keep it (retry may pass).
      if (!(error instanceof SessionManagerError) || !error.retryable) {
        await this.#store.deleteSkillSession(context.agentId, skillName);
      }
      throw error;
    }
  }

  async #refresh(credential: ScopedCredential): Promise<StoredSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#adapterTimeoutMs);
    try {
      const adapter = this.#adapters.get(credential.platform);
      if (adapter.platform !== credential.platform) throw new PlatformAdapterError();
      const state = await adapter.refresh({ credential, signal: controller.signal });
      validateAdapterState(state);
      return await this.#store.write(credential, state);
    } catch (error) {
      if (error instanceof PlatformAdapterError) {
        if (error.authenticationFailed) {
          await this.#store.clear(credential.agentId, credential.platform);
        }
        throw SessionManagerError.fromAdapter(error, credential.platform);
      }
      if (error instanceof SessionManagerError) throw withSessionErrorPlatform(error, credential.platform);
      throw new SessionManagerError(
        "adapter_failed",
        true,
        "network",
        "platform network request failed",
        undefined,
        credential.platform,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #cacheIsValid(credential: ScopedCredential, cached: StoredSession): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#adapterTimeoutMs);
    try {
      const adapter = this.#adapters.get(credential.platform);
      if (adapter.platform !== credential.platform) throw new PlatformAdapterError();
      if (typeof adapter.validate !== "function") return true;
      const valid = await adapter.validate({ credential, state: cached.state, signal: controller.signal });
      if (valid) return true;
      await this.#store.clear(credential.agentId, credential.platform);
      return false;
    } catch (error) {
      if (error instanceof PlatformAdapterError) {
        if (error.retryable && !error.authenticationFailed) return true;
        if (error.authenticationFailed) {
          await this.#store.clear(credential.agentId, credential.platform);
          return false;
        }
        throw SessionManagerError.fromAdapter(error, credential.platform);
      }
      if (error instanceof SessionManagerError) throw withSessionErrorPlatform(error, credential.platform);
      throw new SessionManagerError(
        "adapter_failed",
        true,
        "network",
        "platform network request failed",
        undefined,
        credential.platform,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #platformState(
    context: TrustedContext,
    credential: ScopedCredential,
    stored: StoredSession,
    source: PlatformSessionSource,
  ): Promise<PlatformSessionState> {
    const browser = await this.#applyBrowserSession(context, credential, stored, source);
    return platformState(credential, stored, source, browser);
  }

  async #applyBrowserSession(
    context: TrustedContext,
    credential: ScopedCredential,
    stored: StoredSession,
    source: PlatformSessionSource,
  ): Promise<BrowserSessionApplyResult | undefined> {
    if (!this.#browserApplier) return undefined;
    try {
      return await this.#browserApplier.apply({ context, credential, state: stored.state, source });
    } catch (error) {
      if (error instanceof SessionManagerError) {
        const sessionError = withSessionErrorPlatform(error, credential.platform);
        if (sessionError.code === "browser_apply_failed" && sessionError.retryable) return undefined;
        throw sessionError;
      }
      throw new SessionManagerError(
        "browser_apply_failed",
        true,
        "service_error",
        "browser session apply failed",
        undefined,
        credential.platform,
      );
    }
  }
}

function scopedCredential(
  credential: ResolvedCredential, platform: ResolvedPlatformCredential,
): ScopedCredential {
  return {
    humanUserId: credential.humanUserId,
    podId: credential.podId,
    agentId: credential.agentId,
    skillName: credential.skillName,
    platform: platform.platform,
    credentialFingerprint: platform.credentialFingerprint,
    credentials: platform.credentials,
  };
}

function validateCredential(
  credential: ResolvedCredential, context: TrustedContext, skillName: string,
): void {
  if (credential.agentId !== context.agentId || credential.skillName !== skillName ||
    !credential.humanUserId || !credential.podId ||
    !Array.isArray(credential.platforms) || credential.platforms.length === 0) {
    throw new SessionManagerError("credential_service_unavailable", true);
  }
  for (const platform of credential.platforms) {
    if (!platform.platform || !platform.credentialFingerprint || !isRecord(platform.credentials)) {
      throw new SessionManagerError("credential_service_unavailable", true);
    }
  }
}

function validateAdapterState(state: AdapterSessionState): void {
  const expiresAt = Date.parse(state.expiresAt);
  if (!Array.isArray(state.cookies) || !state.storageState ||
    !Array.isArray(state.storageState.cookies) || !Array.isArray(state.storageState.origins) ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new PlatformAdapterError();
  }
}

function platformState(
  credential: ScopedCredential,
  stored: StoredSession,
  source: PlatformSessionSource,
  browser: BrowserSessionApplyResult | undefined,
): PlatformSessionState {
  const state: PlatformSessionState = {
    platform: credential.platform,
    source,
    expiresAt: stored.meta.expiresAt,
    credentialFingerprint: credential.credentialFingerprint,
  };
  if (browser) state.browser = browser;
  return state;
}

function skillSessionPlatform(
  state: PlatformSessionState, stored: StoredSession,
): SkillSessionPlatform {
  return {
    platform: state.platform,
    source: state.source,
    expiresAt: state.expiresAt,
    credentialFingerprint: state.credentialFingerprint,
    cookies: stored.state.cookies,
    storageState: stored.state.storageState,
  };
}

function aggregateSource(platforms: PlatformSessionState[]): "cache" | "refresh" | "mixed" {
  const first = platforms.at(0)?.source ?? "cache";
  return platforms.every((entry) => entry.source === first) ? first : "mixed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

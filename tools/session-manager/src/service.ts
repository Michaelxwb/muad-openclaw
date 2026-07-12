import { AdapterRegistry, createInstalledAdapterRegistry } from "./adapters/registry.js";
import { PlatformAdapterError, type AdapterSessionState } from "./adapters/types.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS, SESSION_MANAGER_VERSION } from "./constants/runtime.js";
import { SessionManagerError, normalizeSessionError } from "./errors.js";
import { RefreshLock, type RefreshLockOptions } from "./refresh-lock.js";
import { makeResolveRequest } from "./resolver-client.js";
import { SessionStore, type StoredSession } from "./session-store.js";
import {
  type ResolvedCredential,
  type Resolver,
  type SessionStateResult,
  type TrustedContext,
} from "./types.js";

export type SessionServiceOptions = {
  store?: SessionStore;
  adapters?: AdapterRegistry;
  adapterTimeoutMs?: number;
  lock?: RefreshLockOptions;
};

export class SessionService {
  readonly #resolver: Resolver;
  readonly #store: SessionStore;
  readonly #adapters: AdapterRegistry;
  readonly #adapterTimeoutMs: number;
  readonly #lockOptions: RefreshLockOptions;

  constructor(resolver: Resolver, options: SessionServiceOptions = {}) {
    this.#resolver = resolver;
    this.#store = options.store ?? new SessionStore();
    this.#adapters = options.adapters ?? createInstalledAdapterRegistry();
    this.#adapterTimeoutMs = positive(options.adapterTimeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS);
    this.#lockOptions = options.lock ?? {};
  }

  async getState(context: TrustedContext, platform: string): Promise<SessionStateResult> {
    const credential = await this.#resolve(context, platform);
    validateCredential(credential, context, platform);
    const cached = await this.#store.read(credential);
    if (cached) return stateResult(cached, credential, "cache");
    const paths = this.#store.paths(credential.agentId, credential.platform);
    await this.#store.ensureDirectory(paths);
    const lock = new RefreshLock(paths.lock, this.#lockOptions);
    const resolved = await lock.run<{ stored: StoredSession; source: "cache" | "refresh" }>(
      async () => {
        const stored = await this.#store.read(credential);
        return stored ? { stored, source: "cache" as const } : null;
      },
      async () => ({ stored: await this.#refresh(credential), source: "refresh" as const }),
    );
    return stateResult(resolved.stored, credential, resolved.source);
  }

  async #resolve(context: TrustedContext, platform: string): Promise<ResolvedCredential> {
    try {
      return await this.#resolver.resolve(makeResolveRequest(context.agentId, platform));
    } catch (error) {
      const normalized = normalizeSessionError(error);
      if (invalidatesCache(normalized)) await this.#store.clear(context.agentId, platform);
      throw normalized;
    }
  }

  async #refresh(credential: ResolvedCredential): Promise<StoredSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#adapterTimeoutMs);
    try {
      const adapter = this.#adapters.get(credential.adapter);
      if (adapter.platform !== credential.platform) throw new PlatformAdapterError();
      const state = await adapter.refresh({ credential, signal: controller.signal });
      validateAdapterState(state);
      return await this.#store.write(credential, state);
    } catch (error) {
      if (error instanceof PlatformAdapterError && error.authenticationFailed) {
        await this.#store.clear(credential.agentId, credential.platform);
      }
      if (error instanceof SessionManagerError) throw error;
      const retryable = error instanceof PlatformAdapterError && error.retryable;
      throw new SessionManagerError("adapter_failed", retryable);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateCredential(
  credential: ResolvedCredential,
  context: TrustedContext,
  platform: string,
): void {
  if (credential.agentId !== context.agentId || credential.platform !== platform ||
    !credential.humanUserId || !credential.podId || !credential.apiKey ||
    !credential.credentialFingerprint || !credential.platformConfigFingerprint ||
    credential.adapter !== platform || !isSessionMode(credential.sessionMode)) {
    throw new SessionManagerError("credential_service_unavailable", true);
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

function stateResult(
  stored: StoredSession,
  credential: ResolvedCredential,
  source: "cache" | "refresh",
): SessionStateResult {
  return {
    version: SESSION_MANAGER_VERSION,
    status: "ready",
    source,
    platform: credential.platform,
    cookiesPath: stored.paths.cookies,
    storageStatePath: stored.paths.storageState,
    expiresAt: stored.meta.expiresAt,
    credentialFingerprint: credential.credentialFingerprint,
    platformConfigFingerprint: credential.platformConfigFingerprint,
  };
}

function invalidatesCache(error: SessionManagerError): boolean {
  return error.code === "not_configured" || error.code === "platform_disabled" ||
    error.code === "agent_not_active";
}

function isSessionMode(value: string): boolean {
  return value === "cookie" || value === "storage_state";
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AdapterSessionState } from "./adapters/types.js";
import { AGENT_PATTERN, DEFAULT_AGENTS_ROOT, PLATFORM_PATTERN, SESSION_MANAGER_VERSION } from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { ResolvedCredential } from "./types.js";

export type SessionPaths = {
  directory: string;
  cookies: string;
  storageState: string;
  meta: string;
  lock: string;
};

export type SessionMeta = {
  version: typeof SESSION_MANAGER_VERSION;
  humanUserId: string;
  agentId: string;
  podId: string;
  platform: string;
  credentialFingerprint: string;
  expiresAt: string;
  source: "refresh";
  updatedAt: string;
};

export type StoredSession = {
  paths: SessionPaths;
  meta: SessionMeta;
  state: AdapterSessionState;
};

export type SessionStoreOptions = {
  rootDir?: string;
  now?: () => number;
};

export class SessionStore {
  readonly #rootDir: string;
  readonly #now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.#rootDir = resolve(options.rootDir ?? DEFAULT_AGENTS_ROOT);
    this.#now = options.now ?? Date.now;
  }

  paths(agentId: string, platform: string): SessionPaths {
    if (!AGENT_PATTERN.test(agentId) || !PLATFORM_PATTERN.test(platform)) {
      throw new SessionManagerError("invalid_context");
    }
    const directory = resolve(this.#rootDir, agentId, "session-store", platform, "default");
    return {
      directory,
      cookies: resolve(directory, "cookies.json"),
      storageState: resolve(directory, "storageState.json"),
      meta: resolve(directory, "meta.json"),
      lock: resolve(directory, "refresh.lock"),
    };
  }

  async ensureDirectory(paths: SessionPaths): Promise<void> {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  }

  async read(credential: ResolvedCredential): Promise<StoredSession | null> {
    const paths = this.paths(credential.agentId, credential.platform);
    const meta = await readJSON(paths.meta);
    if (!isSessionMeta(meta) || !this.#matches(meta, credential)) return null;
    const expiresAt = Date.parse(meta.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) return null;
    const state = await readStoredState(paths, meta.expiresAt);
    if (!state) return null;
    return { paths, meta, state };
  }

  async write(credential: ResolvedCredential, state: AdapterSessionState): Promise<StoredSession> {
    const paths = this.paths(credential.agentId, credential.platform);
    const expiresAt = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now() ||
      credentialSecrets(credential).some((secret) => containsSecret(state, secret))) {
      throw new SessionManagerError("adapter_failed");
    }
    await this.ensureDirectory(paths);
    await rm(paths.meta, { force: true });
    await atomicWrite(paths.cookies, state.cookies);
    await atomicWrite(paths.storageState, state.storageState);
    const meta = makeMeta(credential, new Date(this.#now()).toISOString(), state.expiresAt);
    await atomicWrite(paths.meta, meta);
    return { paths, meta, state };
  }

  async clear(agentId: string, platform: string): Promise<void> {
    const paths = this.paths(agentId, platform);
    await Promise.all([
      rm(paths.cookies, { force: true }),
      rm(paths.storageState, { force: true }),
      rm(paths.meta, { force: true }),
    ]);
  }

  #matches(meta: SessionMeta, credential: ResolvedCredential): boolean {
    return meta.version === SESSION_MANAGER_VERSION && meta.humanUserId === credential.humanUserId &&
      meta.agentId === credential.agentId && meta.podId === credential.podId &&
      meta.platform === credential.platform &&
      meta.credentialFingerprint === credential.credentialFingerprint;
  }
}

function makeMeta(credential: ResolvedCredential, updatedAt: string, expiresAt: string): SessionMeta {
  return {
    version: SESSION_MANAGER_VERSION,
    humanUserId: credential.humanUserId,
    agentId: credential.agentId,
    podId: credential.podId,
    platform: credential.platform,
    credentialFingerprint: credential.credentialFingerprint,
    expiresAt,
    source: "refresh",
    updatedAt,
  };
}

async function readStoredState(
  paths: SessionPaths, expiresAt: string,
): Promise<AdapterSessionState | null> {
  const [cookies, storageState] = await Promise.all([readJSON(paths.cookies), readJSON(paths.storageState)]);
  if (!Array.isArray(cookies) || !isRecord(storageState) || !Array.isArray(storageState.cookies) ||
    !Array.isArray(storageState.origins)) return null;
  try {
    const [cookiesStat, storageStat] = await Promise.all([stat(paths.cookies), stat(paths.storageState)]);
    if (!cookiesStat.isFile() || !storageStat.isFile()) return null;
    return { cookies: cookies as AdapterSessionState["cookies"],
      storageState: storageState as AdapterSessionState["storageState"], expiresAt };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readJSON(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  if (typeof value === "string") return value === secret || (secret.length >= 8 && value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  if (isRecord(value)) return Object.values(value).some((item) => containsSecret(item, secret));
  return false;
}

function credentialSecrets(credential: ResolvedCredential): string[] {
  const values: string[] = [];
  collectCredentialSecrets(credential.credentials, "", values);
  return values.filter((value) => value.length >= 8);
}

function collectCredentialSecrets(value: unknown, key: string, out: string[]): void {
  if (typeof value === "string") {
    if (isSensitiveCredentialKey(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialSecrets(item, key, out);
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, item] of Object.entries(value)) collectCredentialSecrets(item, childKey, out);
  }
}

function isSensitiveCredentialKey(key: string): boolean {
  const normalized = key.replace(/[-_]/gu, "").toLowerCase();
  return normalized === "ak" || normalized === "sk" || normalized === "apikey" ||
    normalized.endsWith("secret") || normalized.endsWith("token") ||
    normalized.endsWith("password") || normalized.endsWith("cookie");
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!isRecord(value)) return false;
  return value.version === SESSION_MANAGER_VERSION && value.source === "refresh" &&
    ["humanUserId", "agentId", "podId", "platform", "credentialFingerprint",
      "expiresAt", "updatedAt"].every((key) => typeof value[key] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

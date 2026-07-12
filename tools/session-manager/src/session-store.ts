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
  platformConfigFingerprint: string;
  expiresAt: string;
  source: "refresh";
  updatedAt: string;
};

export type StoredSession = {
  paths: SessionPaths;
  meta: SessionMeta;
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
    if (!await validStateFiles(paths)) return null;
    return { paths, meta };
  }

  async write(credential: ResolvedCredential, state: AdapterSessionState): Promise<StoredSession> {
    const paths = this.paths(credential.agentId, credential.platform);
    const expiresAt = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now() || containsSecret(state, credential.apiKey)) {
      throw new SessionManagerError("adapter_failed");
    }
    await this.ensureDirectory(paths);
    await rm(paths.meta, { force: true });
    await atomicWrite(paths.cookies, state.cookies);
    await atomicWrite(paths.storageState, state.storageState);
    const meta = makeMeta(credential, new Date(this.#now()).toISOString(), state.expiresAt);
    await atomicWrite(paths.meta, meta);
    return { paths, meta };
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
      meta.credentialFingerprint === credential.credentialFingerprint &&
      meta.platformConfigFingerprint === credential.platformConfigFingerprint;
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
    platformConfigFingerprint: credential.platformConfigFingerprint,
    expiresAt,
    source: "refresh",
    updatedAt,
  };
}

async function validStateFiles(paths: SessionPaths): Promise<boolean> {
  const [cookies, storageState] = await Promise.all([readJSON(paths.cookies), readJSON(paths.storageState)]);
  if (!Array.isArray(cookies) || !isRecord(storageState) || !Array.isArray(storageState.cookies) ||
    !Array.isArray(storageState.origins)) return false;
  try {
    const [cookiesStat, storageStat] = await Promise.all([stat(paths.cookies), stat(paths.storageState)]);
    return cookiesStat.isFile() && storageStat.isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
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

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!isRecord(value)) return false;
  return value.version === SESSION_MANAGER_VERSION && value.source === "refresh" &&
    ["humanUserId", "agentId", "podId", "platform", "credentialFingerprint",
      "platformConfigFingerprint", "expiresAt", "updatedAt"].every((key) => typeof value[key] === "string");
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

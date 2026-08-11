import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AdapterSessionState } from "./adapters/types.js";
import {
  AGENT_PATTERN,
  DEFAULT_AGENTS_ROOT,
  PLATFORM_PATTERN,
  SESSION_MANAGER_VERSION,
  SKILL_PATTERN,
} from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import { RefreshLock, type RefreshLockOptions } from "./refresh-lock.js";
import type { ScopedCredential, SkillSessionInput } from "./types.js";

export type SessionPaths = {
  directory: string;
  bundle: string;
  lock: string;
  refreshLock: string;
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
  lock?: RefreshLockOptions;
};

type BundleFile = {
  version: typeof SESSION_MANAGER_VERSION;
  platforms: Record<string, unknown>;
};

type BundlePlatformSession = {
  humanUserId: string;
  agentId: string;
  podId: string;
  platform: string;
  credentialFingerprint: string;
  expiresAt: string;
  source: "refresh";
  updatedAt: string;
  cookies: AdapterSessionState["cookies"];
  storageState: AdapterSessionState["storageState"];
};

export class SessionStore {
  readonly #rootDir: string;
  readonly #now: () => number;
  readonly #lockOptions: RefreshLockOptions;

  constructor(options: SessionStoreOptions = {}) {
    this.#rootDir = resolve(options.rootDir ?? DEFAULT_AGENTS_ROOT);
    this.#now = options.now ?? Date.now;
    this.#lockOptions = options.lock ?? {};
  }

  paths(agentId: string, platform: string): SessionPaths {
    if (!AGENT_PATTERN.test(agentId) || !PLATFORM_PATTERN.test(platform)) {
      throw new SessionManagerError("invalid_context");
    }
    const directory = resolve(this.#rootDir, agentId, "session-store");
    return {
      directory,
      bundle: resolve(directory, "bundle.json"),
      lock: resolve(directory, "bundle.lock"),
      refreshLock: resolve(directory, `${platform}.refresh.lock`),
    };
  }

  bundlePath(agentId: string): string {
    if (!AGENT_PATTERN.test(agentId)) throw new SessionManagerError("invalid_context");
    return resolve(this.#rootDir, agentId, "session-store", "bundle.json");
  }

  skillSessionPath(agentId: string, skillName: string): string {
    if (!AGENT_PATTERN.test(agentId) || !SKILL_PATTERN.test(skillName)) {
      throw new SessionManagerError("invalid_context");
    }
    return resolve(this.#rootDir, agentId, "session-store", `${skillName}.session.json`);
  }

  async writeSkillSession(input: SkillSessionInput): Promise<string> {
    const file = this.skillSessionPath(input.agentId, input.skillName);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, {
      version: SESSION_MANAGER_VERSION,
      agentId: input.agentId,
      skillName: input.skillName,
      humanUserId: input.humanUserId,
      podId: input.podId,
      platforms: Object.fromEntries(input.platforms.map((entry) => [entry.platform, entry])),
    });
    return file;
  }

  async ensureDirectory(paths: SessionPaths): Promise<void> {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  }

  async deleteSkillSession(agentId: string, skillName: string): Promise<void> {
    const file = this.skillSessionPath(agentId, skillName);
    try {
      await unlink(file);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async read(credential: ScopedCredential): Promise<StoredSession | null> {
    const paths = this.paths(credential.agentId, credential.platform);
    const bundle = await this.#readBundle(paths.bundle);
    const section = bundle?.platforms[credential.platform];
    if (!isBundleSession(section)) return null;
    const meta = sectionMeta(credential.platform, section);
    if (!this.#matches(meta, credential)) return null;
    const expiresAt = Date.parse(meta.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) return null;
    const state = sectionState(section, meta.expiresAt);
    if (!state) return null;
    return { paths, meta, state };
  }

  async write(credential: ScopedCredential, state: AdapterSessionState): Promise<StoredSession> {
    const paths = this.paths(credential.agentId, credential.platform);
    const expiresAt = Date.parse(state.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#now() ||
      credentialSecrets(credential).some((secret) => containsSecret(state, secret))) {
      throw new SessionManagerError("adapter_failed");
    }
    await this.ensureDirectory(paths);
    const lock = new RefreshLock(paths.lock, this.#lockOptions);
    return lock.run<StoredSession>(
      () => Promise.resolve(null),
      async () => {
        const bundle = await this.#readBundle(paths.bundle) ?? emptyBundle();
        const updatedAt = new Date(this.#now()).toISOString();
        bundle.platforms[credential.platform] = makeSection(credential, updatedAt, state);
        await atomicWrite(paths.bundle, bundle);
        return { paths, meta: makeMeta(credential, updatedAt, state.expiresAt), state };
      },
    );
  }

  async clear(agentId: string, platform: string): Promise<void> {
    const paths = this.paths(agentId, platform);
    const lock = new RefreshLock(paths.lock, this.#lockOptions);
    await lock.run<null>(
      () => Promise.resolve(null),
      async () => {
        const bundle = await this.#readBundle(paths.bundle);
        if (!bundle || !bundle.platforms[platform]) return null;
        delete bundle.platforms[platform];
        await atomicWrite(paths.bundle, bundle);
        return null;
      },
    );
  }

  #matches(meta: SessionMeta, credential: ScopedCredential): boolean {
    return meta.version === SESSION_MANAGER_VERSION && meta.humanUserId === credential.humanUserId &&
      meta.agentId === credential.agentId && meta.podId === credential.podId &&
      meta.platform === credential.platform &&
      meta.credentialFingerprint === credential.credentialFingerprint;
  }

  async #readBundle(bundlePath: string): Promise<BundleFile | null> {
    const value = await readJSON(bundlePath);
    return isBundleFile(value) ? value : null;
  }
}

function makeMeta(credential: ScopedCredential, updatedAt: string, expiresAt: string): SessionMeta {
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

function makeSection(
  credential: ScopedCredential, updatedAt: string, state: AdapterSessionState,
): BundlePlatformSession {
  return {
    humanUserId: credential.humanUserId,
    agentId: credential.agentId,
    podId: credential.podId,
    platform: credential.platform,
    credentialFingerprint: credential.credentialFingerprint,
    expiresAt: state.expiresAt,
    source: "refresh",
    updatedAt,
    cookies: state.cookies,
    storageState: state.storageState,
  };
}

function sectionMeta(platform: string, section: BundlePlatformSession): SessionMeta {
  return {
    version: SESSION_MANAGER_VERSION,
    humanUserId: section.humanUserId,
    agentId: section.agentId,
    podId: section.podId,
    platform,
    credentialFingerprint: section.credentialFingerprint,
    expiresAt: section.expiresAt,
    source: "refresh",
    updatedAt: section.updatedAt,
  };
}

function sectionState(section: BundlePlatformSession, expiresAt: string): AdapterSessionState | null {
  return {
    cookies: section.cookies,
    storageState: section.storageState,
    expiresAt,
  };
}

function emptyBundle(): BundleFile {
  return { version: SESSION_MANAGER_VERSION, platforms: {} };
}

function isBundleFile(value: unknown): value is BundleFile {
  return isRecord(value) && value.version === SESSION_MANAGER_VERSION && isRecord(value.platforms);
}

function isBundleSession(value: unknown): value is BundlePlatformSession {
  if (!isRecord(value)) return false;
  return value.source === "refresh" &&
    ["humanUserId", "agentId", "podId", "platform", "credentialFingerprint",
      "expiresAt", "updatedAt"].every((key) => typeof value[key] === "string") &&
    Array.isArray(value.cookies) && isRecord(value.storageState) &&
    Array.isArray(value.storageState.cookies) && Array.isArray(value.storageState.origins);
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

function credentialSecrets(credential: ScopedCredential): string[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

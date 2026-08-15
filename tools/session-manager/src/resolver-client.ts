import { readFile } from "node:fs/promises";

import {
  DEFAULT_RESOLVER_TIMEOUT_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_JITTER_MS,
  MAX_RESOLVER_RESPONSE_BYTES,
  RESOLVER_PATH,
  RESOLVER_PURPOSE,
  SERVICE_TOKEN_FILE,
} from "./constants/runtime.js";
import { SessionManagerError, normalizeSessionError } from "./errors.js";
import {
  type ResolveRequest,
  type ResolvedCredential,
  type ResolvedPlatformCredential,
  type Resolver,
} from "./types.js";

export { SERVICE_TOKEN_FILE } from "./constants/runtime.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ResolverClientOptions = {
  baseURL: string;
  timeoutMs?: number;
  retryBaseMs?: number;
  retryJitterMs?: number;
  fetch?: FetchLike;
  readToken?: (path: string) => Promise<string>;
  sleep?: (durationMs: number) => Promise<void>;
  random?: () => number;
};

type ResolverEnvelope = {
  code: number;
  data?: unknown;
};

export class ResolverClient implements Resolver {
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #retryJitterMs: number;
  readonly #fetch: FetchLike;
  readonly #readToken: (path: string) => Promise<string>;
  readonly #sleep: (durationMs: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: ResolverClientOptions) {
    this.#url = resolverURL(options.baseURL);
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_RESOLVER_TIMEOUT_MS);
    this.#retryBaseMs = nonNegative(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
    this.#retryJitterMs = nonNegative(options.retryJitterMs, DEFAULT_RETRY_JITTER_MS);
    this.#fetch = options.fetch ?? fetch;
    this.#readToken = options.readToken ?? ((path) => readFile(path, "utf8"));
    this.#sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.#random = options.random ?? Math.random;
  }

  async resolve(request: ResolveRequest): Promise<ResolvedCredential> {
    const token = await this.#serviceToken();
    let lastError = new SessionManagerError("credential_service_unavailable", true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#requestOnce(request, token);
      } catch (error) {
        lastError = normalizeSessionError(error);
        if (!lastError.retryable || attempt === 1) throw lastError;
        await this.#sleep(this.#retryBaseMs + Math.floor(this.#random() * this.#retryJitterMs));
      }
    }
    throw lastError;
  }

  async #serviceToken(): Promise<string> {
    try {
      const token = (await this.#readToken(SERVICE_TOKEN_FILE)).trim();
      if (token) return token;
    } catch {
      throw new SessionManagerError("credential_service_unavailable", true);
    }
    throw new SessionManagerError("credential_service_unavailable", true);
  }

  async #requestOnce(request: ResolveRequest, token: string): Promise<ResolvedCredential> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return await readResolverResponse(response, request);
    } catch (error) {
      throw normalizeSessionError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readResolverResponse(response: Response, request: ResolveRequest): Promise<ResolvedCredential> {
  const text = await response.text();
  if (text.length > MAX_RESOLVER_RESPONSE_BYTES) {
    throw new SessionManagerError("credential_service_unavailable", true);
  }
  const envelope = parseEnvelope(text);
  if (!response.ok || envelope.code !== 0) throw resolverHTTPError(response.status, envelope.code);
  return parseCredential(envelope.data, request);
}

function parseEnvelope(text: string): ResolverEnvelope {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.code === "number") {
      return { code: value.code, ...(value.data === undefined ? {} : { data: value.data }) };
    }
  } catch {
    throw new SessionManagerError("credential_service_unavailable", true);
  }
  throw new SessionManagerError("credential_service_unavailable", true);
}

function resolverHTTPError(status: number, code: number): SessionManagerError {
  if (code === 40001) return new SessionManagerError("invalid_context");
  if (code === 40514) return new SessionManagerError("platform_not_bound");
  if (code === 40527) return new SessionManagerError("invalid_skill");
  if (code === 40606) return new SessionManagerError("not_configured");
  if (code === 40605) return new SessionManagerError("platform_disabled");
  if (code === 40901) return new SessionManagerError("agent_not_active");
  if (status === 400) return new SessionManagerError("invalid_context");
  return new SessionManagerError("credential_service_unavailable", status >= 500 || status === 401 || status === 429);
}

function parseCredential(value: unknown, request: ResolveRequest): ResolvedCredential {
  if (!isRecord(value)) throw unavailable();
  const credential: ResolvedCredential = {
    humanUserId: requiredString(value.humanUserId),
    podId: requiredString(value.podId),
    agentId: requiredString(value.agentId),
    skillName: requiredString(value.skillName),
    platforms: parsePlatforms(value.platforms),
  };
  // 归属校验（本地防线）：resolver 返回的凭据必须与请求 agent/skill 一致，否则视为
  // 服务端异常。服务端（console）另按 pod 校验 agent 归属；pod 内跨 agent 的密钥伪造
  // 需要 per-agent 证明（控制面侧变更），本地无法阻止，见 config.ts 的说明。
  if (credential.agentId !== request.agentId || credential.skillName !== request.skillName) throw unavailable();
  return credential;
}

function parsePlatforms(value: unknown): ResolvedPlatformCredential[] {
  if (!Array.isArray(value) || value.length === 0) throw unavailable();
  const seen = new Set<string>();
  const platforms: ResolvedPlatformCredential[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) throw unavailable();
    const platform = requiredString(entry.platform);
    const credentialFingerprint = requiredString(entry.credentialFingerprint);
    if (!isRecord(entry.credentials)) throw unavailable();
    if (seen.has(platform)) throw unavailable();
    seen.add(platform);
    platforms.push({ platform, credentialFingerprint, credentials: entry.credentials });
  }
  return platforms;
}

function resolverURL(baseURL: string): URL {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new SessionManagerError("invalid_context");
  }
  const root = url.pathname.replace(/\/+$/, "");
  const internalRoot = root.endsWith("/internal/v1") ? root : `${root}/internal/v1`;
  url.pathname = `${internalRoot}${RESOLVER_PATH.replace("/internal/v1", "")}`;
  url.search = "";
  url.hash = "";
  return url;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw unavailable();
  return value;
}

function unavailable(): SessionManagerError {
  return new SessionManagerError("credential_service_unavailable", true);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function makeResolveRequest(agentId: string, skillName: string): ResolveRequest {
  return {
    agentId,
    skillName,
    purpose: RESOLVER_PURPOSE,
  };
}

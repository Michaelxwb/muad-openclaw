import {
  type AdapterRefreshInput,
  type AdapterSessionState,
  type BrowserStorageState,
  PlatformAdapterError,
  type PlatformAdapter,
  type SameSite,
  type SessionCookie,
  type StorageOrigin,
} from "./types.js";

const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MAX_ADAPTER_RESPONSE_BYTES = 1024 * 1024;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class HTTPSessionAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly #fetch: FetchLike;

  constructor(platform: string, fetchLike: FetchLike = fetch) {
    this.platform = platform;
    this.#fetch = fetchLike;
  }

  async refresh(input: AdapterRefreshInput): Promise<AdapterSessionState> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    try {
      const response = await this.#fetch(sessionURL(input.credential.platformConfig), {
        method: "POST",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.credential.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionMode: input.credential.sessionMode }),
      });
      return await readSessionResponse(response, input.credential.platformConfig);
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true);
    }
  }
}

async function readSessionResponse(
  response: Response,
  config: Record<string, unknown>,
): Promise<AdapterSessionState> {
  if (response.status === 401 || response.status === 403) throw new PlatformAdapterError(true);
  if (!response.ok) throw new PlatformAdapterError(false, response.status >= 500 || response.status === 429);
  const text = await response.text();
  if (text.length > MAX_ADAPTER_RESPONSE_BYTES) throw new PlatformAdapterError();
  const payload = sessionPayload(text);
  const storageState = parseStorageState(payload.storageState);
  const cookies = parseCookies(payload.cookies ?? storageState?.cookies);
  const normalized = storageState ?? { cookies, origins: [] };
  if (cookies.length === 0 && normalized.origins.length === 0) throw new PlatformAdapterError();
  return {
    cookies,
    storageState: { cookies, origins: normalized.origins },
    expiresAt: sessionExpiry(payload.expiresAt, config),
  };
}

function sessionPayload(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new PlatformAdapterError();
    const data = parsed.data;
    return isRecord(data) ? data : parsed;
  } catch (error) {
    if (error instanceof PlatformAdapterError) throw error;
    throw new PlatformAdapterError();
  }
}

function parseStorageState(value: unknown): BrowserStorageState | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new PlatformAdapterError();
  return {
    cookies: parseCookies(value.cookies),
    origins: parseOrigins(value.origins),
  };
}

function parseCookies(value: unknown): SessionCookie[] {
  if (!Array.isArray(value)) throw new PlatformAdapterError();
  return value.map(parseCookie);
}

function parseCookie(value: unknown): SessionCookie {
  if (!isRecord(value)) throw new PlatformAdapterError();
  const cookie: SessionCookie = {
    name: requiredString(value.name), value: requiredString(value.value),
    domain: requiredString(value.domain), path: requiredString(value.path),
  };
  if (typeof value.expires === "number" && Number.isFinite(value.expires)) cookie.expires = value.expires;
  if (typeof value.httpOnly === "boolean") cookie.httpOnly = value.httpOnly;
  if (typeof value.secure === "boolean") cookie.secure = value.secure;
  if (isSameSite(value.sameSite)) cookie.sameSite = value.sameSite;
  return cookie;
}

function parseOrigins(value: unknown): StorageOrigin[] {
  if (!Array.isArray(value)) throw new PlatformAdapterError();
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.localStorage)) throw new PlatformAdapterError();
    return {
      origin: requiredString(entry.origin),
      localStorage: entry.localStorage.map((item) => {
        if (!isRecord(item)) throw new PlatformAdapterError();
        return { name: requiredString(item.name), value: requiredString(item.value) };
      }),
    };
  });
}

function sessionURL(config: Record<string, unknown>): URL {
  const baseURL = requiredString(config.baseUrl);
  const configured = typeof config.sessionEndpoint === "string" ? config.sessionEndpoint.trim() : "";
  try {
    return configured ? new URL(configured, withTrailingSlash(baseURL)) : new URL("api/session", withTrailingSlash(baseURL));
  } catch {
    throw new PlatformAdapterError();
  }
}

function sessionExpiry(value: unknown, config: Record<string, unknown>): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()) return value;
  const configured = config.sessionTtlSeconds;
  const seconds = typeof configured === "number" && configured >= 60 && configured <= 86400
    ? configured : DEFAULT_SESSION_TTL_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PlatformAdapterError();
  return value;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSameSite(value: unknown): value is SameSite {
  return value === "Strict" || value === "Lax" || value === "None";
}

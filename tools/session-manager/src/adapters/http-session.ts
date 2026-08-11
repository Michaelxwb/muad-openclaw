import {
  type AdapterRefreshInput,
  type AdapterValidateInput,
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
const CONTROL_CREDENTIAL_KEYS = new Set([
  "baseUrl", "sessionEndpoint", "healthEndpoint", "sessionMode",
  "sessionTtlSeconds", "sessionRequestBody",
]);
// Secrets travel only in headers (Authorization / X-Access-Key / X-Secret-Key),
// never in the login request body.
const SESSION_BODY_SECRET_KEYS = new Set(["apiKey", "ak", "sk", "accessKey", "secretKey"]);

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
      const url = sessionURL(input.credential.credentials);
      const response = await this.#fetch(url, {
        method: "POST",
        signal: input.signal,
        headers: sessionHeaders(input.credential.credentials),
        body: sessionRequestBody(input.credential.credentials),
      });
      return await readSessionResponse(response, input.credential.credentials, url);
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true);
    }
  }

  async validate(input: AdapterValidateInput): Promise<boolean> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    const url = healthURL(input.credential.credentials);
    if (!url) return true;
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        signal: input.signal,
        headers: healthHeaders(input.credential.credentials, input.state.cookies),
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new PlatformAdapterError(false, response.status >= 500 || response.status === 429);
      return true;
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true);
    }
  }
}

async function readSessionResponse(
  response: Response,
  config: Record<string, unknown>,
  url: URL,
): Promise<AdapterSessionState> {
  if (response.status === 401 || response.status === 403) throw new PlatformAdapterError(true);
  if (!response.ok) throw new PlatformAdapterError(false, response.status >= 500 || response.status === 429);
  const text = await response.text();
  if (text.length > MAX_ADAPTER_RESPONSE_BYTES) throw new PlatformAdapterError();
  const payload = sessionPayload(text);
  const storageState = parseStorageState(payload.storageState);
  const responseCookies = setCookieHeaders(response.headers)
    .map((header) => parseSetCookie(header, url))
    .filter((cookie): cookie is SessionCookie => cookie !== null);
  const cookies = responseCookies.length > 0
    ? responseCookies
    : parseCookies(payload.cookies ?? storageState?.cookies);
  const normalized = storageState ?? { cookies, origins: [] };
  if (cookies.length === 0 && normalized.origins.length === 0) throw new PlatformAdapterError();
  return {
    cookies,
    storageState: { cookies, origins: normalized.origins },
    expiresAt: sessionExpiry(payload.expiresAt, config),
  };
}

function sessionPayload(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
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

function sessionHeaders(credentials: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof credentials.apiKey === "string" && credentials.apiKey.trim() !== "") {
    headers.Authorization = `Bearer ${credentials.apiKey.trim()}`;
  }
  const ak = optionalString(credentials.ak ?? credentials.accessKey);
  const sk = optionalString(credentials.sk ?? credentials.secretKey);
  if (ak) headers["X-Access-Key"] = ak;
  if (sk) headers["X-Secret-Key"] = sk;
  return headers;
}

function healthHeaders(
  credentials: Record<string, unknown>, cookies: readonly SessionCookie[],
): Record<string, string> {
  const headers = sessionHeaders(credentials);
  delete headers["Content-Type"];
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

function sessionRequestBody(credentials: Record<string, unknown>): string {
  if (isRecord(credentials.sessionRequestBody)) return JSON.stringify(credentials.sessionRequestBody);
  const body: Record<string, unknown> = { sessionMode: sessionMode(credentials) };
  for (const [key, value] of Object.entries(credentials)) {
    if (CONTROL_CREDENTIAL_KEYS.has(key) || SESSION_BODY_SECRET_KEYS.has(key)) continue;
    body[key] = value;
  }
  return JSON.stringify(body);
}

function sessionMode(credentials: Record<string, unknown>): string {
  const value = credentials.sessionMode;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "storage_state";
}

function sessionExpiry(value: unknown, config: Record<string, unknown>): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()) return value;
  const configured = config.sessionTtlSeconds;
  const seconds = typeof configured === "number" && configured >= 60 && configured <= 86400
    ? configured : DEFAULT_SESSION_TTL_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function healthURL(config: Record<string, unknown>): URL | null {
  const endpoint = typeof config.healthEndpoint === "string" ? config.healthEndpoint.trim() : "";
  if (!endpoint) return null;
  try {
    return new URL(endpoint, withTrailingSlash(requiredString(config.baseUrl)));
  } catch {
    throw new PlatformAdapterError();
  }
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function splitSetCookieHeader(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "," || !looksLikeCookiePair(value.slice(index + 1))) continue;
    parts.push(value.slice(start, index).trim());
    start = index + 1;
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function looksLikeCookiePair(value: string): boolean {
  const match = /^\s*([^=;, ]+)=/u.exec(value);
  const key = match?.[1]?.toLowerCase() ?? "";
  return Boolean(key && !["expires", "max-age", "path", "domain"].includes(key));
}

function parseSetCookie(header: string, url: URL): SessionCookie | null {
  const [pair = "", ...attributes] = header.split(";").map((item) => item.trim());
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const cookie: SessionCookie = {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    domain: url.hostname,
    path: "/",
  };
  applyCookieAttributes(cookie, attributes);
  return cookie.name && cookie.value ? cookie : null;
}

function applyCookieAttributes(cookie: SessionCookie, attributes: readonly string[]): void {
  for (const attribute of attributes) {
    const [rawKey = "", ...rawValue] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join("=").trim();
    if (key === "domain" && value) cookie.domain = value;
    if (key === "path" && value) cookie.path = value;
    if (key === "httponly") cookie.httpOnly = true;
    if (key === "secure") cookie.secure = true;
    if (key === "samesite" && isSameSite(value)) cookie.sameSite = value;
    if (key === "expires") setCookieExpires(cookie, Date.parse(value) / 1000);
    if (key === "max-age") setCookieExpires(cookie, Date.now() / 1000 + Number(value));
  }
}

function setCookieExpires(cookie: SessionCookie, value: number): void {
  if (Number.isFinite(value)) cookie.expires = Math.floor(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PlatformAdapterError();
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
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

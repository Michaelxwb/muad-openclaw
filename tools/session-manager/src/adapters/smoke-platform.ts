import {
  type AdapterRefreshInput,
  type AdapterValidateInput,
  type AdapterSessionState,
  type BrowserStorageState,
  type LoginFailReason,
  PlatformAdapterError,
  type PlatformAdapter,
  type SameSite,
  type SessionCookie,
} from "./types.js";

const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// smoke_platform 业务返回码（HTTP 永远 200，错误码在 JSON body 的 code 字段）。
// 与 tools/fake-business-platform/server.py 对齐，供业务码分类做端到端验证。
const CODE_SUCCESS = 0;
const CODE_PARAMS_ERR = 1001;        // 请求体缺 username/password
const CODE_AUTH_FAILED = 1002;      // 账号或密码错误
const CODE_ACCOUNT_LOCKED = 1003;   // 账号锁定
const CODE_RATE_LIMITED = 1004;     // 频率超限
const CODE_SERVICE_ERR = 1005;      // 服务异常

// 业务码 → PlatformAdapterError(authenticationFailed, retryable, reason) 分类映射。
// message 不在此处定义，统一透传服务端 body 的 msg 字段。
const BUSINESS_CODE_MAP: Record<number, {
  authenticationFailed: boolean;
  retryable: boolean;
  reason: LoginFailReason;
}> = {
  [CODE_PARAMS_ERR]:     { authenticationFailed: true,  retryable: false, reason: "params_error"    },
  [CODE_AUTH_FAILED]:    { authenticationFailed: true,  retryable: false, reason: "auth_failed"     },
  [CODE_ACCOUNT_LOCKED]: { authenticationFailed: false, retryable: true,  reason: "account_locked" },
  [CODE_RATE_LIMITED]:   { authenticationFailed: false, retryable: true,  reason: "rate_limited"   },
  [CODE_SERVICE_ERR]:    { authenticationFailed: false, retryable: true,  reason: "service_error"  },
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SmokePlatformCredential = {
  baseUrl: string;
  sessionEndpoint: string;
  healthEndpoint?: string;
  username: string;
  password: string;
  sessionTtlSeconds?: number;
};

export class SmokePlatformSessionAdapter implements PlatformAdapter {
  readonly platform = "smoke_platform";
  readonly #fetch: FetchLike;

  constructor(fetchLike: FetchLike = fetch) {
    this.#fetch = fetchLike;
  }

  async refresh(input: AdapterRefreshInput): Promise<AdapterSessionState> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    const credential = parseCredential(input.credential.credentials);
    try {
      const url = new URL(credential.sessionEndpoint, withTrailingSlash(credential.baseUrl));
      const response = await this.#fetch(url, {
        method: "POST",
        signal: input.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: credential.username, password: credential.password }),
      });
      return await readSessionResponse(response, url, credential);
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true, "network", "platform network request failed");
    }
  }

  async validate(input: AdapterValidateInput): Promise<boolean> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    const credential = parseCredential(input.credential.credentials);
    if (!credential.healthEndpoint) return true;
    try {
      const url = new URL(credential.healthEndpoint, withTrailingSlash(credential.baseUrl));
      const cookieHeader = input.state.cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const response = await this.#fetch(url, {
        method: "GET",
        signal: input.signal,
        headers: { ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      });
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new PlatformAdapterError(false, response.status >= 500 || response.status === 429, "service_error");
      return true;
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true, "network", "platform network request failed");
    }
  }
}

async function readSessionResponse(
  response: Response,
  url: URL,
  credential: SmokePlatformCredential,
): Promise<AdapterSessionState> {
  if (response.status === 401 || response.status === 403) {
    throw new PlatformAdapterError(true, false, "auth_failed", "platform returned 401/403");
  }
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new PlatformAdapterError(false, retryable, "service_error", `platform returned HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new PlatformAdapterError();
  // smoke_platform 登录接口永远返回 HTTP 200，错误码在 JSON body 的 code 字段。
  // 解析业务码 + msg：成功则继续看 cookie；失败按 BUSINESS_CODE_MAP 分类抛错，
  // message 统一用服务端返回的 msg（不自己编文案）。
  const business = parseBusinessBody(text);
  if (business && business.code !== CODE_SUCCESS) {
    const mapped = BUSINESS_CODE_MAP[business.code];
    const authenticationFailed = mapped?.authenticationFailed ?? false;
    const retryable = mapped?.retryable ?? true;
    const reason = mapped?.reason ?? "unknown";
    const message = business.msg || `smoke_platform code=${String(business.code)}`;
    throw new PlatformAdapterError(authenticationFailed, retryable, reason, message, business.code);
  }
  const cookies = setCookieHeaders(response.headers)
    .map((header) => parseSetCookie(header, url))
    .filter((cookie): cookie is SessionCookie => cookie !== null);
  if (cookies.length === 0) {
    throw new PlatformAdapterError(
      false,
      false,
      "service_error",
      "platform login succeeded without session cookies",
    );
  }
  const storageState: BrowserStorageState = { cookies, origins: [] };
  return {
    cookies,
    storageState,
    expiresAt: sessionExpiry(credential),
  };
}

// 解析 smoke_platform BaseResponse 的 code + msg 字段。body 形如
// {"code":0,"msg":"...","authenticated":true,"user":"..."}。不是 JSON 或缺 code
// 时返回 null，调用方回退到 cookie-based 处理。
function parseBusinessBody(body: string): { code: number; msg: string } | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const code = (parsed as { code?: unknown }).code;
    const msg = (parsed as { msg?: unknown }).msg;
    if (typeof code !== "number") return null;
    return { code, msg: typeof msg === "string" ? msg : "" };
  } catch {
    return null;
  }
}

function sessionExpiry(credential: SmokePlatformCredential): string {
  const configured = credential.sessionTtlSeconds;
  const seconds = typeof configured === "number" && configured >= 60 && configured <= 86400
    ? configured : DEFAULT_SESSION_TTL_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseCredential(credentials: Record<string, unknown>): SmokePlatformCredential {
  const baseUrl = optionalString(credentials.baseUrl);
  const username = optionalString(credentials.username);
  const password = optionalString(credentials.password);
  const sessionEndpoint = optionalString(credentials.sessionEndpoint);
  const healthEndpoint = optionalString(credentials.healthEndpoint);
  if (!baseUrl || !username || !password || !sessionEndpoint) {
    throw new PlatformAdapterError(
      true, false, "missing_credential",
      "platform credential missing (baseUrl/username/password/sessionEndpoint)",
    );
  }
  return {
    baseUrl,
    sessionEndpoint,
    ...(healthEndpoint ? { healthEndpoint } : {}),
    username,
    password,
    ...(typeof credentials.sessionTtlSeconds === "number" ? { sessionTtlSeconds: credentials.sessionTtlSeconds } : {}),
  };
}

function optionalString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
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

function isSameSite(value: unknown): value is SameSite {
  return value === "Strict" || value === "Lax" || value === "None";
}

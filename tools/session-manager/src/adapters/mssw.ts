import { createHash, createHmac, randomUUID } from "node:crypto";

import { createInsecureFetch } from "./insecure-fetch.js";
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

const HMAC_SHA256_ALGO = "HMAC-SHA256";
const SIGN_DATE_HEADER = "sign-date";
const GET_TOKEN_PATH = "/v1/certification/get_token";
const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER = "x-csrftoken";
const GATEWAY_PREFIX = "/gateway/";
const DEFAULT_SESSION_TTL_SECONDS = 15 * 60;
const MAX_RESPONSE_BYTES = 1024 * 1024;

// MSSW login_agent 业务返回码（HTTP 永远 200，错误码在 JSON body 的 code 字段）。
// 与 mss-auth/internal/types/constant.go 对齐。
const CODE_SUCCESS = 0;
const CODE_PARAMS_ERR = 9001;        // Authorization/Nonce 缺失或格式错
const CODE_SERVICE_ERR = 9000;      // 服务异常（签发 JWT 失败等）
const CODE_AUTH_FAILED = 9348;      // 验签失败 / 凭证不存在 / 凭证被吊销 / Expert 失效 / Nonce 重放 / sign-date 过期
const CODE_ACCOUNT_LOCKED = 12000;  // AK 被锁定（连续失败超阈值，30 分钟）
const CODE_RATE_LIMITED = 12001;   // AK 频率超限（每分钟 20 次）

// 业务码 → PlatformAdapterError(authenticationFailed, retryable, reason) 分类映射。
// 鉴权失败：authenticationFailed=true，框架会清缓存且不重试。
// 限流/锁定：可重试（短期），不视为鉴权失败。
// 服务异常：可重试。
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

export type MSSWCredential = {
  baseUrl: string;
  sessionEndpoint: string;
  healthEndpoint?: string;
  ak: string;
  sk: string;
  csrfEnabled?: boolean;
  sessionTtlSeconds?: number;
};

export class MSSWSessionAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #branchTag: string;
  readonly #log: (message: string) => void;

  // mssw/mssp environments (SIT/UAT/prod) all use self-signed TLS certificates on the
  // internal network, so the adapter defaults to an insecure fetch. Tests inject a
  // mock fetch to keep unit tests offline; explicit fetch injection stays possible.
  // platform/branchTag 默认值保持 mssw 现状，mssp 用薄子类覆盖这两个参数复用全部登录实现。
  constructor(
    fetchLike: FetchLike = createInsecureFetch(),
    now: () => number = () => Math.floor(Date.now() / 1000),
    platform = "mssw",
    branchTag = "MSSW-ADAPTER",
    log: (message: string) => void = () => {},
  ) {
    this.#fetch = fetchLike;
    this.#now = now;
    this.platform = platform;
    this.#branchTag = branchTag;
    this.#log = log;
  }

  async refresh(input: AdapterRefreshInput): Promise<AdapterSessionState> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    const credential = parseCredential(input.credential.credentials);
    try {
      const url = new URL(credential.sessionEndpoint, withTrailingSlash(credential.baseUrl));
      const body = "";
      const signPath = stripGatewayPrefix(url.pathname);
      const csrfToken = credential.csrfEnabled ? await this.#fetchCSRFToken(credential, input.signal) : "";
      this.#log(`[session-manager] platform=${this.platform} login request path=${signPath} csrf=${credential.csrfEnabled ? "on" : "off"}`);
      const response = await this.#fetch(url, {
        method: "POST",
        signal: input.signal,
        headers: this.#buildHeaders(credential, signPath, url.search, body, csrfToken),
        body,
      });
      const state = await readSessionResponse(response, url, credential, this.#now, this.platform);
      return state;
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error;
      throw new PlatformAdapterError(false, true, "network", "platform network request failed");
    }
  }

  async validate(input: AdapterValidateInput): Promise<boolean> {
    if (input.credential.platform !== this.platform) throw new PlatformAdapterError();
    const credential = parseCredential(input.credential.credentials);
    const endpoint = credential.healthEndpoint;
    if (!endpoint) return true;
    try {
      const url = new URL(endpoint, withTrailingSlash(credential.baseUrl));
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

  async #fetchCSRFToken(credential: MSSWCredential, signal: AbortSignal): Promise<string> {
    const url = new URL(GET_TOKEN_PATH, withTrailingSlash(credential.baseUrl));
    const response = await this.#fetch(url, { method: "GET", signal });
    if (!response.ok) throw new PlatformAdapterError(false, response.status >= 500);
    const cookies = setCookieHeaders(response.headers)
      .map((header) => parseSetCookie(header, url))
      .filter((cookie): cookie is SessionCookie => cookie !== null);
    const csrf = cookies.find((cookie) => cookie.name === CSRF_COOKIE_NAME);
    this.#log(`[session-manager] platform=${this.platform} csrf token ${csrf ? "fetched" : "absent"}`);
    return csrf?.value ?? "";
  }

  #buildHeaders(
    credential: MSSWCredential,
    signPath: string,
    query: string,
    body: string,
    csrfToken: string,
  ): Record<string, string> {
    const ts = String(this.#now());
    const contentType = "application/json";
    const signedHeaders: Record<string, string> = { [SIGN_DATE_HEADER]: ts, "content-type": contentType };
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Branch-Tag": this.#branchTag,
      "Agent-Nonce": randomUUID().replace(/-/gu, ""),
    };
    const canonical = makeCanonicalRequest("POST", signPath, query, signedHeaders, body);
    const signStr = makeSignStr(HMAC_SHA256_ALGO, ts, canonical);
    const signature = computeSignature(signStr, credential.sk);
    const signedHeadersStr = Object.keys(signedHeaders).sort().join(";");
    headers.Authorization = `algorithm=${HMAC_SHA256_ALGO},Access=${credential.ak},SignedHeaders=${signedHeadersStr},Signature=${signature},${SIGN_DATE_HEADER}=${ts}`;
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;
    return headers;
  }
}

export function makeCanonicalRequest(
  method: string,
  path: string,
  query: string,
  signedHeaders: Record<string, string>,
  body: string,
): string {
  const canonQuery = canonicalQuery(query);
  const sortedKeys = Object.keys(signedHeaders).sort();
  const canonHeaders = sortedKeys
    .map((key) => `${key.toLowerCase()}:${signedHeaders[key]}\n`)
    .join("");
  let result = `${method}\n${path}\n`;
  if (canonQuery) result += `${canonQuery}\n`;
  result += `${canonHeaders}${sortedKeys.join(";")}`;
  if (body) result += `\n${sha256Hex(body)}`;
  return result;
}

export function makeSignStr(algorithm: string, dateTime: string, canonical: string): string {
  return `${algorithm}\n${dateTime}\n${sha256Hex(canonical)}`;
}

export function computeSignature(signStr: string, sk: string): string {
  return createHmac("sha256", sk).update(signStr).digest("hex").toUpperCase();
}

export function stripGatewayPrefix(path: string): string {
  if (!path.startsWith(GATEWAY_PREFIX)) return path;
  const rest = path.slice(GATEWAY_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "/";
}

function canonicalQuery(query: string): string {
  if (!query) return "";
  const params = query.split("&").sort();
  return params.join("&");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

async function readSessionResponse(
  response: Response,
  url: URL,
  credential: MSSWCredential,
  now: () => number,
  platform: string,
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
  // MSSW handler 永远返回 HTTP 200，错误码在 JSON body 的 code 字段。
  // 解析业务码 + msg：成功则继续看 cookie；失败按 BUSINESS_CODE_MAP 分类抛错，
  // message 统一用服务端返回的 msg（不自己编文案）。
  const business = parseBusinessBody(text);
  if (business && business.code !== CODE_SUCCESS) {
    const mapped = BUSINESS_CODE_MAP[business.code];
    const authenticationFailed = mapped?.authenticationFailed ?? false;
    const retryable = mapped?.retryable ?? true;
    const reason = mapped?.reason ?? "unknown";
    const message = business.msg || `${platform} code=${String(business.code)}`;
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
    expiresAt: sessionExpiry(credential, now),
  };
}

// 解析 MSSW BaseResponse 的 code + msg 字段。body 形如 {"code":0,"msg":"...","data":...}。
// 不是 JSON 或缺 code 时返回 null，调用方回退到 cookie-based 处理。
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

function sessionExpiry(credential: MSSWCredential, now: () => number): string {
  const configured = credential.sessionTtlSeconds;
  const seconds = typeof configured === "number" && configured >= 60 && configured <= 86400
    ? configured : DEFAULT_SESSION_TTL_SECONDS;
  return new Date((now() + seconds) * 1000).toISOString();
}

function parseCredential(credentials: Record<string, unknown>): MSSWCredential {
  const ak = optionalString(credentials.ak);
  const sk = optionalString(credentials.sk);
  const baseUrl = optionalString(credentials.baseUrl);
  const sessionEndpoint = optionalString(credentials.sessionEndpoint);
  const healthEndpoint = optionalString(credentials.healthEndpoint);
  if (!ak || !sk || !baseUrl || !sessionEndpoint) {
    throw new PlatformAdapterError(
      true, false, "missing_credential",
      "platform credential missing (ak/sk/baseUrl/sessionEndpoint)",
    );
  }
  return {
    baseUrl,
    sessionEndpoint,
    ...(healthEndpoint ? { healthEndpoint } : {}),
    ak,
    sk,
    ...(typeof credentials.csrfEnabled === "boolean" ? { csrfEnabled: credentials.csrfEnabled } : {}),
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

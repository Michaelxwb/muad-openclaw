import type { SessionCookie } from "./adapters/types.js";
import { SessionManagerError } from "./errors.js";
import type {
  BrowserSessionApplier,
  BrowserSessionApplyInput,
  BrowserSessionApplyResult,
} from "./types.js";

const BROWSER_REQUEST_METHOD = "browser.request";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const DEFAULT_APPLY_TIMEOUT_MS = 20_000;

export type BrowserGatewayRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number; scopes?: string[] },
) => Promise<T>;

export type BrowserSessionApplierOptions = {
  request: BrowserGatewayRequest;
  profileForAgent: (agentId: string) => string | undefined;
  timeoutMs?: number;
};

export function createBrowserSessionApplier(
  options: BrowserSessionApplierOptions,
): BrowserSessionApplier {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  return {
    apply: async (input) => applyBrowserSession(input, options, timeoutMs),
  };
}

async function applyBrowserSession(
  input: BrowserSessionApplyInput,
  options: BrowserSessionApplierOptions,
  timeoutMs: number,
): Promise<BrowserSessionApplyResult> {
  const profile = options.profileForAgent(input.context.agentId);
  if (!profile) {
    throw new SessionManagerError(
      "browser_apply_failed",
      false,
      "params_error",
      "browser profile mapping is unavailable",
      undefined,
      input.credential.platform,
    );
  }
  assertStorageOriginsSupported(input);
  for (const cookie of input.state.cookies) {
    await applyCookie(options.request, profile, cookie, timeoutMs, input.credential.platform);
  }
  return { applied: true, profile };
}

function assertStorageOriginsSupported(input: BrowserSessionApplyInput): void {
  const origins = input.state.storageState.origins ?? [];
  const hasLocalStorage = origins.some((origin) => origin.localStorage.length > 0);
  if (!hasLocalStorage) return;
  throw new SessionManagerError(
    "browser_apply_failed",
    false,
    "params_error",
    "storageState origins require a browser context-level import route",
    undefined,
    input.credential.platform,
  );
}

async function applyCookie(
  request: BrowserGatewayRequest,
  profile: string,
  cookie: SessionCookie,
  timeoutMs: number,
  platform: string,
): Promise<void> {
  try {
    await request(
      BROWSER_REQUEST_METHOD,
      {
        method: "POST",
        path: "/cookies/set",
        query: { profile },
        body: { cookie: browserCookie(cookie) },
        timeoutMs,
      },
      { timeoutMs, scopes: [OPERATOR_ADMIN_SCOPE] },
    );
  } catch {
    throw new SessionManagerError(
      "browser_apply_failed",
      true,
      "service_error",
      "browser cookie apply failed",
      undefined,
      platform,
    );
  }
}

function browserCookie(cookie: SessionCookie): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
  };
  if (cookie.expires !== undefined) output.expires = cookie.expires;
  if (cookie.httpOnly !== undefined) output.httpOnly = cookie.httpOnly;
  if (cookie.secure !== undefined) output.secure = cookie.secure;
  if (cookie.sameSite !== undefined) output.sameSite = cookie.sameSite;
  return output;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : DEFAULT_APPLY_TIMEOUT_MS;
}

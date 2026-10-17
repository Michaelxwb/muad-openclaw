import type { PlatformRequestProfile, RequestProfileCsrf } from "./types.js";

const DEFAULT_TRACE_HEADER = "Traceid";

/**
 * Builds a platform request profile from credential JSON. Missing optional
 * fields degrade to safe defaults and emit one diagnostic instead of failing.
 */
export function buildRequestProfile(
  platform: string,
  credentials: Record<string, unknown>,
  csrf: RequestProfileCsrf[],
  staticHeaders: Record<string, string>,
  log: (message: string) => void,
): PlatformRequestProfile {
  const baseUrl = optionalString(credentials.baseUrl);
  const hostHeader = stringMap(credentials.hostHeader);
  const referer = optionalString(credentials.referer);
  const missing = missingProfileFields(baseUrl, hostHeader, referer);
  if (missing.length > 0) {
    log(`[session-manager] platform=${platform} request profile fallback missing=${missing.join(",")}`);
  }
  return {
    baseUrl,
    hostHeader,
    ...(referer ? { referer } : {}),
    csrf,
    staticHeaders,
    traceHeader: traceHeader(credentials.traceHeader),
    extraAllowed: true,
  };
}

export function defaultRequestProfile(
  platform: string,
  credentials: Record<string, unknown>,
  log: (message: string) => void,
): PlatformRequestProfile {
  return buildRequestProfile(platform, credentials, [], {}, log);
}

export function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    const headerValue = typeof item === "string" ? item.trim() : "";
    if (name && headerValue) result[name] = headerValue;
  }
  return result;
}

export function headerValue(headers: Record<string, string>, name: string): string {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return "";
}

export function optionalString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

function missingProfileFields(
  baseUrl: string,
  hostHeader: Record<string, string>,
  referer: string,
): string[] {
  const missing: string[] = [];
  if (!baseUrl) missing.push("baseUrl");
  if (Object.keys(hostHeader).length === 0) missing.push("hostHeader");
  if (!referer) missing.push("referer");
  return missing;
}

function traceHeader(value: unknown): string | null {
  if (value === null) return null;
  return optionalString(value) || DEFAULT_TRACE_HEADER;
}

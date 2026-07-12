import { readFile } from "node:fs/promises";

export const POD_SERVICE_TOKEN_FILE = "/run/secrets/muad/pod-service-token";
const BINDING_PATH = "/internal/v1/bindings/activate";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class BindingClientError extends Error {
  constructor(code, retryable = false) {
    super("binding activation failed");
    this.name = "BindingClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class BindingClient {
  constructor({ baseURL, tokenFile = POD_SERVICE_TOKEN_FILE, timeoutMs = 5_000, fetch: fetchLike = fetch,
    readToken = (filePath) => readFile(filePath, "utf8") }) {
    this.url = bindingURL(baseURL);
    if (tokenFile !== POD_SERVICE_TOKEN_FILE) throw new BindingClientError("service_unavailable", true);
    this.tokenFile = tokenFile;
    this.timeoutMs = positiveInteger(timeoutMs, 5_000);
    this.fetch = fetchLike;
    this.readToken = readToken;
  }

  async activate(request) {
    const token = await this.#token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return await readActivationResponse(response);
    } catch (error) {
      if (error instanceof BindingClientError) throw error;
      throw new BindingClientError("service_unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async #token() {
    try {
      const token = String(await this.readToken(this.tokenFile)).trim();
      if (token) return token;
    } catch (error) {
      if (!(error instanceof Error)) throw new BindingClientError("service_unavailable", true);
    }
    throw new BindingClientError("service_unavailable", true);
  }
}

async function readActivationResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new BindingClientError("service_unavailable", true);
  const envelope = parseEnvelope(text);
  if (!response.ok || envelope.code !== 0) throw responseError(response.status, envelope.code);
  if (!isRecord(envelope.data) || envelope.data.identityBound !== true) {
    throw new BindingClientError("service_unavailable", true);
  }
  return envelope.data;
}

function parseEnvelope(text) {
  try {
    const value = JSON.parse(text);
    if (isRecord(value) && typeof value.code === "number") return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new BindingClientError("service_unavailable", true);
}

function responseError(status, code) {
  if (status === 429 || code === 42901) return new BindingClientError("rate_limited", true);
  if (status === 400 || status === 409) return new BindingClientError("invalid_binding");
  return new BindingClientError("service_unavailable", status >= 500 || status === 401);
}

function bindingURL(baseURL) {
  try {
    const url = new URL(baseURL);
    const root = url.pathname.replace(/\/+$/u, "");
    url.pathname = `${root.endsWith("/internal/v1") ? root : `${root}/internal/v1`}${BINDING_PATH.replace("/internal/v1", "")}`;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new BindingClientError("service_unavailable", true);
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

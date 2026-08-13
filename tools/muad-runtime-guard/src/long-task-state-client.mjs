import { readFile } from "node:fs/promises";
import { POD_SERVICE_TOKEN_FILE } from "./binding-client.mjs";

const LONG_TASKS_PATH = "/internal/v1/long-tasks";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class LongTaskStateClientError extends Error {
  constructor(code, retryable = false) {
    super("Long task state push failed");
    this.name = "LongTaskStateClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class LongTaskStateClient {
  constructor({
    baseURL,
    tokenFile = POD_SERVICE_TOKEN_FILE,
    timeoutMs = 5_000,
    fetch: fetchLike = fetch,
    readToken = (filePath) => readFile(filePath, "utf8"),
  }) {
    this.url = longTasksURL(baseURL);
    if (tokenFile !== POD_SERVICE_TOKEN_FILE) throw new LongTaskStateClientError("service_unavailable", true);
    this.tokenFile = tokenFile;
    this.timeoutMs = positiveInteger(timeoutMs, 5_000);
    this.fetch = fetchLike;
    this.readToken = readToken;
  }

  async push(snapshot) {
    const token = await this.#token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      return await readPushResponse(response);
    } catch (error) {
      if (error instanceof LongTaskStateClientError) throw error;
      throw new LongTaskStateClientError("service_unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async #token() {
    try {
      const token = String(await this.readToken(this.tokenFile)).trim();
      if (token) return token;
    } catch (error) {
      if (!(error instanceof Error)) throw new LongTaskStateClientError("service_unavailable", true);
    }
    throw new LongTaskStateClientError("service_unavailable", true);
  }
}

async function readPushResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new LongTaskStateClientError("service_unavailable", true);
  const envelope = parseEnvelope(text);
  if (!response.ok || envelope.code !== 0) {
    // 401 是 pod token 失效，重试无意义；仅 5xx 视为可重试。
    throw new LongTaskStateClientError("service_unavailable", response.status >= 500);
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
  throw new LongTaskStateClientError("service_unavailable", true);
}

function longTasksURL(baseURL) {
  try {
    const url = new URL(baseURL);
    // 内部 API 路径是固定契约，不受 baseURL 的 path 影响，避免带前缀的
    // consoleInternalURL 拼出 /console/internal/v1/long-tasks 这类 404 路由。
    url.pathname = LONG_TASKS_PATH;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new LongTaskStateClientError("service_unavailable", true);
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

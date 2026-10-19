import { readFile } from "node:fs/promises";

import { POD_SERVICE_TOKEN_FILE } from "./binding-client.mjs";

const SKILL_EXECUTIONS_PATH = "/internal/v1/skill-executions";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class SkillTraceClientError extends Error {
  constructor(code, retryable = false) {
    super("Skill trace upload failed");
    this.name = "SkillTraceClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SkillTraceClient {
  constructor({
    baseURL,
    tokenFile = POD_SERVICE_TOKEN_FILE,
    timeoutMs = 5_000,
    fetch: fetchLike = fetch,
    readToken = (filePath) => readFile(filePath, "utf8"),
  }) {
    this.baseURL = baseURL;
    if (tokenFile !== POD_SERVICE_TOKEN_FILE) throw new SkillTraceClientError("service_unavailable", true);
    this.tokenFile = tokenFile;
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
    this.fetch = fetchLike;
    this.readToken = readToken;
  }

  async report(executionId, payload) {
    const token = await this.#token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(traceURL(this.baseURL, executionId), {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return await readTraceResponse(response);
    } catch (error) {
      if (error instanceof SkillTraceClientError) throw error;
      throw new SkillTraceClientError("service_unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async #token() {
    try {
      const token = String(await this.readToken(this.tokenFile)).trim();
      if (token) return token;
    } catch {
      // fall through: an unreadable token is a retryable transport failure
    }
    throw new SkillTraceClientError("service_unavailable", true);
  }
}

async function readTraceResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new SkillTraceClientError("service_unavailable", true);
  const envelope = parseEnvelope(text);
  if (!response.ok || envelope.code !== 0) {
    // 401/404/409/400 are deterministic ownership or payload failures; retrying
    // cannot change the outcome. Only 5xx is retryable (matching the other
    // internal clients).
    throw new SkillTraceClientError("service_unavailable", response.status >= 500);
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
  throw new SkillTraceClientError("service_unavailable", true);
}

function traceURL(baseURL, executionId) {
  try {
    const url = new URL(baseURL);
    const root = url.pathname.replace(/\/+$/u, "");
    const prefix = root.endsWith("/internal/v1") ? root.slice(0, -"/internal/v1".length) : root;
    url.pathname = `${prefix}${SKILL_EXECUTIONS_PATH}/${encodeURIComponent(executionId)}/trace`;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new SkillTraceClientError("service_unavailable", true);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

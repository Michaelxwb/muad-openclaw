import { readFile } from "node:fs/promises";
import { POD_SERVICE_TOKEN_FILE } from "./binding-client.mjs";

const SKILL_EXECUTIONS_PATH = "/internal/v1/skill-executions";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class SkillAuditClientError extends Error {
  constructor(code, retryable = false) {
    super("Skill execution audit failed");
    this.name = "SkillAuditClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SkillAuditClient {
  constructor({
    baseURL,
    tokenFile = POD_SERVICE_TOKEN_FILE,
    timeoutMs = 5_000,
    fetch: fetchLike = fetch,
    readToken = (filePath) => readFile(filePath, "utf8"),
  }) {
    this.url = skillExecutionsURL(baseURL);
    if (tokenFile !== POD_SERVICE_TOKEN_FILE) throw new SkillAuditClientError("service_unavailable", true);
    this.tokenFile = tokenFile;
    this.timeoutMs = positiveInteger(timeoutMs, 5_000);
    this.fetch = fetchLike;
    this.readToken = readToken;
  }

  async report(request) {
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
      return await readAuditResponse(response);
    } catch (error) {
      if (error instanceof SkillAuditClientError) throw error;
      throw new SkillAuditClientError("service_unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async #token() {
    try {
      const token = String(await this.readToken(this.tokenFile)).trim();
      if (token) return token;
    } catch (error) {
      if (!(error instanceof Error)) throw new SkillAuditClientError("service_unavailable", true);
    }
    throw new SkillAuditClientError("service_unavailable", true);
  }
}

async function readAuditResponse(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new SkillAuditClientError("service_unavailable", true);
  const envelope = parseEnvelope(text);
  if (!response.ok || envelope.code !== 0) {
    // 401 是 pod token 失效，重试无意义；仅 5xx 视为可重试（与
    // long-task-state-client / binding-client 的 401 语义一致）。
    throw new SkillAuditClientError("service_unavailable", response.status >= 500);
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
  throw new SkillAuditClientError("service_unavailable", true);
}

function skillExecutionsURL(baseURL) {
  try {
    const url = new URL(baseURL);
    const root = url.pathname.replace(/\/+$/u, "");
    url.pathname = `${root.endsWith("/internal/v1") ? root : `${root}/internal/v1`}${SKILL_EXECUTIONS_PATH.replace("/internal/v1", "")}`;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new SkillAuditClientError("service_unavailable", true);
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

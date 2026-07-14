import { readFile } from "node:fs/promises";

const REPORT_PATH = "/internal/v1/skill-executions";
const DEFAULT_TIMEOUT_MS = 2000;

export function createSkillExecutionReporter({
  consoleInternalURL,
  serviceTokenFile,
  execution,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const root = normalizeInternalRoot(consoleInternalURL);
  const tokenPath = typeof serviceTokenFile === "string" ? serviceTokenFile.trim() : "";
  const baseExecution = { ...execution };
  let tokenPromise;
  async function token() {
    tokenPromise ??= readFileImpl(tokenPath, "utf8").then((value) => String(value).trim());
    return tokenPromise;
  }
  return {
    async report(update) {
      if (!root || !tokenPath || typeof fetchImpl !== "function") return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(root + REPORT_PATH.replace("/internal/v1", ""), {
          method: "POST",
          headers: {
            authorization: `Bearer ${await token()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...baseExecution, ...update }),
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function progressSummary(event) {
  return [{
    type: String(event?.type ?? "").slice(0, 32),
    stage: String(event?.stage ?? "").slice(0, 80),
    text: String(event?.text ?? "").slice(0, 256),
    ts: String(event?.ts ?? new Date().toISOString()).slice(0, 64),
  }];
}

function normalizeInternalRoot(value) {
  const root = typeof value === "string" ? value.trim().replace(/\/+$/u, "") : "";
  if (!root) return "";
  return root.endsWith("/internal/v1") ? root : `${root}/internal/v1`;
}

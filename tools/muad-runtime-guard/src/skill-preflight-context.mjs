import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SkillPreflightContext {
  #records = new Map();
  constructor({ now = () => Date.now(), ttlMs = 10 * 60_000, maxRecords = 4096 } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxRecords) || maxRecords <= 0) {
      throw new Error("invalid preflight retention");
    }
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
  }

  recordRead(input) {
    this.#prune();
    const key = recordKey(input);
    if (!key || input.error) return rejected("documentation_not_read");
    const version = documentVersion(input);
    if (!version) return rejected("documentation_not_read");
    this.#records.delete(key);
    this.#records.set(key, { version, at: this.now() });
    while (this.#records.size > this.maxRecords) this.#records.delete(this.#records.keys().next().value);
    return { ok: true };
  }

  check(input) {
    this.#prune();
    const key = recordKey(input);
    const record = this.#records.get(key);
    if (!record) return rejected("documentation_not_read");
    if (record.version !== documentVersion(input)) {
      this.#records.delete(key);
      return rejected("documentation_changed");
    }
    return { ok: true };
  }

  clearTurn(input) {
    const prefix = JSON.stringify([input.agentId, input.sessionKey, input.runId]).slice(0, -1) + ",";
    for (const key of this.#records.keys()) if (key.startsWith(prefix)) this.#records.delete(key);
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, record] of this.#records) if (record.at <= cutoff) this.#records.delete(key);
  }
}

export function createSkillPreflightReadHooks({ ledger, getConfig, getTurnContext = (_event, ctx) => ctx }) {
  return {
    afterToolCall(event, ctx) {
      if (event?.toolName !== "read" || event.error || event.result?.isError) return undefined;
      const turn = getTurnContext(event, ctx);
      const filePath = readPath(event.params);
      if (!turn || !filePath) return undefined;
      const grant = (getConfig()?.longTaskSkillGrants ?? []).find((item) =>
        item.agentId === turn.agentId && isSkillDocument(item.rootPath, filePath));
      if (!grant) return undefined;
      return ledger.recordRead({ ...turn, skillName: grant.name, rootPath: grant.rootPath, filePath });
    },
  };
}

function readPath(params) {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    if (typeof params?.[key] === "string" && path.isAbsolute(params[key])) return params[key];
  }
  return "";
}

function recordKey(input) {
  const values = [input?.agentId, input?.sessionKey, input?.runId, input?.skillName, input?.rootPath];
  return values.every((value) => typeof value === "string" && value.trim()) ? JSON.stringify(values) : "";
}

function isSkillDocument(root, file) {
  try {
    return typeof root === "string" && path.isAbsolute(root) &&
      fs.realpathSync(file) === path.join(fs.realpathSync(root), "SKILL.md");
  } catch {
    // An unavailable or escaped document cannot establish execution readiness.
    return false;
  }
}

function documentVersion(input) {
  const file = input?.filePath || path.join(input.rootPath, "SKILL.md");
  if (!isSkillDocument(input.rootPath, file)) return "";
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function rejected(reason) { return { ok: false, reason }; }

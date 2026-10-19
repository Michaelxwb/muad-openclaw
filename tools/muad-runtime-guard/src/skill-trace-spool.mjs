// Skill trace spool: path creation, JSONL parsing, and orphan cleanup.
//
// The Python helper appends one JSON line per request plus an abort/summary
// line. The guard owns the spool directory and file modes (0700/0600) and is
// the only component that uploads or deletes spool files.

import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";

export const SKILL_TRACE_SPOOL_ROOT = "/tmp/muad-runtime-queues/skill-trace";
export const SKILL_TRACE_LOG_PREFIX = "[muad-runtime-guard][skill-trace]";
export const MAX_TRACE_EVENTS = 2_000;
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Spool file names are derived only from the execution id (a UUID); anything
// else must not reach the filesystem.
const EXECUTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SPOOL_FILE_PATTERN = /^[0-9a-f-]{36}\.jsonl$/iu;
const COUNTER_FILE_PATTERN = /^[0-9a-f-]{36}\.jsonl\.limit\.json$/iu;
export const COUNTER_SUFFIX = ".limit.json";
const MAX_INTERFACE_PATH = 200;
const MAX_SUMMARY_LENGTH = 200;
const MAX_TRACE_ID_LENGTH = 128;

export function isSafeExecutionId(value) {
  return typeof value === "string" && EXECUTION_ID_PATTERN.test(value);
}

export function ensureSkillTraceSpool({ rootDir = SKILL_TRACE_SPOOL_ROOT, executionId } = {}) {
  if (!isSafeExecutionId(executionId)) throw new Error("invalid execution id");
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is a creation-time hint; enforce it on pre-existing dirs too.
  chmodSync(rootDir, 0o700);
  const file = path.join(rootDir, `${executionId}.jsonl`);
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  return file;
}

export function spoolFileFor(rootDir, executionId) {
  return path.join(rootDir, `${executionId}.jsonl`);
}

export function counterFileFor(rootDir, executionId) {
  // Must match the SDK sidecar name: it appends ".limit.json" to the spool path
  // (<execution>.jsonl), so the file is <execution>.jsonl.limit.json.
  return spoolFileFor(rootDir, executionId) + COUNTER_SUFFIX;
}

export function readSkillTraceCounter({ rootDir = SKILL_TRACE_SPOOL_ROOT, executionId } = {}) {
  if (!isSafeExecutionId(executionId)) return null;
  try {
    return JSON.parse(readFileSync(counterFileFor(rootDir, executionId), "utf8"));
  } catch {
    return null;
  }
}

export function parseSkillTraceSpool(source, { executionId = "", now = Date.now(), counter = null } = {}) {
  const records = parseLines(source);
  const summary = lastRecord(records, "summary");
  const abort = records.find((record) => record.kind === "abort") ?? null;
  const httpRecords = records.filter(isHttpRecord);

  const events = [];
  let dropped = 0;
  let seq = 0;
  for (const record of records) {
    if (record.kind === "summary" || !isTraceRecord(record)) continue;
    if (events.length >= MAX_TRACE_EVENTS) {
      dropped += 1;
      continue;
    }
    seq += 1;
    events.push(toEvent(record, seq, executionId, now));
  }

  let hosts = normalizeHosts(summary?.hosts) ?? hostsFrom(httpRecords);
  let topInterfaces = normalizeInterfaces(summary?.topInterfaces) ?? topInterfacesFrom(httpRecords);
  let requestCount = integer(summary?.totalRequests) ?? httpRecords.length;
  let errorCount = integer(summary?.errorCount) ?? httpRecords.filter(isErrorRecord).length;
  let aborted = summary?.aborted === true || abort !== null;
  let abortInterface = aborted ? (text(summary?.abortInterface) || text(abort?.interface)) : "";
  let abortCount = integer(summary?.abortCount) ?? integer(abort?.count);
  let cumulative = false;

  if (isRecord(counter)) {
    requestCount = integer(counter.total) ?? requestCount;
    errorCount = integer(counter.errors) ?? errorCount;
    cumulative = Number.isInteger(counter.total);
    const counterHosts = normalizeHosts(counter.hosts);
    if (counterHosts) hosts = counterHosts;
    const counterTop = normalizeInterfaces(counter.topInterfaces);
    if (counterTop) topInterfaces = counterTop;
    if (counter.aborted === true) {
      aborted = true;
      abortInterface = text(counter.abortInterface) || abortInterface;
      abortCount = integer(counter.abortCount) ?? abortCount;
    }
  }

  const metrics = {
    requestCount,
    errorCount,
    distinctHosts: Object.keys(hosts).length,
    maxBurstPer10s: integer(summary?.maxBurst10s) ?? 0,
    topInterfaces,
    detailTruncated: summary?.truncated === true || dropped > 0,
    aborted,
    abortReason: aborted ? (text(summary?.abortReason) || text(abort?.reason) || "request_limit") : "",
    abortInterface: aborted ? abortInterface : "",
    abortCount: null,
    cumulative,
  };
  if (aborted && abortCount !== null) metrics.abortCount = abortCount;

  return { metrics, events, aborted, hasSummary: summary !== null, hosts, interfaces: topInterfaces };
}

export function cleanupSkillTraceSpools({
  rootDir = SKILL_TRACE_SPOOL_ROOT, now = Date.now(), maxAgeMs = SPOOL_MAX_AGE_MS,
  log = () => {},
} = {}) {
  let names = [];
  try {
    names = readdirSync(rootDir);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    if (!SPOOL_FILE_PATTERN.test(name) && !COUNTER_FILE_PATTERN.test(name)) continue;
    const file = path.join(rootDir, name);
    try {
      if (now - statSync(file).mtimeMs <= maxAgeMs) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      // A concurrent exec may delete or rewrite the file; cleanup is best-effort.
    }
  }
  log(`${SKILL_TRACE_LOG_PREFIX} action=cleanup removed=${removed}`);
  return { removed };
}

function parseLines(text) {
  const records = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (isRecord(value)) records.push(value);
    } catch {
      // Helper writes are append-only; a torn last line must not drop prior events.
    }
  }
  return records;
}

function lastRecord(records, kind) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].kind === kind) return records[index];
  }
  return null;
}

function isHttpRecord(record) {
  return record.kind === "http" || (record.kind === undefined && Boolean(record.method || record.path));
}

function isTraceRecord(record) {
  return record.kind === "abort" || isHttpRecord(record);
}

function isErrorRecord(record) {
  const status = integer(record.status);
  return Boolean(text(record.errorClass)) || (status !== null && status >= 400);
}

function toEvent(record, seq, executionId, now) {
  const kind = record.kind === "abort" ? "abort" : "http";
  const occurredAt = isoTime(record.ts, now);
  const event = {
    eventId: `${executionId}:${seq}`,
    seq,
    occurredAt,
    kind,
    // The Console schema only accepts ok/error; abort is carried by `kind`.
    status: kind === "abort" ? "error" : (isErrorRecord(record) ? "error" : "ok"),
    summary: summaryText(record, kind),
    detail: text(record.errorClass),
  };
  const durationMs = integer(record.durationMs);
  if (durationMs !== null && durationMs >= 0) event.durationMs = durationMs;
  // Traceid is a request correlation id, not a credential; Console shows it so
  // operators can look the request up on the business platform.
  const traceId = text(record.traceId);
  if (kind === "http" && traceId) event.traceId = traceId.slice(0, MAX_TRACE_ID_LENGTH);
  return event;
}

function summaryText(record, kind) {
  if (kind === "abort") {
    const count = integer(record.count);
    const parts = ["request_limit", text(record.interface)];
    if (count !== null) parts.push(`count=${count}`);
    return parts.filter(Boolean).join(" ").slice(0, MAX_SUMMARY_LENGTH);
  }
  return [text(record.method), hostOf(record), text(record.path)]
    .filter(Boolean).join(" ").slice(0, MAX_SUMMARY_LENGTH);
}

function hostOf(record) {
  return text(record.host) || text(record.platform);
}

function hostsFrom(records) {
  const hosts = {};
  for (const record of records) {
    const host = hostOf(record);
    if (!host) continue;
    hosts[host] = (hosts[host] ?? 0) + 1;
  }
  return hosts;
}

function normalizeHosts(value) {
  if (!isRecord(value)) return null;
  const hosts = {};
  for (const [host, count] of Object.entries(value)) {
    const parsed = integer(count);
    if (text(host) && parsed !== null && parsed >= 0) hosts[text(host)] = parsed;
  }
  return hosts;
}

function normalizeInterfaces(value) {
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const count = integer(item.count);
    if (count === null) return null;
    items.push({
      host: text(item.host) || text(item.platform),
      method: text(item.method).toUpperCase(),
      path: text(item.path).slice(0, MAX_INTERFACE_PATH),
      count,
    });
  }
  return items;
}

function topInterfacesFrom(records) {
  const counts = new Map();
  for (const record of records) {
    const method = text(record.method).toUpperCase();
    const host = hostOf(record);
    const recordPath = text(record.path).slice(0, MAX_INTERFACE_PATH);
    if (!method || !host || !recordPath) continue;
    const key = JSON.stringify([host, method, recordPath]);
    const current = counts.get(key) ?? { host, method, path: recordPath, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count).slice(0, 10);
}

function isoTime(value, now) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : now).toISOString();
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function spoolExists(file) {
  return existsSync(file);
}

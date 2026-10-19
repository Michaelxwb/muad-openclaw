// Execution attribution for Skill trace uploads.
//
// A pod runs many users against one gateway and one guard instance. The trace
// pipeline must never attach one user's spool to another user's execution, so
// the guard keeps an explicit map from the execution's session identity
// (agentId + sessionKey + runId, or taskId for long tasks) to the execution
// record id reported by the audit hooks. resolve_exec_env does not always
// receive runId, so an exec may fall back to the session's sole execution;
// missing or conflicting mappings still fail closed: the exec env is not
// injected and no trace is written.

import { createTraceMetricsAccumulator } from "./skill-trace-metrics.mjs";

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2_000;

export function createSkillTraceExecutions({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const byExecution = new Map();
  const byKey = new Map();
  // resolve_exec_env does not always receive runId, while before_agent_run /
  // before_tool_call do. Keep a session index so an exec that lacks runId can
  // still resolve the session's sole execution; ambiguous sessions fail closed.
  const bySession = new Map();

  function register(input = {}) {
    prune();
    const executionId = textValue(input.executionId);
    const skillName = textValue(input.skillName);
    const key = keyFor(input);
    if (!executionId || !skillName || !key) return false;
    const existing = byExecution.get(executionId);
    if (existing && existing.key !== key) return false;
    const entry = existing ?? { executionId };
    const previousSessionKey = entry.sessionKey;
    const previousAgentId = entry.agentId;
    Object.assign(entry, {
      key,
      agentId: textValue(input.agentId) || previousAgentId || "",
      sessionKey: canonicalSessionKey(input.sessionKey) || previousSessionKey || "",
      skillName,
      route: entry.route ?? null,
      metrics: entry.metrics ?? createTraceMetricsAccumulator(),
      nextSeq: Number.isInteger(entry.nextSeq) && entry.nextSeq > 0 ? entry.nextSeq : 1,
      expiresAt: now() + ttlMs,
    });
    byExecution.set(executionId, entry);
    keySet(key).add(executionId);
    if (entry.sessionKey) sessionSet(entry.sessionKey, entry.agentId).add(executionId);
    if (previousSessionKey && (previousSessionKey !== entry.sessionKey || previousAgentId !== entry.agentId)) {
      sessionSet(previousSessionKey, previousAgentId).delete(executionId);
    }
    pruneOverflow();
    return true;
  }

  function resolve(input = {}) {
    return resolveEntry(input).entry;
  }

  // Like resolve(), but reports why a mapping was not usable so the hook can
  // log a stable diagnostic instead of guessing.
  function resolveEntry(input = {}) {
    prune();
    const key = keyFor(input);
    if (key) {
      const ids = byKey.get(key);
      if (!ids || ids.size === 0) return { entry: null, reason: "mapping_missing" };
      if (ids.size > 1) return { entry: null, reason: "mapping_conflict" };
      return entryFor(ids.values().next().value, "mapping_missing");
    }
    const sessionKey = canonicalSessionKey(input.sessionKey);
    if (!sessionKey) return { entry: null, reason: "identity_incomplete" };
    const ids = bySession.get(sessionIndexKey(sessionKey, textValue(input.agentId)));
    if (!ids || ids.size === 0) return { entry: null, reason: "mapping_missing" };
    if (ids.size > 1) return { entry: null, reason: "mapping_conflict" };
    return entryFor(ids.values().next().value, "mapping_missing");
  }

  function entryFor(executionId, missingReason) {
    const entry = byExecution.get(executionId);
    if (!entry) return { entry: null, reason: missingReason };
    // Sliding TTL: an exec that keeps running keeps its attribution alive.
    entry.expiresAt = now() + ttlMs;
    return { entry, reason: "" };
  }

  // Per-execution event sequence. Each exec batch reserves its own range so
  // multiple execs in one execution never collide on (execution_id, seq).
  function reserveSeq(executionId, count) {
    const entry = byExecution.get(textValue(executionId));
    if (!entry) return 0;
    const start = Number.isInteger(entry.nextSeq) && entry.nextSeq > 0 ? entry.nextSeq : 1;
    const size = Number.isInteger(count) && count > 0 ? count : 1;
    entry.nextSeq = start + size;
    entry.expiresAt = now() + ttlMs;
    return start;
  }

  function mergeMetrics(executionId, snapshot = {}) {
    const entry = byExecution.get(textValue(executionId));
    if (!entry?.metrics) return null;
    entry.expiresAt = now() + ttlMs;
    return entry.metrics.merge(snapshot);
  }

  function metricsSnapshot(executionId) {
    const entry = byExecution.get(textValue(executionId));
    if (!entry?.metrics) return null;
    entry.expiresAt = now() + ttlMs;
    return entry.metrics.snapshot();
  }

  // A completed turn must leave the session fallback index even though its
  // execution stays available for exact runId lookups (retries / metrics).
  // Otherwise the next turn in the same session sees two candidates and
  // resolve_exec_env fails closed with mapping_conflict.
  function endSession(input = {}) {
    const agentId = textValue(input.agentId);
    const sessionKey = canonicalSessionKey(input.sessionKey);
    const runId = textValue(input.runId);
    if (!agentId || !sessionKey) return false;
    const indexKey = sessionIndexKey(sessionKey, agentId);
    const ids = bySession.get(indexKey);
    if (!ids) return false;
    const key = runId ? keyFor({ agentId, sessionKey, runId }) : "";
    let removed = 0;
    for (const executionId of [...ids]) {
      const entry = byExecution.get(executionId);
      if (!entry) {
        ids.delete(executionId);
        continue;
      }
      if (key && entry.key !== key) continue;
      ids.delete(executionId);
      removed += 1;
    }
    if (ids.size === 0) bySession.delete(indexKey);
    return removed > 0;
  }

  function updateRoute(executionId, route) {
    const entry = byExecution.get(textValue(executionId));
    if (!entry) return false;
    const channel = textValue(route?.channel);
    const peerId = textValue(route?.peerId);
    if (!channel || !peerId) return false;
    entry.route = { channel, peerId };
    return true;
  }

  function clear() {
    byExecution.clear();
    byKey.clear();
    bySession.clear();
  }

  function keySet(key) {
    let ids = byKey.get(key);
    if (!ids) {
      ids = new Set();
      byKey.set(key, ids);
    }
    return ids;
  }

  function sessionSet(sessionKey, agentId) {
    const key = sessionIndexKey(sessionKey, agentId);
    let ids = bySession.get(key);
    if (!ids) {
      ids = new Set();
      bySession.set(key, ids);
    }
    return ids;
  }

  function prune() {
    const at = now();
    for (const [executionId, entry] of byExecution.entries()) {
      if (entry.expiresAt > at) continue;
      byExecution.delete(executionId);
      pruneIndex(byKey, entry.key, executionId);
      pruneIndex(bySession, sessionIndexKey(entry.sessionKey, entry.agentId), executionId);
    }
  }

  function pruneOverflow() {
    while (byExecution.size > MAX_ENTRIES) {
      const oldest = byExecution.keys().next().value;
      if (oldest === undefined) return;
      const entry = byExecution.get(oldest);
      byExecution.delete(oldest);
      pruneIndex(byKey, entry?.key, oldest);
      pruneIndex(bySession, sessionIndexKey(entry?.sessionKey, entry?.agentId), oldest);
    }
  }

  function pruneIndex(index, key, executionId) {
    if (!key) return;
    const ids = index.get(key);
    ids?.delete(executionId);
    if (ids && ids.size === 0) index.delete(key);
  }

  return {
    shared: true,
    register,
    resolve,
    resolveEntry,
    updateRoute,
    reserveSeq,
    mergeMetrics,
    metricsSnapshot,
    endSession,
    clear,
    size: () => byExecution.size,
  };
}

export function installSkillTraceExecutions(globals = globalThis, options = {}) {
  const symbol = Symbol.for("muad.skill.trace.executions");
  const existing = globals[symbol];
  if (existing?.shared === true) return existing;
  const registry = createSkillTraceExecutions(options);
  globals[symbol] = registry;
  return registry;
}

function keyFor(input) {
  const taskId = textValue(input.taskId);
  if (taskId) return JSON.stringify(["task", taskId]);
  const runId = textValue(input.runId);
  const sessionKey = canonicalSessionKey(input.sessionKey);
  if (!runId || !sessionKey) return "";
  return JSON.stringify(["run", textValue(input.agentId), sessionKey, runId]);
}

function canonicalSessionKey(value) {
  return textValue(value).replace(/^session:/u, "");
}

function sessionIndexKey(sessionKey, agentId) {
  const session = canonicalSessionKey(sessionKey);
  if (!session) return "";
  return JSON.stringify(["session", textValue(agentId), session]);
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

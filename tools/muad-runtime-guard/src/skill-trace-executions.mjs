// Execution attribution for Skill trace uploads.
//
// A pod runs many users against one gateway and one guard instance. The trace
// pipeline must never attach one user's spool to another user's execution, so
// the guard keeps an explicit map from the execution's session identity
// (sessionKey + runId, or taskId for long tasks) to the execution record id
// reported by the audit hooks. Missing or conflicting mappings fail closed:
// the exec env is not injected and no trace is written.

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 2_000;

export function createSkillTraceExecutions({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const byExecution = new Map();
  const byKey = new Map();

  function register(input = {}) {
    prune();
    const executionId = textValue(input.executionId);
    const skillName = textValue(input.skillName);
    const key = keyFor(input);
    if (!executionId || !skillName || !key) return false;
    const existing = byExecution.get(executionId);
    if (existing && existing.key !== key) return false;
    const entry = existing ?? { executionId };
    Object.assign(entry, {
      key,
      agentId: textValue(input.agentId),
      skillName,
      route: entry.route ?? null,
      expiresAt: now() + ttlMs,
    });
    byExecution.set(executionId, entry);
    keySet(key).add(executionId);
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
    if (!key) return { entry: null, reason: "identity_incomplete" };
    const ids = byKey.get(key);
    if (!ids || ids.size === 0) return { entry: null, reason: "mapping_missing" };
    if (ids.size > 1) return { entry: null, reason: "mapping_conflict" };
    const entry = byExecution.get(ids.values().next().value);
    if (!entry) {
      byKey.delete(key);
      return { entry: null, reason: "mapping_missing" };
    }
    return { entry, reason: "" };
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
  }

  function keySet(key) {
    let ids = byKey.get(key);
    if (!ids) {
      ids = new Set();
      byKey.set(key, ids);
    }
    return ids;
  }

  function prune() {
    const at = now();
    for (const [executionId, entry] of byExecution.entries()) {
      if (entry.expiresAt > at) continue;
      byExecution.delete(executionId);
      const ids = byKey.get(entry.key);
      ids?.delete(executionId);
      if (ids && ids.size === 0) byKey.delete(entry.key);
    }
  }

  function pruneOverflow() {
    while (byExecution.size > MAX_ENTRIES) {
      const oldest = byExecution.keys().next().value;
      if (oldest === undefined) return;
      const entry = byExecution.get(oldest);
      byExecution.delete(oldest);
      const ids = byKey.get(entry?.key);
      ids?.delete(oldest);
      if (ids && ids.size === 0) byKey.delete(entry?.key);
    }
  }

  return {
    shared: true,
    register,
    resolve,
    resolveEntry,
    updateRoute,
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

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

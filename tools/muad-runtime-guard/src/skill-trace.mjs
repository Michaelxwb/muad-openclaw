// Skill trace pipeline for the runtime guard.
//
// Attribution is keyed by sessionKey + runId (taskId for long tasks) and is
// registered by the audit hooks when an execution record is reported. The
// guard injects MUAD_EXECUTION_ID / MUAD_SKILL_NAME / MUAD_TRACE_SPOOL /
// MUAD_SKILL_REQUEST_LIMIT into exec, then reads the spool when the exec ends.
// Parsing and enqueueing happen inside the hook (milliseconds); the HTTP upload
// and the abort notification run on a bounded background queue so one user's
// execution can never block another user's turn.

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { notifyUser } from "../../shared/notify-user.mjs";
import {
  SKILL_TRACE_LOG_PREFIX, SKILL_TRACE_SPOOL_ROOT, cleanupSkillTraceSpools,
  ensureSkillTraceSpool, isSafeExecutionId, parseSkillTraceSpool, spoolFileFor,
} from "./skill-trace-spool.mjs";

const DEFAULT_QUEUE_LIMIT = 100;
const DEFAULT_REQUEST_LIMIT = 1_000;
const MAX_REQUEST_LIMIT = 1_000_000;
const MAX_RETRY_ENTRIES = 500;
const MAX_NOTIFIED_ENTRIES = 2_000;
const KNOWN_CHANNEL_TYPES = new Set(["wecom", "mattermost", "openclaw-weixin", "wechat", "weixin"]);

export function createSkillTraceHooks({
  getConfig = () => ({}),
  executions,
  client,
  notify = notifyUser,
  spoolRoot = SKILL_TRACE_SPOOL_ROOT,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  now = Date.now,
  log = () => {},
} = {}) {
  const diag = (message) => log(`${SKILL_TRACE_LOG_PREFIX} ${message}`);
  const queue = createBoundedQueue({
    limit: Number.isInteger(queueLimit) && queueLimit > 0 ? queueLimit : DEFAULT_QUEUE_LIMIT,
    log: diag,
  });
  const queued = new Set();
  const retries = new Map();
  const notified = new Set();
  let closed = false;

  function resolveExecEnv(event, ctx) {
    if (closed || text(event?.toolName) !== "exec") return undefined;
    const resolved = resolveEntry(event, ctx);
    if (!resolved.entry) {
      diag(`action=resolve outcome=${resolved.reason} agent=${text(ctx?.agentId) || "unknown"}`);
      return undefined;
    }
    const entry = resolved.entry;
    if (!isSafeExecutionId(entry.executionId) || !text(entry.skillName)) {
      diag(`action=resolve outcome=invalid_entry executionId=${entry.executionId}`);
      return undefined;
    }
    const route = resolveRoute(event, ctx);
    if (route.channel && route.peerId) executions.updateRoute(entry.executionId, route);
    let spoolPath;
    try {
      spoolPath = ensureSkillTraceSpool({ rootDir: spoolRoot, executionId: entry.executionId });
    } catch {
      diag(`action=spool outcome=failed executionId=${entry.executionId}`);
      return undefined;
    }
    return {
      MUAD_EXECUTION_ID: entry.executionId,
      MUAD_SKILL_NAME: entry.skillName,
      MUAD_TRACE_SPOOL: spoolPath,
      MUAD_SKILL_REQUEST_LIMIT: String(requestLimit(getConfig())),
    };
  }

  function afterToolCall(event, ctx) {
    if (closed) return undefined;
    retryPending();
    if (text(event?.toolName) !== "exec") return undefined;
    const resolved = resolveEntry(event, ctx);
    if (!resolved.entry) return undefined;
    const entry = resolved.entry;
    const spoolPath = spoolFileFor(spoolRoot, entry.executionId);
    let spoolText = "";
    try {
      if (existsSync(spoolPath)) spoolText = readFileSync(spoolPath, "utf8");
    } catch {
      diag(`action=read outcome=failed executionId=${entry.executionId}`);
      return undefined;
    }
    if (!spoolText.trim()) removeSpool(spoolPath);
    const parsed = parseSkillTraceSpool(spoolText, {
      executionId: entry.executionId, now: now(),
    });
    // Old Skills write no helper events but still get one exec event; helper
    // events follow it with a stable +1 shift so exec is always first.
    const events = [
      execTraceEvent(entry.executionId, event, now()),
      ...parsed.events.map((item) => ({ ...item, seq: item.seq + 1 })),
    ];
    const job = {
      executionId: entry.executionId,
      agentId: text(entry.agentId),
      skillName: entry.skillName,
      route: entry.route,
      spoolPath,
      payload: { agentId: entry.agentId, metrics: parsed.metrics, events },
      aborted: parsed.aborted,
    };
    if (parsed.aborted) scheduleNotify(job);
    scheduleTrace(job);
    return undefined;
  }

  function retryPending() {
    for (const job of [...retries.values()]) scheduleTrace(job, { fromRetry: true });
  }

  function scheduleTrace(job, { fromRetry = false } = {}) {
    if (queued.has(job.executionId)) {
      retries.set(job.executionId, job);
      return;
    }
    const accepted = queue.enqueue(async () => {
      try {
        await client.report(job.executionId, job.payload);
        retries.delete(job.executionId);
        removeSpool(job.spoolPath);
        diag(`action=upload outcome=ok executionId=${job.executionId} events=${job.payload.events.length}`);
      } catch (error) {
        retries.set(job.executionId, job);
        pruneRetries();
        diag(`action=upload outcome=failed executionId=${job.executionId} retryable=${error?.retryable === true}`);
      } finally {
        queued.delete(job.executionId);
      }
    });
    if (!accepted) {
      retries.set(job.executionId, job);
      pruneRetries();
      diag(`action=enqueue outcome=dropped reason=queue_full kind=trace executionId=${job.executionId}`);
      return;
    }
    queued.add(job.executionId);
    if (!fromRetry) diag(`action=enqueue outcome=accepted kind=trace executionId=${job.executionId}`);
  }

  function scheduleNotify(job) {
    if (notified.has(job.executionId)) return;
    if (!job.route?.channel || !job.route?.peerId) {
      diag(`action=notify outcome=skipped reason=route_unavailable executionId=${job.executionId}`);
      return;
    }
    notified.add(job.executionId);
    pruneNotified();
    const input = {
      channel: job.route.channel,
      peerId: job.route.peerId,
      text: abortMessage(job, getConfig()),
    };
    const accepted = queue.enqueue(async () => {
      try {
        const result = await notify(input);
        if (result?.ok === false) throw new Error(result.error || "notify failed");
        diag(`action=notify outcome=ok executionId=${job.executionId}`);
      } catch {
        // Notification is best-effort: termination and trace upload already happened.
        diag(`action=notify outcome=failed executionId=${job.executionId}`);
      }
    });
    if (!accepted) diag(`action=enqueue outcome=dropped reason=queue_full kind=notify executionId=${job.executionId}`);
  }

  function removeSpool(spoolPath) {
    try {
      unlinkSync(spoolPath);
    } catch {
      // Another hook or the 24h cleanup may already have removed it.
    }
  }

  function pruneRetries() {
    while (retries.size > MAX_RETRY_ENTRIES) {
      const oldest = retries.keys().next().value;
      if (oldest === undefined) return;
      retries.delete(oldest);
    }
  }

  function pruneNotified() {
    while (notified.size > MAX_NOTIFIED_ENTRIES) {
      const oldest = notified.values().next().value;
      if (oldest === undefined) return;
      notified.delete(oldest);
    }
  }

  function resolveEntry(event, ctx) {
    if (!executions || typeof executions.resolveEntry !== "function") {
      return { entry: null, reason: "mapping_missing" };
    }
    const identity = executionIdentity(event, ctx);
    if (!identity) return { entry: null, reason: "identity_incomplete" };
    return executions.resolveEntry(identity);
  }

  return {
    resolveExecEnv,
    afterToolCall,
    flush: () => queue.onIdle(),
    close: () => { closed = true; },
  };
}

// Startup cleanup is idempotent and runs once per process, before any exec.
export function installSkillTraceCleanup(globals = globalThis, {
  rootDir = SKILL_TRACE_SPOOL_ROOT, now = Date.now, log = () => {},
} = {}) {
  const symbol = Symbol.for("muad.skill.trace.cleanup");
  if (globals[symbol] === true) return;
  globals[symbol] = true;
  try {
    cleanupSkillTraceSpools({ rootDir, now, log });
  } catch {
    log(`${SKILL_TRACE_LOG_PREFIX} action=cleanup outcome=failed`);
  }
}

function executionIdentity(event, ctx) {
  const sessionKey = text(event?.sessionKey) || text(ctx?.sessionKey);
  const { agentId: sessionAgent, rest } = parseSessionKey(sessionKey);
  if (rest.startsWith("longtask:")) {
    const taskId = text(rest.slice("longtask:".length).split(":")[0]);
    return taskId ? { taskId } : null;
  }
  const runId = text(event?.runId) || text(ctx?.runId);
  if (!runId || !sessionKey) return null;
  return {
    agentId: text(ctx?.agentId) || text(event?.agentId) || sessionAgent,
    sessionKey,
    runId,
  };
}

function resolveRoute(event, ctx) {
  const sessionKey = text(event?.sessionKey) || text(ctx?.sessionKey);
  const channel = channelFromSession(sessionKey) || text(event?.channel) || text(ctx?.channel);
  const peerId = text(ctx?.channelContext?.sender?.id) ||
    text(event?.senderId) || text(ctx?.senderId) ||
    text(event?.replyToId) || text(event?.replyTo) ||
    text(parseSessionKey(sessionKey).peerId);
  return {
    channel,
    peerId: normalizePeerId(peerId, channel),
  };
}

function channelFromSession(sessionKey) {
  const { rest } = parseSessionKey(sessionKey);
  const channel = text(rest.split(":")[0]).toLowerCase();
  return KNOWN_CHANNEL_TYPES.has(channel) ? channel : "";
}

function normalizePeerId(value, channel) {
  const raw = text(value);
  if (!raw) return "";
  const prefixes = channel === "mattermost"
    ? ["mattermost:", "user:"]
    : channel === "wecom" ? ["wecom:"] : [];
  const lower = raw.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) return raw.slice(prefix.length).trim();
  }
  return raw;
}

function requestLimit(config) {
  const value = config?.skillRequestLimit;
  return Number.isInteger(value) && value >= 0 && value <= MAX_REQUEST_LIMIT ? value : DEFAULT_REQUEST_LIMIT;
}

function abortMessage(job, config) {
  const limit = requestLimit(config);
  const skillName = text(job.skillName) || "skill";
  if (text(config?.locale) === "en") {
    return `Skill "${skillName}" exceeded the request limit (${limit} per interface); this run was stopped.`;
  }
  return `Skill「${skillName}」请求次数超过上限（单接口 ${limit} 次），已终止本次执行。`;
}

function parseSessionKey(value) {
  const sessionKey = text(value);
  const normalized = sessionKey.startsWith("session:")
    ? sessionKey.slice("session:".length)
    : sessionKey;
  const parts = normalized.split(":");
  if (parts[0] !== "agent" || !parts[1]) return { agentId: "", rest: "", peerId: "" };
  return {
    agentId: parts[1],
    rest: parts.slice(2).join(":"),
    peerId: parts.at(-1) ?? "",
  };
}

// One exec event per execution, derived from the trusted tool event. Commands
// are collapsed to a single line and never include stderr/cookie material.
function execTraceEvent(executionId, event, at) {
  const failed = Boolean(event?.error);
  const traceEvent = {
    eventId: `${executionId}:exec`,
    seq: 1,
    occurredAt: new Date(at).toISOString(),
    kind: "exec",
    status: failed ? "error" : "ok",
    summary: (execCommand(event) || "exec").slice(0, 200),
    detail: failed ? "exec_failed" : "",
  };
  const durationMs = integer(event?.durationMs);
  if (durationMs !== null && durationMs >= 0) traceEvent.durationMs = durationMs;
  return traceEvent;
}

function execCommand(event) {
  const params = event?.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return "";
  for (const key of ["command", "script", "cmd"]) {
    const value = text(params[key]);
    if (value) return value.replace(/\s+/gu, " ");
  }
  return "";
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function createBoundedQueue({ limit, log }) {
  const pending = [];
  const waiters = [];
  let active = false;

  function notifyIdle() {
    if (active || pending.length > 0) return;
    for (const resolve of waiters.splice(0)) resolve();
  }

  async function drain() {
    if (active) return;
    active = true;
    while (pending.length > 0) {
      const job = pending.shift();
      try {
        await job();
      } catch (error) {
        log(`action=queue outcome=error reason=${String(error?.message || error).slice(0, 120)}`);
      }
    }
    active = false;
    notifyIdle();
  }

  return {
    enqueue(job) {
      if (pending.length >= limit) return false;
      pending.push(job);
      void drain();
      return true;
    },
    onIdle() {
      if (!active && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    size: () => pending.length,
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

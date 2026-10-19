// Skill trace pipeline for the runtime guard.
//
// Attribution is keyed by sessionKey + runId (taskId for long tasks) and is
// registered by the audit hooks when an execution record is reported. The
// guard injects MUAD_EXECUTION_ID / MUAD_SKILL_NAME / MUAD_TRACE_SPOOL /
// MUAD_SKILL_REQUEST_LIMIT into exec, then reads the spool when the exec ends.
// Parsing and enqueueing happen inside the hook (milliseconds); the HTTP upload
// and the abort notification run on a bounded background queue so one user's
// execution can never block another user's turn.

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";

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
const MAX_SPOOL_STATES = 2_000;
const KNOWN_CHANNEL_TYPES = new Set(["wecom", "mattermost", "openclaw-weixin", "wechat", "weixin"]);

export function createSkillTraceHooks({
  getConfig = () => ({}),
  executions,
  client,
  notify = notifyUser,
  spoolRoot = SKILL_TRACE_SPOOL_ROOT,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  trustedSender = () => "",
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
  const spoolStates = new Map();
  let closed = false;

  function resolveExecEnv(event, ctx) {
    if (closed || !["exec", "bash"].includes(text(event?.toolName))) return undefined;
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
    const route = resolveRoute(event, ctx, trustedSender);
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
    if (!["exec", "bash"].includes(text(event?.toolName))) return undefined;
    const resolved = resolveEntry(event, ctx);
    if (!resolved.entry) return undefined;
    const entry = resolved.entry;
    const spoolPath = spoolFileFor(spoolRoot, entry.executionId);
    const state = spoolStateFor(entry.executionId);
    let spoolText = "";
    let stat = null;
    try {
      if (existsSync(spoolPath)) {
        stat = statSync(spoolPath);
        spoolText = readFileSync(spoolPath, "utf8");
      }
    } catch {
      diag(`action=read outcome=failed executionId=${entry.executionId}`);
      return undefined;
    }
    if (!stat) {
      state.ino = 0;
      state.offset = 0;
      state.lastJob = null;
    } else if (stat.ino !== state.ino) {
      state.ino = stat.ino;
      state.offset = 0;
      state.lastJob = null;
    }
    const offset = Number.isInteger(state.offset) && state.offset >= 0 && state.offset <= spoolText.length
      ? state.offset
      : 0;
    // Only consume complete lines; a torn trailing line is retried on the next
    // read instead of being skipped permanently.
    const completeEnd = spoolText.lastIndexOf("\n") + 1;
    const end = completeEnd > offset ? completeEnd : offset;
    const newText = spoolText.slice(offset, end);
    state.offset = end;

    if (!newText.trim()) {
      // No new helper output. A pending retry already owns this spool; reusing
      // it avoids duplicate event ids for the same failed batch.
      if (queued.has(entry.executionId) || retries.has(entry.executionId)) return undefined;
      if (state.lastJob) {
        scheduleTrace(state.lastJob);
        return undefined;
      }
    }

    const parsed = parseSkillTraceSpool(newText, {
      executionId: entry.executionId, now: now(),
    });
    const baseSeq = reserveBaseSeq(entry.executionId, 1 + parsed.events.length);
    if (!baseSeq) {
      diag(`action=seq outcome=failed executionId=${entry.executionId}`);
      return undefined;
    }
    // Old Skills write no helper events but still get one exec event; helper
    // events follow it with a stable seq so a retry uploads the same batch.
    const events = [
      execTraceEvent(entry.executionId, event, now(), baseSeq),
      ...parsed.events.map((item) => {
        const seq = baseSeq + item.seq;
        return { ...item, seq, eventId: `${entry.executionId}:${seq}` };
      }),
    ];
    const metrics = mergeMetrics(entry.executionId, parsed);
    const job = {
      executionId: entry.executionId,
      agentId: text(entry.agentId),
      skillName: entry.skillName,
      route: entry.route,
      spoolPath,
      payload: { agentId: entry.agentId, metrics, events },
      aborted: parsed.aborted,
    };
    state.lastJob = job;
    if (parsed.aborted) scheduleNotify(job);
    scheduleTrace(job);
    return undefined;
  }

  function reserveBaseSeq(executionId, count) {
    if (!executions || typeof executions.reserveSeq !== "function") return 1;
    return executions.reserveSeq(executionId, count);
  }

  function mergeMetrics(executionId, parsed) {
    if (!executions || typeof executions.mergeMetrics !== "function") return parsed.metrics;
    const merged = executions.mergeMetrics(executionId, {
      ...parsed.metrics,
      hasSummary: parsed.hasSummary,
      hosts: parsed.hosts,
      interfaces: parsed.interfaces,
    });
    return merged ?? parsed.metrics;
  }

  function spoolStateFor(executionId) {
    let state = spoolStates.get(executionId);
    if (!state) {
      state = { ino: 0, offset: 0, lastJob: null };
      spoolStates.set(executionId, state);
      while (spoolStates.size > MAX_SPOOL_STATES) {
        const oldest = spoolStates.keys().next().value;
        if (oldest === undefined) break;
        spoolStates.delete(oldest);
      }
    }
    return state;
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
        // Metrics are cumulative per execution. Use the latest snapshot at
        // upload time so a retried older batch cannot regress a newer count.
        const metrics = typeof executions?.metricsSnapshot === "function"
          ? executions.metricsSnapshot(job.executionId)
          : null;
        const payload = metrics ? { ...job.payload, metrics } : job.payload;
        await client.report(job.executionId, payload);
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
      } catch (error) {
        // Notification is best-effort: termination and trace upload already happened.
        const detail = text(error?.message);
        const reason = detail.includes("timed out") ? "timeout" : "delivery_failed";
        diag(`action=notify outcome=failed reason=${reason} executionId=${job.executionId}`);
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
  if (!sessionKey) return null;
  const { agentId: sessionAgent, rest } = parseSessionKey(sessionKey);
  // Never let a session key claim a different agent than the trusted hook
  // context; the registry also indexes by agentId, so a mismatch must not
  // silently fall back to another user's session.
  const contextAgent = text(ctx?.agentId) || text(event?.agentId);
  if (sessionAgent && contextAgent && sessionAgent !== contextAgent) return null;
  const agentId = contextAgent || sessionAgent;
  if (rest.startsWith("longtask:")) {
    const taskId = text(rest.slice("longtask:".length).split(":")[0]);
    return taskId ? { taskId } : null;
  }
  const runId = text(event?.runId) || text(ctx?.runId);
  // resolve_exec_env often omits runId; the registry then resolves the
  // session's sole execution and fails closed when the session is ambiguous.
  return { agentId, sessionKey, runId };
}

function resolveRoute(event, ctx, getTrustedSender = () => "") {
  const sessionKey = text(event?.sessionKey) || text(ctx?.sessionKey);
  const channel = channelFromSession(sessionKey) || text(event?.channel) || text(ctx?.channel);
  const agentId = text(ctx?.agentId) || text(event?.agentId) || parseSessionKey(sessionKey).agentId;
  let trusted = "";
  try {
    trusted = text(getTrustedSender(agentId, sessionKey));
  } catch {
    // Route correction must never break the trace hook.
  }
  // A multi-user gateway uses the agent id as the session-key tail. Prefer the
  // trusted sender cached by before_agent_run before any event/session fallback.
  const peerId = trusted ||
    text(ctx?.channelContext?.sender?.id) ||
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
  const metrics = job?.payload?.metrics ?? {};
  const abortInterface = text(metrics.abortInterface);
  const abortCount = Number.isInteger(metrics.abortCount) ? metrics.abortCount : null;
  if (text(config?.locale) === "en") {
    const lines = [
      `Skill "${skillName}" exceeded the request limit (${limit} per interface); this run was stopped.`,
    ];
    if (abortInterface) lines.push(`Interface: ${abortInterface}`);
    lines.push(`Limit: ${limit} request(s) per interface`);
    if (abortCount !== null) lines.push(`Blocked at request #${abortCount}`);
    return lines.join("\n");
  }
  const lines = [`⚠️ Skill「${skillName}」请求次数超过上限，本次执行已终止。`];
  if (abortInterface) lines.push(`接口：${abortInterface}`);
  lines.push(`上限：单接口 ${limit} 次`);
  if (abortCount !== null) lines.push(`拦截：第 ${abortCount} 次请求`);
  return lines.join("\n");
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
function execTraceEvent(executionId, event, at, seq) {
  const failed = Boolean(event?.error);
  const traceEvent = {
    eventId: `${executionId}:${seq}`,
    seq,
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

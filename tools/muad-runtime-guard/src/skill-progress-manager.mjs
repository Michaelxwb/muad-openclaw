import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { notifyUser } from "../../shared/notify-user.mjs";
import { ProgressEventBridge } from "./progress-event-bridge.mjs";
import { renderProgressText, validateProgressEvent } from "./skill-progress-policy.mjs";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const CHANNEL_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIRECT_SESSION_PATTERN = /^agent:([^:]+):([^:]+):direct:(.+)$/u;

export class SkillProgressManager {
  #bridge;
  #closed = false;
  #executions = new Map();
  #finishTimeoutMs;
  #log;
  #maxPending;
  #notify;
  #notifyTimeoutMs;

  constructor(options = {}) {
    this.#log = callback(options.log, () => {});
    this.#notify = callback(options.notify, notifyUser);
    this.#notifyTimeoutMs = positiveInteger(options.notifyTimeoutMs ?? 31_000, "invalid_notify_timeout");
    this.#finishTimeoutMs = positiveInteger(options.finishTimeoutMs ?? 1_000, "invalid_finish_timeout");
    this.#maxPending = positiveInteger(options.maxPendingPerExecution ?? 32, "invalid_queue_capacity");
    this.#bridge = options.bridge ?? new ProgressEventBridge({
      rootDir: options.rootDir,
      onEvent: (executionKey, event) => this.reportProgress(executionKey, event),
      log: this.#log,
    });
    requireBridge(this.#bridge);
    this.shared = true;
    this.closed = false;
  }

  registerForeground(input = {}) {
    if (this.#closed) return rejectedRegistration("manager_closed");
    const normalized = normalizeForeground(input);
    if (!normalized.ok) return rejectedRegistration(normalized.reason);
    return this.#register(normalized.context);
  }

  registerBackground(input = {}) {
    if (this.#closed) return rejectedRegistration("manager_closed");
    const normalized = normalizeBackground(input);
    if (!normalized.ok) return rejectedRegistration(normalized.reason);
    return this.#register(normalized.context);
  }

  progressEnvForExec(input = {}) {
    for (const state of this.#executions.values()) {
      if (matchesExecution(state, input)) return { ...state.env };
    }
    return {};
  }

  // 前台路由的 peerId 默认取 session key 末段，但多用户网关下该段可能是 agent id
  // 而非真实 IM 用户 id。OpenClaw core 在 resolve_exec_env ctx 里提供的
  // channelContext.sender.id 来自入站消息（非模型可控），是可信的收件人来源。
  applyTrustedSender(executionKey, senderId) {
    const state = this.#executions.get(String(executionKey ?? ""));
    const peerId = text(senderId);
    if (!state || !validPeerId(peerId) || state.route.peerId === peerId) return false;
    state.route = { ...state.route, peerId };
    logDiagnostic(this.#log, state, "none", "route", "updated", `peer=${peerId}`);
    return true;
  }

  applyTrustedWorkspace(executionKey, workspace) {
    const state = this.#executions.get(String(executionKey ?? ""));
    const root = canonicalDirectory(workspace);
    if (!state || !root || state.workspace === root) return false;
    state.workspace = root;
    return true;
  }

  reportProgress(executionKey, unknownEvent) {
    const state = this.#executions.get(String(executionKey ?? ""));
    if (!state || !state.accepting) return { accepted: false, reason: "execution_finished" };
    const validation = validateProgressEvent(unknownEvent);
    if (!validation.ok) return this.#drop(state, "report", validation.reason);
    const event = validation.event;
    // type="log" 是 muad-progress CLI 的诊断事件：只进 openclaw 日志，不投递 IM、不占队列。
    if (event.type === "log") {
      logDiagnostic(this.#log, state, event.stage, "cli", "logged", event.text);
      return { accepted: true };
    }
    if (!validMediaFiles(event.media, state.workspace)) return this.#drop(state, "report", "media_invalid");
    if (state.pending >= this.#maxPending) return this.#drop(state, "enqueue", "queue_capacity");
    enqueueDelivery(state, event, this.#notify, this.#notifyTimeoutMs, this.#log);
    logDiagnostic(this.#log, state, event.stage, "enqueue", "accepted", "queued");
    return { accepted: true };
  }

  async finish(executionKey) {
    const state = this.#executions.get(String(executionKey ?? ""));
    if (!state) return { finished: true, reason: "execution_not_found" };
    if (!state.finishPromise) state.finishPromise = this.#finishExecution(state);
    return state.finishPromise;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.closed = true;
    for (const state of this.#executions.values()) state.accepting = false;
    this.#executions.clear();
    try {
      this.#bridge.close();
    } catch {
      logStable(this.#log, "action=close outcome=failed reason=bridge_close_failed");
    }
  }

  #register(context) {
    const executionKey = randomBytes(24).toString("base64url");
    let bridgeRegistration;
    try {
      bridgeRegistration = this.#bridge.register({ executionKey });
    } catch {
      logStable(this.#log, `execution=${executionKey} action=register outcome=failed reason=bridge_unavailable`);
      return rejectedRegistration("bridge_unavailable");
    }
    const env = progressEnv(bridgeRegistration.eventsFile, context.skillName);
    const state = executionState(executionKey, context, env);
    this.#executions.set(executionKey, state);
    logDiagnostic(this.#log, state, "none", "register", "accepted", "registered");
    return { registered: true, executionKey, env };
  }

  #drop(state, action, reason) {
    logDiagnostic(this.#log, state, "none", action, "dropped", reason);
    return { accepted: false, reason };
  }

  async #finishExecution(state) {
    let bridgeReason = "";
    try {
      const result = await this.#bridge.finish(state.executionKey, { timeoutMs: this.#finishTimeoutMs });
      bridgeReason = result?.reason ?? "";
    } catch {
      bridgeReason = "bridge_finish_failed";
    }
    state.accepting = false;
    const settled = await settlesWithin(state.tail, this.#finishTimeoutMs);
    const reason = settled ? bridgeReason : "send_timeout";
    logDiagnostic(this.#log, state, "none", "finish", "completed", reason || "settled");
    this.#executions.delete(state.executionKey);
    return { finished: true, ...(reason ? { reason } : {}) };
  }
}

function enqueueDelivery(state, event, notify, timeoutMs, log) {
  state.pending += 1;
  const input = {
    channel: state.route.channel,
    peerId: state.route.peerId,
    text: renderProgressText(event, state),
    mediaPaths: event.media ?? [],
  };
  state.tail = state.tail
    .then(() => notifyOutcome(notify, input, timeoutMs))
    .then(({ outcome, reason }) => logDiagnostic(log, state, event.stage, "deliver", outcome, reason || outcome))
    .finally(() => { state.pending -= 1; });
}

async function notifyOutcome(notify, input, timeoutMs) {
  const operation = Promise.resolve()
    .then(() => notify(input))
    .then((result) => result?.ok === true
      ? { outcome: "delivered" }
      : { outcome: "notify_failed", reason: diagnosticDetail(result?.error) }, () => ({ outcome: "notify_rejected" }));
  return raceTimeout(operation, timeoutMs, { outcome: "notify_timeout" });
}

// notifyUser 的 error 是我们自己拼的稳定文案（含 message send 的失败原因），
// 压成单行并截断后进日志，便于排障（如 Unknown target "…" for Mattermost）。
function diagnosticDetail(error) {
  return String(error ?? "").replace(/\s+/gu, " ").trim().slice(0, 200);
}

function raceTimeout(operation, timeoutMs, timeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutValue), timeoutMs); });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function settlesWithin(operation, timeoutMs) {
  return raceTimeout(operation.then(() => true, () => true), timeoutMs, false);
}

function normalizeForeground(input) {
  const agentId = text(input.agentId);
  const match = DIRECT_SESSION_PATTERN.exec(text(input.sessionKey));
  if (!match) return { ok: false, reason: "route_invalid" };
  if (!agentId || match[1] !== agentId) return { ok: false, reason: "identity_mismatch" };
  const base = normalizeIdentity(input, "runId");
  if (!base.ok || !validRoute(match[2], match[3])) return { ok: false, reason: "route_invalid" };
  // 事件携带的 senderId（OpenClaw core 提供）优先于 session key 末段：
  // 多用户网关下 session key 的 direct 段可能是 agent id，直接投递会 Unknown target。
  const senderId = text(input.senderId);
  return { ok: true, context: {
    ...base.context, kind: "foreground", sessionKey: text(input.sessionKey),
    route: { channel: match[2], peerId: validPeerId(senderId) ? senderId : match[3] },
  } };
}

function normalizeBackground(input) {
  const base = normalizeIdentity(input, "taskId");
  const channel = text(input.replyChannel);
  const peerId = text(input.peerId);
  if (!base.ok || !validRoute(channel, peerId)) return { ok: false, reason: "route_invalid" };
  return { ok: true, context: {
    ...base.context, kind: "background", route: { channel, peerId },
  } };
}

function normalizeIdentity(input, identityField) {
  const identity = text(input[identityField]);
  const agentId = text(input.agentId);
  const skillName = text(input.skillName);
  if (!identity || !agentId || !SKILL_NAME_PATTERN.test(skillName)) return { ok: false };
  return { ok: true, context: {
    [identityField]: identity, agentId, skillName,
    locale: text(input.locale) === "en" ? "en" : "zh",
  } };
}

function executionState(executionKey, context, env) {
  return {
    executionKey, ...context, env, accepting: true, pending: 0,
    tail: Promise.resolve(), finishPromise: undefined, workspace: "",
  };
}

function canonicalDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return "";
  try {
    const resolved = realpathSync(value);
    return statSync(resolved).isDirectory() ? resolved : "";
  } catch {
    return "";
  }
}

function validMediaFiles(media, workspace) {
  if (media === undefined) return true;
  const root = canonicalDirectory(workspace);
  if (!root) return false;
  try {
    return media.every((item) => {
      const resolved = realpathSync(item);
      const relative = path.relative(root, resolved);
      return statSync(resolved).isFile() && relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    });
  } catch {
    return false;
  }
}

function matchesExecution(state, input) {
  if (state.kind === "foreground") {
    return state.runId === text(input.runId) && state.agentId === text(input.agentId) &&
      state.sessionKey === text(input.sessionKey);
  }
  return state.taskId === text(input.taskId) && state.agentId === text(input.agentId);
}

function progressEnv(eventsFile, skillName) {
  return typeof eventsFile === "string" && eventsFile.startsWith("/")
    ? { MUAD_PROGRESS_EVENTS_FILE: eventsFile, MUAD_SKILL_NAME: skillName }
    : {};
}

function validRoute(channel, peerId) {
  return CHANNEL_PATTERN.test(channel) && validPeerId(peerId);
}

function validPeerId(peerId) {
  return peerId.length > 0 && peerId.length <= 512 && !/[\r\n\0]/u.test(peerId);
}

function rejectedRegistration(reason) {
  return { registered: false, reason };
}

function requireBridge(bridge) {
  if (![bridge?.register, bridge?.finish, bridge?.close].every((value) => typeof value === "function")) {
    throw new Error("invalid progress bridge");
  }
}

function logDiagnostic(log, state, stage, action, outcome, reason) {
  logStable(log, `execution=${state.executionKey} kind=${state.kind} stage=${stage} action=${action} outcome=${outcome} reason=${reason}`);
}

function logStable(log, detail) {
  try {
    log(`[muad-runtime-guard][skill-progress] ${detail}`);
  } catch {
    // Logging is best-effort and must never alter the Skill execution.
  }
}

function callback(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "function") throw new Error("invalid callback");
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

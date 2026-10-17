import process from "node:process";

import {
  SESSION_CANCEL_LOG,
  createSessionCancelController,
} from "./session-cancel-controller.mjs";
import {
  scanSessionProcesses,
  terminateConfirmed,
} from "./session-process-sweeper.mjs";

export { SESSION_CANCEL_LOG };

// 会话终止内部 RPC（仅控制面）：operator.write 作用域，绝不注册为模型工具。
// 只接受 Console 推导的 sessionKey；preview 只读；cancel 只处理 expected 中
// 指纹仍匹配的进程，过期指纹只跳过、不发信号。

export const SESSION_PREVIEW_METHOD = "muad.session.preview";
export const SESSION_CANCEL_METHOD = "muad.session.cancel";
export const SESSION_CANCEL_SCOPE = "operator.write";
export const SESSION_CANCEL_CAPABILITY_VERSION = 1;

const SESSION_CANCEL_SYMBOL = Symbol.for("muad.session.cancel");
const SESSION_KEY_PATTERN =
  /^agent:([a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?):([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_.-]{1,64}):([^\s:]{1,200})$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/u;
const MAX_SESSION_KEY_LENGTH = 256;
const MAX_OPERATOR_LENGTH = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function sessionCancelCapabilityOf(globals = globalThis) {
  return globals[SESSION_CANCEL_SYMBOL];
}

export function installSessionCancelCapability(globals, capability) {
  const current = globals[SESSION_CANCEL_SYMBOL];
  if (current && typeof current === "object") {
    Object.assign(current, capability);
    return current;
  }
  const holder = { available: false, version: 0, reason: "native_unavailable", ...capability };
  globals[SESSION_CANCEL_SYMBOL] = holder;
  return holder;
}

function agentSet(config) {
  if (config instanceof Set) return config;
  const ids = Array.isArray(config?.sessionAgentIds) ? config.sessionAgentIds : [];
  const profiles = Array.isArray(config?.agentProfiles)
    ? config.agentProfiles.map((item) => item?.agentId)
    : [];
  return new Set([...ids, ...profiles].filter((item) => typeof item === "string" && item));
}

export function validateSessionKey(sessionKey, knownAgents) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key || key.length > MAX_SESSION_KEY_LENGTH || key.includes(":longtask:")) {
    return { ok: false, reason: "invalid_session_key" };
  }
  const match = SESSION_KEY_PATTERN.exec(key);
  if (!match) return { ok: false, reason: "invalid_session_key" };
  if (!agentSet(knownAgents).has(match[1])) return { ok: false, reason: "invalid_session_key" };
  return { ok: true, sessionKey: key, agentId: match[1] };
}

function boundedOperator(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OPERATOR_LENGTH || CONTROL_CHARS.test(trimmed)) return "";
  return trimmed;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(params, expected) {
  const keys = Object.keys(params);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function validatePreviewRequest(params, knownAgents) {
  if (!isRecord(params) || !hasExactKeys(params, ["sessionKey", "requestedBy"])) {
    return { ok: false, reason: "invalid_request" };
  }
  const requestedBy = boundedOperator(params.requestedBy);
  if (!requestedBy) return { ok: false, reason: "invalid_request" };
  const key = validateSessionKey(params.sessionKey, knownAgents);
  if (!key.ok) return key;
  return { ok: true, request: { sessionKey: key.sessionKey, agentId: key.agentId, requestedBy } };
}

function validateExpected(expected) {
  if (!Array.isArray(expected)) return null;
  // 空数组是合法输入：没有已确认的进程时只 abort run，不杀任何进程。
  if (expected.length === 0) return [];
  const output = [];
  for (const item of expected) {
    if (!isRecord(item) || !hasExactKeys(item, ["pid", "fingerprint"])) return null;
    const pid = item.pid;
    const fingerprint = item.fingerprint;
    if (!Number.isInteger(pid) || pid <= 1) return null;
    if (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint)) return null;
    output.push({ pid, fingerprint });
  }
  return output;
}

export function validateCancelRequest(params, knownAgents) {
  if (!isRecord(params) || !hasExactKeys(params, ["sessionKey", "requestedBy", "expected"])) {
    return { ok: false, reason: "invalid_request" };
  }
  const requestedBy = boundedOperator(params.requestedBy);
  if (!requestedBy) return { ok: false, reason: "invalid_request" };
  const key = validateSessionKey(params.sessionKey, knownAgents);
  if (!key.ok) return key;
  const expected = validateExpected(params.expected);
  if (!expected) return { ok: false, reason: "invalid_expected" };
  return { ok: true, request: { sessionKey: key.sessionKey, agentId: key.agentId, requestedBy, expected } };
}

function unwrapRequest(request) {
  return request?.params ?? request;
}

function capabilityAvailable(capability) {
  return capability?.available === true;
}

function defaultUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function logLine(log, detail) {
  try {
    log(`${SESSION_CANCEL_LOG} ${detail}`);
  } catch {
    // Logging is best-effort and must never alter the cancel outcome.
  }
}

function resolveOptions(options) {
  const getConfig = typeof options.getConfig === "function"
    ? options.getConfig
    : () => options.config;
  return {
    knownAgents: () => agentSet(getConfig()),
    capability: options.capability,
    runtime: options.runtime ?? {},
    log: typeof options.log === "function" ? options.log : () => {},
    scan: typeof options.scan === "function" ? options.scan : scanSessionProcesses,
    controller: options.controller,
    sweeper: {
      procRoot: options.procRoot,
      uid: options.uid === undefined ? defaultUid() : options.uid,
      selfPid: options.selfPid,
      readFile: options.readFile,
      kill: options.kill,
      sleep: options.sleep,
      termWaitMs: options.termWaitMs,
      killWaitMs: options.killWaitMs,
      log: typeof options.log === "function" ? options.log : () => {},
    },
  };
}

function sessionController(ctx) {
  if (ctx.controller) return ctx.controller;
  return createSessionCancelController({ native: ctx.runtime.native, log: ctx.log });
}

export function createSessionPreviewHandler(options = {}) {
  const ctx = resolveOptions(options);
  return async (request = {}) => {
    const validated = validatePreviewRequest(unwrapRequest(request), ctx.knownAgents());
    if (!validated.ok) {
      logLine(ctx.log, `preview rejected reason=${validated.reason}`);
      return { ok: false, reason: validated.reason };
    }
    if (!capabilityAvailable(ctx.capability)) {
      logLine(ctx.log, `preview rejected reason=session_cancel_unavailable`);
      return { ok: false, reason: "session_cancel_unavailable" };
    }
    const { sessionKey, agentId } = validated.request;
    const run = await sessionController(ctx).activeRun(sessionKey);
    if (!run.available || run.reason) {
      logLine(ctx.log, `preview failed agent=${agentId} reason=${run.reason || "native_unavailable"}`);
      return { ok: false, reason: run.reason || "native_unavailable" };
    }
    const scan = ctx.scan({ ...ctx.sweeper, sessionKey });
    logLine(
      ctx.log,
      `preview agent=${agentId} active=${run.activeRun.active} candidates=${scan.processes.length}` +
        ` skipped_not_owner=${scan.skipped.notOwner} skipped_env_mismatch=${scan.skipped.envMismatch}` +
        ` skipped_permission_denied=${scan.skipped.permissionDenied}`,
    );
    return {
      ok: true,
      sessionKey,
      agentId,
      activeRun: run.activeRun,
      processes: scan.processes,
      skipped: {
        notOwner: scan.skipped.notOwner,
        envMismatch: scan.skipped.envMismatch,
        permissionDenied: scan.skipped.permissionDenied,
      },
    };
  };
}

function appendMissingExpected(processes, expected, selfPid) {
  const seen = new Set(processes.map((item) => item.pid));
  const output = [...processes];
  for (const item of expected) {
    if (seen.has(item.pid)) continue;
    const protectedPid = item.pid === 1 || item.pid === selfPid;
    output.push({
      pid: item.pid,
      outcome: "skipped",
      reason: protectedPid ? "protected" : "not_found",
    });
  }
  return output;
}

export function createSessionCancelHandler(options = {}) {
  const ctx = resolveOptions(options);
  return async (request = {}) => {
    const validated = validateCancelRequest(unwrapRequest(request), ctx.knownAgents());
    if (!validated.ok) {
      logLine(ctx.log, `cancel rejected reason=${validated.reason}`);
      return { ok: false, reason: validated.reason };
    }
    if (!capabilityAvailable(ctx.capability)) {
      logLine(ctx.log, `cancel rejected reason=session_cancel_unavailable`);
      return { ok: false, reason: "session_cancel_unavailable" };
    }
    const { sessionKey, agentId, expected } = validated.request;
    const abort = await sessionController(ctx).abort(sessionKey);
    if (abort.reason === "native_unavailable") {
      logLine(ctx.log, `cancel failed agent=${agentId} reason=native_unavailable`);
      return { ok: false, reason: "native_unavailable" };
    }
    const scan = ctx.scan({ ...ctx.sweeper, sessionKey });
    const termination = await terminateConfirmed(scan.processes, expected, { ...ctx.sweeper, sessionKey });
    const processes = appendMissingExpected(
      termination.processes, expected, ctx.sweeper.selfPid ?? process.pid,
    );
    const confirmed = abort.drained === true && termination.remaining.length === 0;
    logLine(
      ctx.log,
      `cancel agent=${agentId} aborted=${abort.aborted} drained=${abort.drained}` +
        ` confirmed=${confirmed} killed=${termination.killed} remaining=${termination.remaining.length}` +
        ` abort_reason=${abort.reason || "none"}`,
    );
    return {
      ok: true,
      aborted: abort.aborted,
      drained: abort.drained,
      confirmed,
      killed: termination.killed,
      remaining: termination.remaining,
      processes,
    };
  };
}

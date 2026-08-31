import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const DEFAULT_ROOT_DIR = "/tmp/muad-runtime-queues/skill-progress";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ACTIVE_ROOTS = new Set();
const READ_ANCHOR_BYTES = 64;
const LF = 0x0A;
const CR = 0x0D;

export const DEFAULT_PROGRESS_EVENT_LIMITS = Object.freeze({
  maxLineBytes: 16 * 1024,
  maxFileBytes: 1024 * 1024,
  maxReadBytesPerDrain: 64 * 1024,
  maxEventsPerDrain: 128,
});

export class ProgressEventBridgeError extends Error {
  constructor(code, cause) {
    super(`progress event bridge failed: ${code}`, cause ? { cause } : undefined);
    this.name = "ProgressEventBridgeError";
    this.code = code;
  }
}

export class ProgressEventBridge {
  #closed = false;
  #draining = false;
  #executions = new Map();
  #limits;
  #log;
  #onEvent;
  #rootDir;
  #scanIntervalMs;
  #timer;

  constructor(options = {}) {
    const rootDir = normalizeRoot(options.rootDir ?? DEFAULT_ROOT_DIR);
    const onEvent = requiredCallback(options.onEvent, "invalid_on_event");
    const log = optionalCallback(options.log, "invalid_log");
    const scanIntervalMs = positiveInteger(options.scanIntervalMs ?? 250, "invalid_scan_interval");
    const limits = normalizeLimits(options.limits);
    reserveRoot(rootDir);
    try {
      this.#rootDir = rootDir;
      this.#onEvent = onEvent;
      this.#log = log;
      this.#scanIntervalMs = scanIntervalMs;
      this.#limits = limits;
      ensurePrivateRoot(rootDir);
      removeOrphanExecutions(rootDir, log);
    } catch (error) {
      releaseRoot(rootDir);
      throw error;
    }
  }

  register({ executionKey } = {}) {
    this.#requireOpen();
    const key = normalizedExecutionKey(executionKey);
    if (this.#executions.has(key)) throw new ProgressEventBridgeError("execution_exists");
    const state = createExecution(this.#rootDir, key);
    this.#executions.set(key, state);
    this.#startScheduler();
    return registration(state);
  }

  drain(executionKey) {
    const state = this.#executions.get(String(executionKey ?? ""));
    if (!state) return drainResult({ reason: "execution_not_found" });
    try {
      return drainExecution(state, this.#limits, this.#onEvent, this.#log);
    } catch {
      diagnostic(this.#log, state, "drain", "failed", "read_failed");
      return drainResult({ reason: "read_failed" });
    }
  }

  async finish(executionKey, options = {}) {
    const key = String(executionKey ?? "");
    const state = this.#executions.get(key);
    if (!state) return { finished: true, reason: "execution_not_found" };
    if (state.finishPromise) return state.finishPromise;
    const timeoutMs = positiveInteger(options.timeoutMs ?? 500, "invalid_finish_timeout");
    state.finishPromise = this.#finishExecution(state, timeoutMs);
    return state.finishPromise;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopScheduler();
    for (const state of this.#executions.values()) cleanupExecution(state, this.#log);
    this.#executions.clear();
    releaseRoot(this.#rootDir);
  }

  async #finishExecution(state, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let result = drainResult();
    while (Date.now() <= deadline) {
      result = this.drain(state.executionKey);
      if (!result.hasMore) break;
      await nextTurn();
    }
    const reason = finishReason(state, result, deadline, this.#log);
    cleanupExecution(state, this.#log);
    this.#executions.delete(state.executionKey);
    if (this.#executions.size === 0) this.#stopScheduler();
    return { finished: true, ...(reason ? { reason } : {}) };
  }

  #requireOpen() {
    if (this.#closed) throw new ProgressEventBridgeError("bridge_closed");
  }

  #startScheduler() {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => this.#drainAll(), this.#scanIntervalMs);
    this.#timer.unref?.();
  }

  #stopScheduler() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #drainAll() {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      for (const key of this.#executions.keys()) this.drain(key);
    } finally {
      this.#draining = false;
    }
  }
}

function drainExecution(state, limits, onEvent, log) {
  const info = fstatSync(state.fd);
  if (fileWasRewritten(state, info.size)) resetAfterTruncate(state, log);
  if (state.blockedReason) return drainResult({ reason: state.blockedReason });
  if (info.size > limits.maxFileBytes) markFileCapacity(state, log);
  const readableEnd = Math.min(info.size, limits.maxFileBytes);
  const totals = { delivered: 0, dropped: 0, processed: 0, bytesRead: 0 };
  processBufferedLines(state, limits, onEvent, log, totals);
  readAvailableBytes(state, readableEnd, limits, onEvent, log, totals);
  finalizeFileCapacity(state, readableEnd);
  refreshReadAnchor(state);
  const hasMore = bufferedCompleteLine(state) || state.readOffset < readableEnd;
  return drainResult({
    delivered: totals.delivered,
    dropped: totals.dropped,
    bytesRead: totals.bytesRead,
    hasMore,
    reason: state.capacityExceeded ? "file_capacity_exceeded" : "",
  });
}

function readAvailableBytes(state, readableEnd, limits, onEvent, log, totals) {
  while (canReadMore(state, readableEnd, limits, totals)) {
    const remaining = Math.min(
      readableEnd - state.readOffset,
      limits.maxReadBytesPerDrain - totals.bytesRead,
    );
    const chunk = Buffer.allocUnsafe(remaining);
    const count = readSync(state.fd, chunk, 0, remaining, state.readOffset);
    if (count <= 0) break;
    state.readOffset += count;
    totals.bytesRead += count;
    state.buffer = Buffer.concat([state.buffer, chunk.subarray(0, count)]);
    processBufferedLines(state, limits, onEvent, log, totals);
  }
}

function canReadMore(state, readableEnd, limits, totals) {
  return state.readOffset < readableEnd &&
    totals.bytesRead < limits.maxReadBytesPerDrain &&
    totals.processed < limits.maxEventsPerDrain;
}

function processBufferedLines(state, limits, onEvent, log, totals) {
  while (totals.processed < limits.maxEventsPerDrain) {
    if (state.discardingOversize && !discardUntilLF(state)) return;
    const newline = state.buffer.indexOf(LF);
    if (newline < 0) {
      beginOversizeDiscard(state, limits, log, totals);
      return;
    }
    const rawLine = state.buffer.subarray(0, newline);
    state.buffer = state.buffer.subarray(newline + 1);
    totals.processed += 1;
    processLine(state, stripCR(rawLine), limits, onEvent, log, totals);
  }
}

function discardUntilLF(state) {
  const newline = state.buffer.indexOf(LF);
  if (newline < 0) {
    state.buffer = Buffer.alloc(0);
    return false;
  }
  state.buffer = state.buffer.subarray(newline + 1);
  state.discardingOversize = false;
  return true;
}

function beginOversizeDiscard(state, limits, log, totals) {
  if (state.buffer.length <= limits.maxLineBytes) return;
  state.buffer = Buffer.alloc(0);
  state.discardingOversize = true;
  totals.dropped += 1;
  diagnostic(log, state, "decode", "dropped", "line_capacity_exceeded");
}

function processLine(state, rawLine, limits, onEvent, log, totals) {
  if (rawLine.length === 0) return;
  if (rawLine.length > limits.maxLineBytes) {
    totals.dropped += 1;
    diagnostic(log, state, "decode", "dropped", "line_capacity_exceeded");
    return;
  }
  const decoded = decodeEvent(rawLine);
  if (!decoded.ok) {
    totals.dropped += 1;
    diagnostic(log, state, "decode", "dropped", decoded.reason);
    return;
  }
  try {
    onEvent(state.executionKey, decoded.event);
    totals.delivered += 1;
  } catch {
    totals.dropped += 1;
    diagnostic(log, state, "handoff", "failed", "consumer_failed");
  }
}

function decodeEvent(rawLine) {
  let text;
  try {
    text = UTF8_DECODER.decode(rawLine);
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
  try {
    return { ok: true, event: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function resetAfterTruncate(state, log) {
  state.readOffset = 0;
  state.buffer = Buffer.alloc(0);
  state.readAnchor = Buffer.alloc(0);
  state.anchorOffset = 0;
  state.discardingOversize = false;
  state.capacityExceeded = false;
  state.blockedReason = "";
  diagnostic(log, state, "drain", "recovered", "file_truncated");
}

function markFileCapacity(state, log) {
  if (state.capacityExceeded) return;
  state.capacityExceeded = true;
  diagnostic(log, state, "drain", "blocked", "file_capacity_exceeded");
}

function finalizeFileCapacity(state, readableEnd) {
  if (!state.capacityExceeded || state.readOffset < readableEnd || bufferedCompleteLine(state)) return;
  state.buffer = Buffer.alloc(0);
  state.discardingOversize = false;
  state.blockedReason = "file_capacity_exceeded";
}

function bufferedCompleteLine(state) {
  return state.buffer.indexOf(LF) >= 0;
}

function stripCR(buffer) {
  return buffer.at(-1) === CR ? buffer.subarray(0, -1) : buffer;
}

function fileWasRewritten(state, size) {
  if (size < state.readOffset) return true;
  if (state.readAnchor.length === 0) return false;
  const current = Buffer.allocUnsafe(state.readAnchor.length);
  const count = readSync(
    state.fd, current, 0, current.length, state.anchorOffset,
  );
  return count !== current.length || !current.equals(state.readAnchor);
}

function refreshReadAnchor(state) {
  const length = Math.min(READ_ANCHOR_BYTES, state.readOffset);
  if (length === 0) return;
  const offset = state.readOffset - length;
  const anchor = Buffer.allocUnsafe(length);
  const count = readSync(state.fd, anchor, 0, length, offset);
  if (count !== length) throw new ProgressEventBridgeError("anchor_read_failed");
  state.anchorOffset = offset;
  state.readAnchor = anchor;
}

function createExecution(rootDir, executionKey) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const capability = randomBytes(32).toString("base64url");
    const stateDir = path.join(rootDir, capability);
    try {
      mkdirSync(stateDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new ProgressEventBridgeError("execution_create_failed", error);
    }
    chmodExecutionDirectory(stateDir);
    return openExecution(executionKey, capability, stateDir);
  }
  throw new ProgressEventBridgeError("capability_collision");
}

function chmodExecutionDirectory(stateDir) {
  try {
    chmodSync(stateDir, 0o700);
  } catch (error) {
    removeFailedExecution(stateDir);
    throw new ProgressEventBridgeError("execution_chmod_failed", error);
  }
}

function openExecution(executionKey, capability, stateDir) {
  const eventsFile = path.join(stateDir, "events.jsonl");
  let fd;
  try {
    fd = openSync(eventsFile, "wx+", 0o600);
    chmodSync(eventsFile, 0o600);
    return {
      executionKey, capability, stateDir, eventsFile, fd,
      readOffset: 0, buffer: Buffer.alloc(0), discardingOversize: false,
      readAnchor: Buffer.alloc(0), anchorOffset: 0,
      capacityExceeded: false, blockedReason: "", finishPromise: undefined,
      cleaned: false,
    };
  } catch (error) {
    cleanupFailedOpen(fd, stateDir);
    throw new ProgressEventBridgeError("event_file_create_failed", error);
  }
}

function cleanupFailedOpen(fd, stateDir) {
  let failure;
  if (Number.isInteger(fd)) {
    try {
      closeSync(fd);
    } catch (error) {
      failure = error;
    }
  }
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw new ProgressEventBridgeError("event_file_cleanup_failed", failure);
}

function removeFailedExecution(stateDir) {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    throw new ProgressEventBridgeError("execution_cleanup_failed", error);
  }
}

function cleanupExecution(state, log) {
  if (state.cleaned) return;
  state.cleaned = true;
  try {
    closeSync(state.fd);
  } catch {
    diagnostic(log, state, "cleanup", "failed", "close_failed");
  }
  try {
    rmSync(state.stateDir, { recursive: true, force: true });
  } catch {
    diagnostic(log, state, "cleanup", "failed", "remove_failed");
  }
}

function finishReason(state, result, deadline, log) {
  if (result.hasMore && Date.now() > deadline) {
    diagnostic(log, state, "finish", "dropped", "finish_timeout");
    return "finish_timeout";
  }
  if (state.buffer.length > 0 || state.discardingOversize) {
    diagnostic(log, state, "finish", "dropped", "incomplete_line");
    return "incomplete_line";
  }
  return result.reason;
}

function ensurePrivateRoot(rootDir) {
  try {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(rootDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProgressEventBridgeError("root_not_private_directory");
    }
    chmodSync(rootDir, 0o700);
  } catch (error) {
    if (error instanceof ProgressEventBridgeError) throw error;
    throw new ProgressEventBridgeError("root_create_failed", error);
  }
}

function removeOrphanExecutions(rootDir, log) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    throw new ProgressEventBridgeError("orphan_scan_failed", error);
  }
  for (const entry of entries) {
    if (!CAPABILITY_PATTERN.test(entry.name)) continue;
    const orphan = path.join(rootDir, entry.name);
    try {
      rmSync(orphan, { recursive: true, force: true });
    } catch {
      log("[muad-runtime-guard][skill-progress] action=startup outcome=failed reason=orphan_cleanup_failed");
    }
  }
}

function reserveRoot(rootDir) {
  if (ACTIVE_ROOTS.has(rootDir)) throw new ProgressEventBridgeError("root_in_use");
  ACTIVE_ROOTS.add(rootDir);
}

function releaseRoot(rootDir) {
  ACTIVE_ROOTS.delete(rootDir);
}

function registration(state) {
  return {
    executionKey: state.executionKey,
    capability: state.capability,
    stateDir: state.stateDir,
    eventsFile: state.eventsFile,
  };
}

function diagnostic(log, state, action, outcome, reason) {
  log(`[muad-runtime-guard][skill-progress] execution=${state.capability} action=${action} outcome=${outcome} reason=${reason}`);
}

function drainResult(overrides = {}) {
  return {
    delivered: 0,
    dropped: 0,
    bytesRead: 0,
    hasMore: false,
    reason: "",
    ...overrides,
  };
}

function normalizeLimits(limits = {}) {
  return {
    maxLineBytes: positiveInteger(limits.maxLineBytes ?? DEFAULT_PROGRESS_EVENT_LIMITS.maxLineBytes, "invalid_max_line_bytes"),
    maxFileBytes: positiveInteger(limits.maxFileBytes ?? DEFAULT_PROGRESS_EVENT_LIMITS.maxFileBytes, "invalid_max_file_bytes"),
    maxReadBytesPerDrain: positiveInteger(limits.maxReadBytesPerDrain ?? DEFAULT_PROGRESS_EVENT_LIMITS.maxReadBytesPerDrain, "invalid_max_read_bytes"),
    maxEventsPerDrain: positiveInteger(limits.maxEventsPerDrain ?? DEFAULT_PROGRESS_EVENT_LIMITS.maxEventsPerDrain, "invalid_max_events"),
  };
}

function normalizeRoot(value) {
  const rootDir = String(value ?? "").trim();
  if (!path.isAbsolute(rootDir)) throw new ProgressEventBridgeError("invalid_root");
  return path.resolve(rootDir);
}

function normalizedExecutionKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 512) throw new ProgressEventBridgeError("invalid_execution_key");
  return key;
}

function requiredCallback(value, code) {
  if (typeof value !== "function") throw new ProgressEventBridgeError(code);
  return value;
}

function optionalCallback(value, code) {
  if (value === undefined) return () => {};
  return requiredCallback(value, code);
}

function positiveInteger(value, code) {
  if (!Number.isInteger(value) || value <= 0) throw new ProgressEventBridgeError(code);
  return value;
}

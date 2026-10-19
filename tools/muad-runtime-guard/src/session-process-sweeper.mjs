import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// 会话级进程扫描与安全终止：只读 /proc，按完整 MUAD_SESSION_KEY + UID 精确匹配，
// 指纹复核通过后才发信号；组长按进程组、非组长只按 pid。模块不落盘、不输出
// environ 原值，日志只含 pid/pgid/outcome/reason 与计数。

export const SESSION_SWEEPER_LOG = "[muad-runtime-guard][session-cancel]";
export const DEFAULT_TERM_WAIT_MS = 3000;
export const DEFAULT_KILL_WAIT_MS = 2000;
export const MAX_SCAN_PIDS = 512;
export const CMDLINE_MAX_LENGTH = 200;

const SESSION_KEY_ENV = "MUAD_SESSION_KEY";

export function fingerprint(sessionKey, pid, pgid, startTime, uid) {
  const material = `${sessionKey}|${pid}|${pgid}|${startTime}|${uid}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function defaultUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function defaultOwnPgid() {
  return typeof process.getpgrp === "function" ? process.getpgrp() : -1;
}

function requireSessionContext(sessionKey, uid) {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new TypeError("sessionKey is required");
  }
  if (!Number.isInteger(uid)) throw new TypeError("uid must be an integer");
}

function readEntry(readFile, file) {
  try {
    const value = readFile(file);
    return { ok: true, buffer: Buffer.isBuffer(value) ? value : Buffer.from(String(value)) };
  } catch (error) {
    return { ok: false, error };
  }
}

function textOf(entry) {
  return entry.ok ? entry.buffer.toString("utf8") : "";
}

// stat 的 comm 字段可能含空格/括号，因此从最后一个 ")" 之后解析。
function parseStat(text) {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  const pgrp = Number(fields[2]);
  const startTime = Number(fields[19]);
  if (!Number.isInteger(pgrp) || !Number.isInteger(startTime)) return null;
  return { state: fields[0], pgid: pgrp, startTime };
}

// real/effective/saved 任一不一致（或非法）都不视为 guard 拥有的进程。
function parseUid(text) {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)/mu.exec(text);
  if (!match) return null;
  const values = [Number(match[1]), Number(match[2]), Number(match[3])];
  return values[0] === values[1] && values[1] === values[2] ? values[0] : null;
}

function parseCmdline(buffer) {
  return buffer.toString("utf8").split("\u0000").join(" ").trim().slice(0, CMDLINE_MAX_LENGTH);
}

function readUptimeSeconds(procRoot, readFile) {
  const entry = readEntry(readFile, path.join(procRoot, "uptime"));
  if (!entry.ok) return null;
  const value = Number(textOf(entry).trim().split(/\s+/u)[0]);
  return Number.isFinite(value) ? value : null;
}

// 按 NUL 分段比较 Buffer，避免把整个 environ 解码成字符串。
function environHasExact(buffer, needle) {
  let start = 0;
  while (start <= buffer.length) {
    const end = buffer.indexOf(0, start);
    const stop = end === -1 ? buffer.length : end;
    if (stop - start === needle.length && buffer.subarray(start, stop).equals(needle)) return true;
    if (end === -1) return false;
    start = end + 1;
  }
  return false;
}

function readProcess(procRoot, pid, readFile) {
  const dir = path.join(procRoot, String(pid));
  const statEntry = readEntry(readFile, path.join(dir, "stat"));
  if (!statEntry.ok) return { exists: false, error: statEntry.error };
  const stat = parseStat(textOf(statEntry));
  if (!stat) return { exists: false, error: new Error("invalid stat") };
  const statusEntry = readEntry(readFile, path.join(dir, "status"));
  const cmdlineEntry = readEntry(readFile, path.join(dir, "cmdline"));
  const environEntry = readEntry(readFile, path.join(dir, "environ"));
  return {
    exists: true,
    zombie: stat.state === "Z" || stat.state === "X",
    pgid: stat.pgid,
    startTime: stat.startTime,
    uid: statusEntry.ok ? parseUid(textOf(statusEntry)) : null,
    cmdline: cmdlineEntry.ok ? parseCmdline(cmdlineEntry.buffer) : "",
    environ: environEntry.ok ? environEntry.buffer : null,
    environError: environEntry.ok ? null : environEntry.error,
  };
}

function recordSkip(result, pid, reason, counter) {
  result.skipped[counter] += 1;
  result.skippedPids.push({ pid, reason });
}

// 返回 { process } 或 { skip: { reason, counter } }；不在此处记录/输出任何内容。
function classifyProcess(pid, info, sessionKey, uid, needle, uptime, clockTicks) {
  if (!info.cmdline) return { skip: { reason: "empty_cmdline", counter: "emptyCmdline" } };
  if (!info.environ) {
    const denied = info.environError?.code === "EPERM" || info.environError?.code === "EACCES";
    return denied
      ? { skip: { reason: "permission_denied", counter: "permissionDenied" } }
      : { skip: { reason: "unreadable", counter: "unreadable" } };
  }
  if (info.uid === null) return { skip: { reason: "unreadable", counter: "unreadable" } };
  if (info.uid !== uid) return { skip: { reason: "not_owner", counter: "notOwner" } };
  if (!environHasExact(info.environ, needle)) return { skip: { reason: "env_mismatch", counter: "envMismatch" } };
  return {
    process: {
      pid,
      pgid: info.pgid,
      startTime: info.startTime,
      uid: info.uid,
      leader: pid === info.pgid,
      ageSeconds: uptime === null ? 0 : Math.max(0, Math.floor(uptime - info.startTime / clockTicks)),
      cmdline: info.cmdline,
      fingerprint: fingerprint(sessionKey, pid, info.pgid, info.startTime, info.uid),
    },
  };
}

function listProcPids(names, limit) {
  return names
    .filter((name) => /^\d+$/u.test(name))
    .map(Number)
    .sort((left, right) => left - right)
    .slice(0, limit);
}

function logScanSummary(result, log) {
  log(
    `${SESSION_SWEEPER_LOG} scan scanned=${result.scanned} candidates=${result.processes.length}` +
      ` skipped_protected=${result.skipped.protected} skipped_empty_cmdline=${result.skipped.emptyCmdline}` +
      ` skipped_permission_denied=${result.skipped.permissionDenied} skipped_not_owner=${result.skipped.notOwner}` +
      ` skipped_env_mismatch=${result.skipped.envMismatch} skipped_unreadable=${result.skipped.unreadable}`,
  );
}

export function scanSessionProcesses(options = {}) {
  const {
    procRoot = "/proc",
    sessionKey,
    uid = defaultUid(),
    selfPid = process.pid,
    readdir = (dir) => readdirSync(dir),
    readFile = (file) => readFileSync(file),
    limit = MAX_SCAN_PIDS,
    clockTicks = 100,
    log = () => {},
  } = options;
  requireSessionContext(sessionKey, uid);

  const result = {
    scanned: 0,
    processes: [],
    skipped: { protected: 0, emptyCmdline: 0, permissionDenied: 0, notOwner: 0, envMismatch: 0, unreadable: 0 },
    skippedPids: [],
  };
  let names = [];
  try {
    names = readdir(procRoot);
  } catch {
    names = [];
  }
  const pids = listProcPids(names, limit);
  result.scanned = pids.length;
  const needle = Buffer.from(`${SESSION_KEY_ENV}=${sessionKey}`);
  const uptime = readUptimeSeconds(procRoot, readFile);

  for (const pid of pids) {
    if (pid === 1 || pid === selfPid) {
      recordSkip(result, pid, "protected", "protected");
      continue;
    }
    const info = readProcess(procRoot, pid, readFile);
    if (!info.exists) continue;
    const verdict = classifyProcess(pid, info, sessionKey, uid, needle, uptime, clockTicks);
    if (verdict.skip) {
      recordSkip(result, pid, verdict.skip.reason, verdict.skip.counter);
      continue;
    }
    result.processes.push(verdict.process);
  }

  logScanSummary(result, log);
  return result;
}

function buildContext(options) {
  const {
    procRoot = "/proc",
    sessionKey,
    uid = defaultUid(),
    selfPid = process.pid,
    ownPgid = defaultOwnPgid(),
    readFile = (file) => readFileSync(file),
    kill = (target, signal) => process.kill(target, signal),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    termWaitMs = DEFAULT_TERM_WAIT_MS,
    killWaitMs = DEFAULT_KILL_WAIT_MS,
    log = () => {},
  } = options;
  requireSessionContext(sessionKey, uid);
  return {
    procRoot,
    sessionKey,
    uid,
    selfPid,
    ownPgid,
    readFile,
    kill,
    sleep,
    termWaitMs,
    killWaitMs,
    log,
    needle: Buffer.from(`${SESSION_KEY_ENV}=${sessionKey}`),
  };
}

// 只对组长按进程组发信号；guard 自身所在进程组永不按组发信号。
function signalTarget(pid, pgid, ownPgid) {
  if (pid === pgid && pgid > 1 && pgid !== ownPgid) return -pgid;
  return pid;
}

function collectTargets(candidates, expected, ctx) {
  const expectedByPid = new Map();
  for (const item of expected) {
    const pid = Number(item?.pid);
    if (Number.isInteger(pid) && typeof item?.fingerprint === "string") {
      expectedByPid.set(pid, item.fingerprint);
    }
  }
  const outcomes = [];
  const targets = [];
  for (const candidate of candidates) {
    const pid = Number(candidate?.pid);
    const expectedFingerprint = expectedByPid.get(pid);
    if (expectedFingerprint === undefined) {
      outcomes.push({ pid, outcome: "skipped", reason: "not_expected" });
      continue;
    }
    if (pid === 1 || pid === ctx.selfPid) {
      outcomes.push({ pid, outcome: "skipped", reason: "protected" });
      continue;
    }
    const info = readProcess(ctx.procRoot, pid, ctx.readFile);
    if (!info.exists || info.zombie) {
      outcomes.push({ pid, outcome: "skipped", reason: "already_exited" });
      continue;
    }
    if (info.pgid !== candidate.pgid || info.startTime !== candidate.startTime || info.uid !== ctx.uid) {
      outcomes.push({ pid, outcome: "skipped", reason: "identity_changed" });
      continue;
    }
    const currentFingerprint = fingerprint(ctx.sessionKey, pid, info.pgid, info.startTime, info.uid);
    if (candidate.fingerprint !== expectedFingerprint || currentFingerprint !== expectedFingerprint) {
      outcomes.push({ pid, outcome: "skipped", reason: "fingerprint_mismatch" });
      continue;
    }
    if (!info.environ) {
      outcomes.push({ pid, outcome: "skipped", reason: "permission_denied" });
      continue;
    }
    if (!environHasExact(info.environ, ctx.needle)) {
      outcomes.push({ pid, outcome: "skipped", reason: "env_mismatch" });
      continue;
    }
    targets.push({ pid, pgid: info.pgid, startTime: info.startTime, uid: info.uid, outcome: "pending", reason: "" });
  }
  return { outcomes, targets };
}

function applySignal(target, signal, ctx) {
  const targetId = signalTarget(target.pid, target.pgid, ctx.ownPgid);
  try {
    ctx.kill(targetId, signal);
    target.outcome = signal === "SIGTERM" ? "pending_term" : "pending_kill";
    target.reason = "";
  } catch (error) {
    target.outcome = "failed";
    target.reason = error?.code === "ESRCH" ? "already_exited" : "permission_denied";
    if (target.reason === "already_exited") target.outcome = "skipped";
  }
  ctx.log(
    `${SESSION_SWEEPER_LOG} pid=${target.pid} pgid=${target.pgid} signal=${signal} target=${targetId}` +
      ` outcome=${target.outcome}${target.reason ? ` reason=${target.reason}` : ""}`,
  );
}

function escalateAfterTerm(targets, ctx) {
  for (const target of targets) {
    if (target.outcome !== "pending_term") continue;
    const info = readProcess(ctx.procRoot, target.pid, ctx.readFile);
    if (!info.exists || info.zombie) {
      target.outcome = "terminated";
      target.reason = "sigterm";
      ctx.log(`${SESSION_SWEEPER_LOG} pid=${target.pid} pgid=${target.pgid} outcome=terminated reason=sigterm`);
      continue;
    }
    if (info.pgid !== target.pgid || info.startTime !== target.startTime || info.uid !== ctx.uid) {
      target.outcome = "skipped";
      target.reason = "identity_changed";
      ctx.log(`${SESSION_SWEEPER_LOG} pid=${target.pid} pgid=${target.pgid} outcome=skipped reason=identity_changed`);
      continue;
    }
    applySignal(target, "SIGKILL", ctx);
  }
}

function confirmAfterKill(targets, ctx) {
  for (const target of targets) {
    if (target.outcome !== "pending_kill") continue;
    const info = readProcess(ctx.procRoot, target.pid, ctx.readFile);
    if (!info.exists || info.zombie || info.pgid !== target.pgid || info.startTime !== target.startTime) {
      target.outcome = "killed";
      target.reason = "sigkill";
    } else {
      target.outcome = "remaining";
      target.reason = "still_running";
    }
    ctx.log(`${SESSION_SWEEPER_LOG} pid=${target.pid} pgid=${target.pgid} outcome=${target.outcome} reason=${target.reason}`);
  }
}

export async function terminateConfirmed(candidates, expected, options = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(expected)) {
    throw new TypeError("candidates and expected must be arrays");
  }
  const ctx = buildContext(options);
  const { outcomes, targets } = collectTargets(candidates, expected, ctx);

  if (targets.length > 0) {
    for (const target of targets) applySignal(target, "SIGTERM", ctx);
    await ctx.sleep(ctx.termWaitMs);
    escalateAfterTerm(targets, ctx);
    await ctx.sleep(ctx.killWaitMs);
    confirmAfterKill(targets, ctx);
  }

  const processes = [
    ...outcomes,
    ...targets.map((target) => ({ pid: target.pid, outcome: target.outcome, reason: target.reason })),
  ];
  const killed = processes.filter((item) => item.outcome === "terminated" || item.outcome === "killed").length;
  const remaining = processes
    .filter((item) => item.outcome === "remaining" || item.outcome === "failed")
    .map((item) => item.pid);
  ctx.log(`${SESSION_SWEEPER_LOG} terminate killed=${killed} remaining=${remaining.length}`);
  return { processes, killed, remaining };
}

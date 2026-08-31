const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
// 与 manager 的 DIRECT_SESSION_PATTERN 对齐：仅 direct 会话可注册前台进度。
const DIRECT_SESSION_PATTERN = /^agent:([^:]+):([^:]+):direct:(.+)$/u;

export function createSkillProgressHooks(options = {}) {
  const manager = requireManager(options.manager);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const log = typeof options.log === "function" ? options.log : () => {};
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS);
  const active = new Map();
  // (agentId, sessionKey) -> { skillName, senderId, expiresAt }：dispatch 发生在
  // run 创建之前（无 runId），先暂存；before_agent_run 拿到 runId 后补注册。
  // 没有这一层，同会话第二次调用（SKILL.md 已在上下文、模型不再 read）将
  // 整个失去进度桥（bridge_unavailable）。
  const pending = new Map();
  // (agentId, sessionKey) -> { senderId, expiresAt }：turn 级可信发送者。
  // before_agent_run 事件携带 senderId（OpenClaw core 从入站消息提供），
  // 但 read-SKILL.md 路径的注册发生在其之后且事件无 senderId——在此缓存，
  // 供 resolveExecEnv 修正已注册路由（多用户网关下 session key 末段是
  // agent id 而非真实 IM 用户 id，直接投递会 Unknown target）。
  const turnSenders = new Map();
  let closed = false;
  let timer;

  const activate = (input = {}) => {
    if (closed) return { registered: false, reason: "hooks_closed" };
    pruneExpired(active, pending, turnSenders, now(), manager, log);
    const identity = foregroundIdentity(input);
    if (!identity) {
      rememberPending(input, now(), ttlMs);
      return { registered: false, reason: "identity_invalid" };
    }
    const existing = active.get(identity.key);
    if (existing) return reuseOrReject(existing, input.skillName, now(), ttlMs);
    dropPendingFor(identity, text(input.skillName));
    // read-SKILL.md 路径的事件不带 senderId：回退到 before_agent_run 缓存的
    // turn sender，让注册时路由即正确（resolveExecEnv 仍会兜底修正）。
    const senderId = text(input.senderId) ||
      text(turnSenders.get(identity.session)?.senderId);
    const registration = manager.registerForeground(
      senderId ? { ...input, senderId } : input,
    );
    if (registration?.registered !== true) {
      stableLog(log, `skill=${text(input.skillName)} action=activate outcome=rejected reason=${registration?.reason ?? "register_failed"}`);
      return registration;
    }
    active.set(identity.key, {
      ...identity, skillName: text(input.skillName), executionKey: registration.executionKey,
      env: { ...registration.env }, expiresAt: now() + ttlMs,
    });
    return registration;
  };

  // before_dispatch 时无 runId 的激活在此补注册（runId/senderId 此时可用）。
  const beforeAgentRun = async (event, ctx) => {
    if (closed) return undefined;
    pruneExpired(active, pending, turnSenders, now(), manager, log);
    const identity = sessionIdentity({
      runId: event?.runId ?? ctx?.runId,
      agentId: ctx?.agentId ?? event?.agentId,
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    });
    if (!identity) return undefined;
    const senderId = text(event?.senderId) || text(ctx?.senderId);
    if (senderId) turnSenders.set(identity.session, { senderId, expiresAt: now() + ttlMs });
    if (!identity.runId) return undefined;
    if (active.get(identity.key)) {
      const superseded = pending.get(identity.session);
      dropPendingFor(identity, superseded?.skillName ?? "unknown");
      return undefined;
    }
    const candidate = pending.get(identity.session);
    if (!candidate) return undefined;
    pending.delete(identity.session);
    const registration = manager.registerForeground({
      runId: identity.runId, agentId: identity.agentId, sessionKey: identity.sessionKey,
      skillName: candidate.skillName,
      senderId: senderId || candidate.senderId,
      locale: candidate.locale,
    });
    if (registration?.registered !== true) {
      stableLog(log, `skill=${candidate.skillName} action=activate outcome=rejected reason=${registration?.reason ?? "register_failed"}`);
      return undefined;
    }
    active.set(identity.key, {
      ...identity, skillName: candidate.skillName, executionKey: registration.executionKey,
      env: { ...registration.env }, expiresAt: now() + ttlMs,
    });
    stableLog(log, `skill=${candidate.skillName} action=activate outcome=accepted reason=promoted_from_pending`);
    return undefined;
  };

  const resolveExecEnv = async (event, ctx) => {
    if (text(event?.toolName) !== "exec" || closed) return undefined;
    pruneExpired(active, pending, turnSenders, now(), manager, log);
    const record = resolveForegroundRecord(active, {
      runId: event?.runId ?? ctx?.runId,
      agentId: ctx?.agentId,
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    });
    if (!record) return undefined;
    record.expiresAt = now() + ttlMs;
    // 可信收件人来源（均为 OpenClaw core 从入站消息提供、非模型可控）：
    // 1. resolve_exec_env ctx 的 channelContext.sender.id
    // 2. before_agent_run 缓存的 turn senderId
    // 修正多用户网关下 session key 末段不是真实 IM 用户 id 的路由。
    const senderId = text(ctx?.channelContext?.sender?.id) ||
      text(turnSenders.get(record.session)?.senderId);
    try {
      manager.applyTrustedSender?.(record.executionKey, senderId);
    } catch {
      // 路由修正失败不影响 exec 注入，保持既有 route。
    }
    return { ...record.env };
  };

  const agentEnd = async (event, ctx) => {
    const identity = foregroundIdentity({
      runId: event?.runId ?? ctx?.runId,
      agentId: ctx?.agentId,
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    });
    if (!identity) return;
    const record = active.get(identity.key);
    if (!record) return;
    active.delete(identity.key);
    await finishRecord(record, manager, log);
  };

  const sweep = () => pruneExpired(active, pending, turnSenders, now(), manager, log);
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    for (const record of active.values()) void finishRecord(record, manager, log);
    active.clear();
    pending.clear();
    turnSenders.clear();
  };

  if (options.autoStart !== false) {
    const intervalMs = positiveInteger(options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    timer = (options.setIntervalFn ?? setInterval)(sweep, intervalMs);
    timer?.unref?.();
  }
  return { activate, beforeAgentRun, resolveExecEnv, agentEnd, sweep, close };

  function rememberPending(input, at, ttl) {
    const agentId = text(input.agentId);
    const sessionKey = text(input.sessionKey);
    const skillName = text(input.skillName);
    if (!agentId || !DIRECT_SESSION_PATTERN.test(sessionKey) || !skillName) {
      stableLog(log, `skill=${skillName || "unknown"} action=pending outcome=rejected reason=identity_invalid`);
      return;
    }
    const session = JSON.stringify([agentId, sessionKey]);
    const previous = pending.get(session);
    if (previous && previous.skillName !== skillName) {
      stableLog(log, `skill=${skillName} action=pending outcome=rejected reason=skill_conflict`);
      return;
    }
    pending.set(session, {
      skillName,
      senderId: text(input.senderId),
      locale: text(input.locale) === "en" ? "en" : "zh",
      expiresAt: at + ttl,
    });
    stableLog(log, `skill=${skillName} action=pending outcome=accepted reason=dispatch_without_run_id`);
  }

  function dropPendingFor(identity, skillName) {
    if (!pending.delete(identity.session)) return;
    stableLog(log, `skill=${skillName} action=pending outcome=dropped reason=superseded_by_register`);
  }
}

function foregroundIdentity(input) {
  const identity = sessionIdentity(input);
  if (!identity?.runId) return undefined;
  return identity;
}

function sessionIdentity(input) {
  const sessionKey = text(input.sessionKey);
  const agentId = text(input.agentId) || agentFromSessionKey(sessionKey);
  if (!agentId || !sessionKey) return undefined;
  const runId = text(input.runId);
  return {
    runId, agentId, sessionKey,
    session: JSON.stringify([agentId, sessionKey]),
    key: JSON.stringify([runId, agentId, sessionKey]),
  };
}

function agentFromSessionKey(sessionKey) {
  const match = DIRECT_SESSION_PATTERN.exec(sessionKey);
  return match ? match[1] : "";
}

function resolveForegroundRecord(active, input) {
  const agentId = text(input.agentId);
  const sessionKey = text(input.sessionKey);
  if (!agentId || !sessionKey) return undefined;
  const runId = text(input.runId);
  if (runId) return active.get(JSON.stringify([runId, agentId, sessionKey]));
  let match;
  for (const record of active.values()) {
    if (record.agentId !== agentId || record.sessionKey !== sessionKey) continue;
    if (match) return undefined;
    match = record;
  }
  return match;
}

function reuseOrReject(record, skillName, now, ttlMs) {
  if (record.skillName !== text(skillName)) return { registered: false, reason: "skill_conflict" };
  record.expiresAt = now + ttlMs;
  return { registered: true, executionKey: record.executionKey, env: { ...record.env } };
}

function pruneExpired(active, pending, turnSenders, now, manager, log) {
  for (const [key, record] of active.entries()) {
    if (record.expiresAt > now) continue;
    active.delete(key);
    void finishRecord(record, manager, log);
  }
  for (const [key, record] of pending.entries()) {
    if (record.expiresAt > now) continue;
    pending.delete(key);
    stableLog(log, `skill=${record.skillName} action=pending outcome=expired`);
  }
  for (const [key, record] of turnSenders.entries()) {
    if (record.expiresAt > now) continue;
    turnSenders.delete(key);
  }
}

async function finishRecord(record, manager, log) {
  try {
    await manager.finish(record.executionKey);
  } catch {
    stableLog(log, "action=foreground-finish outcome=failed reason=manager_finish_failed");
  }
}

function stableLog(log, detail) {
  try {
    log(`[muad-runtime-guard][skill-progress] ${detail}`);
  } catch {
    // Progress diagnostics are best-effort and never alter the foreground run.
  }
}

function requireManager(manager) {
  const methods = [manager?.registerForeground, manager?.finish];
  if (!methods.every((value) => typeof value === "function")) throw new Error("invalid progress manager");
  return manager;
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error("invalid positive integer");
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

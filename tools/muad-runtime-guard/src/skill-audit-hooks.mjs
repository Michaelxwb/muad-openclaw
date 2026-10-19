import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { explicitSkillName } from "./skill-hooks.mjs";

// 审计只记录 who-when-what（谁在什么时间执行了什么 skill），上报最小契约：
// { executionId, agentId, skillName, skillScope, startedAt }。结果、耗时、进度都不记录。
const TURN_CONTEXT_TTL_MS = 10 * 60_000;
// Execution attribution outlives one turn: a long turn can read SKILL.md again
// after the turn-context TTL and must not create a second execution for the
// same runId + skill (that would make the trace mapping ambiguous).
const REPORTED_TTL_MS = 24 * 60 * 60_000;
const READ_PATH_KEYS = ["path", "file_path", "filePath", "file"];
const EXEC_COMMAND_KEYS = ["command", "script", "cmd"];

export function createSkillAuditHooks({
  config, getConfig = () => config, manager, client, executions, now = () => Date.now(),
  log = () => {}, onSkillActivated = () => {},
}) {
  const state = { getConfig, manager, client, executions, now, onSkillActivated,
    turns: new Map(), reported: new Map(), pendingExecutions: new Map(),
    diag: message => log(`[skill-audit] ${message}`) };
  return {
    beforeDispatch: async (event, ctx) => auditDispatch(state, event, ctx),
    beforeAgentRun: async (event, ctx) => auditAgentRun(state, event, ctx),
    beforeToolCall: async (event, ctx) => auditToolCall(state, event, ctx),
    agentEnd: async (event, ctx) => auditAgentEnd(state, event, ctx),
  };
}

function auditAgentEnd(state, event, ctx) {
  if (!state.executions || typeof state.executions.endSession !== "function") return;
  if (isLongTaskSession(event, ctx)) return;
  state.executions.endSession({
    agentId: resolveAgentId(event, ctx),
    sessionKey: textValue(event?.sessionKey) || textValue(ctx?.sessionKey),
    runId: resolveRunId(event, ctx),
  });
}

function auditDispatch(state, event, ctx) {
  pruneExpired(state.reported, state.now());
  const name = explicitSkillName(promptText(event));
  if (!name || isLongTaskSession(event, ctx)) return;
  const config = state.getConfig(), agentId = resolveAgentId(event, ctx);
  if (isLongTaskSkill(config, agentId, name)) return;
  const match = findDispatchGrant(config, agentId, name);
  if (match) auditForeground(state, config, event, ctx, agentId, match);
}

function auditAgentRun(state, event, ctx) {
  pruneExpired(state.turns, state.now());
  if (isLongTaskSession(event, ctx)) return auditBackground(state, event, ctx);
  const runId = resolveRunId(event, ctx);
  if (runId) {
    rememberTurn(state.turns, runId, { agentId: resolveAgentId(event, ctx) }, state.now());
    promotePendingExecution(state, event, ctx, runId);
  }
  activatePromptSkill(state, event, ctx);
}

// OpenClaw 在 before_tool_call 之前就已执行 exec 的 prepareBeforeToolCallParams
// （resolve_exec_env 在此运行），所以一轮的第一条 exec 若直接执行 Skill、没有先
// read SKILL.md，等 before_tool_call 登记已经太晚，该条命令拿不到 MUAD_SKILL_NAME。
// before_agent_run 能看到本轮 prompt 且早于任何工具：这里按 prompt 中出现的 Skill
// 显式命令/路径预登记执行上下文；只做环境登记，审计仍由实际 read/exec 触发。
function activatePromptSkill(state, event, ctx) {
  const prompt = promptText(event);
  if (!prompt) return;
  const config = state.getConfig(), agentId = resolveAgentId(event, ctx);
  const match = findPromptSkill(config, agentId, prompt);
  if (!match || isLongTaskSkill(config, agentId, match.skillName)) return;
  activateProgress(state.onSkillActivated,
    activationInput(config, event, ctx, agentId, match.skillName), state.diag);
}

// 只接受两种可信信号：显式 Skill 命令，或 prompt 中真实存在的 Skill 根路径。
// 多个候选时不猜，宁可本轮不注入，也不把执行错误归属到某个 Skill。
function findPromptSkill(config, agentId, prompt) {
  const explicit = explicitSkillName(prompt);
  if (explicit) return findDispatchGrant(config, agentId, explicit);
  const names = new Set();
  for (const grant of config?.skillAuditGrants ?? []) {
    if (grant.agentId !== agentId) continue;
    if (grant.dir !== true) {
      if (containsPath(prompt, grant.rootPath)) names.add(grant.name);
      continue;
    }
    const candidates = skillNamesFromCommand(prompt, grant.rootPath);
    for (const name of candidates) {
      if (fs.existsSync(path.join(grant.rootPath, name, "SKILL.md"))) names.add(name);
    }
  }
  if (names.size !== 1) return null;
  return findDispatchGrant(config, agentId, [...names][0]);
}

function skillNamesFromCommand(command, rootPath) {
  const root = textValue(rootPath).replace(/[/\\]+$/u, "");
  const names = new Set();
  if (!root) return names;
  let from = 0;
  for (;;) {
    const index = command.indexOf(root, from);
    if (index < 0) return names;
    from = index + root.length;
    const rest = command.slice(from).replace(/^[/\\]+/u, "");
    const name = rest.split(/[/\\\s"'`;|&<>()]+/u)[0] ?? "";
    if (/^[A-Za-z0-9_.-]+$/u.test(name) && !name.startsWith(".")) names.add(name);
  }
}

function auditToolCall(state, event, ctx) {
  pruneExpired(state.reported, state.now());
  if (isLongTaskSession(event, ctx)) return;
  const config = state.getConfig();
  const match = event?.toolName === "read"
    ? auditRead(config, event, ctx)
    : ["exec", "bash"].includes(event?.toolName) ? auditExec(config, event, ctx) : null;
  if (!match || isLongTaskSkill(config, match.agentId, match.skillName)) return;
  auditForeground(state, config, event, ctx, match.agentId, match);
}

function auditForeground(state, config, event, ctx, agentId, match) {
  const runId = resolveRunId(event, ctx);
  if (runId && alreadyReported(state.reported, runId, match.skillName)) return;
  activateProgress(state.onSkillActivated, activationInput(config, event, ctx, agentId, match.skillName), state.diag);
  reportOnce(state, match.grant, agentId, match.skillName, state.now(), state.diag, randomUUID(), {
    agentId,
    sessionKey: textValue(event?.sessionKey) || textValue(ctx?.sessionKey),
    runId,
  });
  if (runId) rememberReported(state.reported, runId, match.skillName, state.now());
}

function auditBackground(state, event, ctx) {
  const sessionKey = textValue(ctx?.sessionKey) || textValue(event?.sessionKey);
  const agentId = resolveAgentId(event, ctx);
  const task = state.manager?.snapshot().pools.flatMap(pool => pool.tasks).find(item =>
    item.agentId === agentId && item.sessionKey === sessionKey && item.status === "running");
  if (!task || alreadyReported(state.reported, task.taskId, task.skillName)) return;
  const config = state.getConfig();
  const grant = findGrantBySkillPath(config, agentId, resolveExistingPath(path.join(task.skillRoot, "SKILL.md")));
  if (!grant) return;
  reportOnce(state, grant, agentId, task.skillName, state.now(), state.diag, task.taskId, {
    agentId,
    taskId: task.taskId,
  });
  rememberReported(state.reported, task.taskId, task.skillName, state.now());
}

function isLongTaskSkill(config, agentId, name) {
  return (config?.longTaskSkillGrants ?? []).some(grant => grant.agentId === agentId && grant.name === name);
}

function activateProgress(activate, input, diag) {
  try {
    const result = activate(input);
    Promise.resolve(result).catch(() => diag("progress activation failed reason=guard_failed"));
  } catch {
    diag("progress activation failed reason=guard_failed");
  }
}

function activationInput(config, event, ctx, agentId, skillName) {
  return {
    runId: resolveRunId(event, ctx),
    agentId,
    sessionKey: textValue(event?.sessionKey) || textValue(ctx?.sessionKey),
    // OpenClaw core 在 dispatch/agent_run 事件里提供的真实 IM 发送者 id（非模型可控），
    // 供前台进度路由优先于 session key 末段使用。
    senderId: textValue(event?.senderId) || textValue(ctx?.senderId),
    skillName,
    locale: textValue(config?.locale) === "en" ? "en" : "zh",
  };
}

// 上报是 fire-and-forget：失败只记日志，不阻塞 turn（审计不能影响执行）。
// 同时把 executionId 登记到 trace 归属映射：runId 可用时直接登记；dispatch
// 发生在 run 创建之前时先缓存，待 before_agent_run 拿到 runId 后补登记。
function reportOnce(state, grant, agentId, skillName, now, diag, executionId = randomUUID(), identity = {}) {
  if (!state.client || typeof state.client.report !== "function") return;
  const startedAt = new Date(now).toISOString();
  const request = {
    executionId,
    agentId,
    skillName,
    skillScope: grant.source,
    startedAt,
  };
  registerExecution(state, identity, request);
  Promise.resolve()
    .then(() => state.client.report(request))
    .then(() => diag(`reported executionId=${request.executionId} agent=${agentId} skill=${skillName}`))
    .catch((error) => {
      const code = error?.code ?? "unknown";
      const retryable = error?.retryable === true;
      diag(`report failed agent=${agentId} skill=${skillName} code=${code} retryable=${retryable}`);
    });
}

function registerExecution(state, identity, request) {
  if (!state.executions || typeof state.executions.register !== "function") return;
  const agentId = textValue(identity.agentId) || request.agentId;
  const runId = textValue(identity.runId);
  if (runId) {
    // dispatch（无 runId）与 read-SKILL.md 可能各自上报一次审计；归属必须
    // 复用先登记的那条 execution，额外上报不能再登记同键第二个 execution，
    // 否则会制造自己制造的 mapping_conflict。不同 Skill 则保留冲突语义。
    const existing = state.executions.resolve?.({ agentId, sessionKey: identity.sessionKey, runId });
    if (existing?.skillName === request.skillName) return;
    state.executions.register({
      agentId,
      sessionKey: identity.sessionKey,
      runId,
      skillName: request.skillName,
      executionId: request.executionId,
    });
    return;
  }
  const taskId = textValue(identity.taskId);
  if (taskId) {
    state.executions.register({
      agentId,
      taskId,
      skillName: request.skillName,
      executionId: request.executionId,
    });
    return;
  }
  rememberPendingExecution(state, agentId, identity.sessionKey, request);
}

function rememberPendingExecution(state, agentId, sessionKey, request) {
  const session = textValue(sessionKey);
  if (!agentId || !session) return;
  const key = JSON.stringify([agentId, session]);
  const at = state.now();
  const existing = state.pendingExecutions.get(key);
  if (existing && !existing.conflicted && existing.executionId !== request.executionId) {
    // Two Skills dispatched before the run existed: attribution is ambiguous,
    // so drop it instead of risking a trace on the wrong execution.
    state.pendingExecutions.set(key, { conflicted: true, expiresAt: at + TURN_CONTEXT_TTL_MS });
    return;
  }
  state.pendingExecutions.set(key, {
    conflicted: false,
    executionId: request.executionId,
    skillName: request.skillName,
    expiresAt: at + TURN_CONTEXT_TTL_MS,
  });
}

function promotePendingExecution(state, event, ctx, runId) {
  const agentId = resolveAgentId(event, ctx);
  const sessionKey = textValue(event?.sessionKey) || textValue(ctx?.sessionKey);
  if (!agentId || !sessionKey) return;
  pruneExpired(state.pendingExecutions, state.now());
  const key = JSON.stringify([agentId, sessionKey]);
  const pending = state.pendingExecutions.get(key);
  if (!pending) return;
  state.pendingExecutions.delete(key);
  if (pending.conflicted) return;
  state.executions?.register?.({
    agentId,
    sessionKey,
    runId,
    skillName: pending.skillName,
    executionId: pending.executionId,
  });
}

function auditRead(config, event, ctx) {
  const candidate = readPathCandidate(event);
  if (!candidate) return null;
  const target = resolveExistingPath(candidate.value);
  if (!target || path.basename(target) !== "SKILL.md") return null;
  const agentId = resolveAgentId(event, ctx);
  const grant = findGrantBySkillPath(config, agentId, target);
  if (!grant) return null;
  const skillName = grant.dir === true
    ? skillNameFromDirGrant(grant, path.dirname(target))
    : grant.name;
  if (!skillName) return null;
  return { agentId, grant, skillName, candidate };
}

// Direct path execution (for example `python3 /opt/openclaw-skills/<name>/scripts/run.py`
// without a prior SKILL.md read) still needs an execution record so the trace
// pipeline can attribute the exec. Match only the agent's own grants; a
// command that does not reference a granted Skill path is ignored.
function auditExec(config, event, ctx) {
  const command = execCommandText(event);
  if (!command || !looksExecutable(command)) return null;
  const agentId = resolveAgentId(event, ctx);
  if (!agentId) return null;
  const cwd = resolveExistingPath(textValue(event?.params?.cwd) || textValue(event?.params?.workdir));
  for (const grant of config?.skillAuditGrants ?? []) {
    if (grant.agentId !== agentId) continue;
    if (grant.dir !== true) {
      if (containsPath(command, grant.rootPath) || (cwd && isWithin(grant.rootPath, cwd))) {
        return { agentId, grant, skillName: grant.name };
      }
      continue;
    }
    const skillName = skillNameFromCommand(command, grant.rootPath) ||
      (cwd ? skillNameFromDirGrant(grant, cwd) : "");
    if (skillName && fs.existsSync(path.join(grant.rootPath, skillName, "SKILL.md"))) {
      return { agentId, grant, skillName };
    }
  }
  return null;
}

function execCommandText(event) {
  for (const key of EXEC_COMMAND_KEYS) {
    const value = textValue(event?.params?.[key]);
    if (value) return value;
  }
  return "";
}

// Keep inspection commands (`ls`, `cat`, `grep`) from starting an execution
// record; a direct Skill run is an interpreter or an executable path.
function looksExecutable(command) {
  const interpreter = /^(?:python(?:\d+(?:\.\d+)*)?|node|bash|sh|zsh|bun|deno|perl|ruby|php|java|env)$/u;
  for (const segment of command.split(/[;&|()]+/u)) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0])) tokens.shift();
    const token = tokens[0] ?? "";
    if (!token) continue;
    if (interpreter.test(path.basename(token))) return true;
    if (token.startsWith("./") || token.startsWith("/")) return true;
  }
  return false;
}

function containsPath(command, rootPath) {
  const root = textValue(rootPath).replace(/[/\\]+$/u, "");
  if (!root) return false;
  const index = command.indexOf(root);
  if (index < 0) return false;
  const next = command[index + root.length] ?? "";
  return next === "" || /[/\\\s"'`;|&<>()]/u.test(next);
}

function skillNameFromCommand(command, rootPath) {
  const root = textValue(rootPath).replace(/[/\\]+$/u, "");
  if (!root) return "";
  const index = command.indexOf(root);
  if (index < 0) return "";
  const rest = command.slice(index + root.length).replace(/^[/\\]+/u, "");
  const name = rest.split(/[/\\\s"'`;|&<>()]+/u)[0] ?? "";
  return /^[A-Za-z0-9_.-]+$/u.test(name) && !name.startsWith(".") ? name : "";
}

// 显式调用：先精确匹配 per-Skill grant（system 保持精确），再回退到目录 grant。
// 目录回退用真实文件存在性判定，既解析 public/private scope，也过滤掉从未
// 安装过的 skill 名（phantom 上报）。
function findDispatchGrant(config, agentId, skillName) {
  const grants = config?.skillAuditGrants ?? [];
  const perSkill = grants.find((grant) =>
    grant.agentId === agentId && grant.dir !== true && grant.name === skillName);
  if (perSkill) return { grant: perSkill, skillName };
  for (const grant of grants) {
    if (grant.agentId !== agentId || grant.dir !== true) continue;
    if (fs.existsSync(path.join(grant.rootPath, skillName, "SKILL.md"))) {
      return { grant, skillName };
    }
  }
  return null;
}

// 路径匹配优先 per-Skill grant：system Skill 的 rootPath 位于 public 目录之下，
// 若先命中 public 目录 grant 会把 scope 记成 public，因此必须优先精确的 per-Skill。
function findGrantBySkillPath(config, agentId, skillMdPath) {
  const grants = config?.skillAuditGrants ?? [];
  const dir = path.dirname(skillMdPath);
  const perSkill = grants.find((grant) =>
    grant.agentId === agentId && grant.dir !== true && isWithin(grant.rootPath, dir));
  if (perSkill) return perSkill;
  return grants.find((grant) =>
    grant.agentId === agentId && grant.dir === true && isWithin(grant.rootPath, dir));
}

// 目录 grant 覆盖整个 root；真实 skill 名是 root 后的第一段路径
// （resolver 布局 <root>/<skill>/SKILL.md），嵌套子目录的 SKILL.md 也取第一段。
// root 与 SKILL.md 目录都可能带符号链接（macOS /var -> /private/var），
// 统一 realpath 后再算相对路径，否则 relative 会落到 .. 被误判为逃逸。
function skillNameFromDirGrant(grant, skillMdDir) {
  const realRoot = resolveExistingPath(grant.rootPath);
  if (!realRoot || !skillMdDir) return "";
  const relative = path.relative(realRoot, skillMdDir);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)) return "";
  return relative.split(path.sep)[0];
}

function readPathCandidate(event) {
  for (const key of READ_PATH_KEYS) {
    const value = event?.params?.[key];
    if (typeof value === "string" && value.trim()) return { key, value };
  }
  return null;
}

function resolveExistingPath(candidate) {
  try {
    return fs.realpathSync(path.resolve(candidate));
  } catch {
    return "";
  }
}

function isWithin(root, target) {
  const realRoot = resolveExistingPath(root);
  if (!realRoot || !target) return false;
  const relative = path.relative(realRoot, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative));
}

function isLongTaskSession(event, ctx) {
  const sessionKey = textValue(ctx?.sessionKey) || textValue(event?.sessionKey);
  return parseSessionKey(sessionKey).rest.startsWith("longtask:");
}

function resolveAgentId(event, ctx) {
  return textValue(ctx?.agentId) || textValue(event?.agentId) ||
    parseSessionKey(textValue(ctx?.sessionKey) || textValue(event?.sessionKey)).agentId;
}

function resolveRunId(event, ctx) {
  return textValue(event?.runId) || textValue(ctx?.runId);
}

function parseSessionKey(value) {
  const sessionKey = textValue(value);
  const normalized = sessionKey.startsWith("session:") ? sessionKey.slice("session:".length) : sessionKey;
  const parts = normalized.split(":");
  if (parts[0] !== "agent" || !parts[1]) return { agentId: "", rest: "" };
  return { agentId: parts[1], rest: parts.slice(2).join(":") };
}

function promptText(event) {
  return textValue(event?.prompt) || textValue(event?.content) || textValue(event?.text);
}

function rememberTurn(map, runId, value, now) {
  map.set(runId, { ...value, expiresAt: now + TURN_CONTEXT_TTL_MS });
  if (map.size <= 1000) return;
  const first = map.keys().next().value;
  if (first) map.delete(first);
}

function rememberReported(map, runId, skillName, now) {
  const record = map.get(runId);
  if (record) {
    record.skills.add(skillName);
    record.expiresAt = now + REPORTED_TTL_MS;
    return;
  }
  map.set(runId, { skills: new Set([skillName]), expiresAt: now + REPORTED_TTL_MS });
  if (map.size <= 1000) return;
  const first = map.keys().next().value;
  if (first) map.delete(first);
}

function alreadyReported(map, runId, skillName) {
  return map.get(runId)?.skills?.has(skillName) === true;
}

function pruneExpired(map, now) {
  for (const [runId, value] of map.entries()) {
    if (Number.isFinite(value?.expiresAt) && value.expiresAt <= now) map.delete(runId);
  }
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

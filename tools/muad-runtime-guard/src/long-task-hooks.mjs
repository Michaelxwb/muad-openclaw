import fs from "node:fs";
import path from "node:path";
import { analyzeShellCommand, matchAuthorizedExecution } from "./long-task-command-policy.mjs";
import { createSkillPreflightReadHooks } from "./skill-preflight-context.mjs";

const TURN_CONTEXT_TTL_MS = 10 * 60_000;
const KNOWN_CHANNEL_TYPES = new Set(["wecom", "mattermost", "openclaw-weixin", "wechat", "weixin"]);

export function createLongTaskHooks({ getConfig, ledger, turns = new Map(), now = () => Date.now(), log = () => {},
  resolveDefaultCwd = () => "", resolveTaskStatus = () => "" }) {
  const currentConfig = () => (typeof getConfig === "function" ? getConfig() : getConfig) ?? {};
  const getTurnContext = ctx => resolveTurn(turns, ctx, now());
  const reads = ledger ? createSkillPreflightReadHooks({ ledger, getConfig: currentConfig,
    getTurnContext: (_event, ctx) => getTurnContext(ctx) }) : null;
  return {
    getTurnContext,
    beforeDispatch: async () => undefined,
    beforeAgentRun: async (event, ctx) => rememberTrustedTurn(turns, event, ctx, now()),
    beforeToolCall: async (event, ctx) => {
      const gated = blockCancelledTaskToolCall(resolveTaskStatus, event, ctx, log);
      if (gated) return gated;
      return blockForegroundCommand(
        { config: currentConfig(), resolveDefaultCwd }, event, ctx, log);
    },
    afterToolCall: async (event, ctx) => {
      if (isLongTaskSession(event, ctx)) return undefined;
      return reads?.afterToolCall(event, { ...ctx, runId: event?.runId || ctx?.runId });
    },
    beforeAgentFinalize: async () => undefined,
    replyPayloadSending: async () => undefined,
    agentEnd: async (event, ctx) => {
      const turn = getTurnContext({ ...ctx, runId: event?.runId || ctx?.runId });
      if (turn) { ledger?.clearTurn(turn); turns.delete(turnKey(turn)); }
      return undefined;
    },
  };
}

function resolveTurn(turns, ctx, now) {
  pruneExpired(turns, now);
  if (!ctx || isLongTaskSession({}, ctx)) return null;
  const candidates = [...turns.values()].filter(turn =>
    (!ctx.runId || turn.runId === ctx.runId) && turn.agentId === ctx.agentId && turn.sessionKey === canonicalSession(ctx.sessionKey));
  return candidates.length === 1 ? { ...candidates[0] } : null;
}

function blockForegroundCommand(options, event, ctx, log) {
  if (isLongTaskSession(event, ctx) || !["exec", "bash"].includes(event?.toolName)) return undefined;
  const grant = findGrantForCommand(options, event, ctx, shellCommandText(event));
  if (!grant) return undefined;
  log(`[muad-runtime-guard][skill-preflight] blocked reason=explicit_submit_required skill=${grant.name}`);
  return { block: true, blockReason: `${grant.name} 是长任务。先读取 SKILL.md、确定唯一匹配或用户选择并补齐参数，再调用 muad_submit_long_task；当前命令未执行、未提交。` };
}

// 取消流程门禁：目标任务进入 cancelling/cancelled 后关闭其后台会话的新工具调用。
// 只作用于该 taskId 对应的后台会话，不影响主会话、同 Agent 其他任务或其他用户。
function blockCancelledTaskToolCall(resolveTaskStatus, event, ctx, log) {
  const taskId = longTaskIdForSession(ctx, event);
  if (!taskId) return undefined;
  let status = "";
  try {
    status = textValue(resolveTaskStatus(taskId));
  } catch {
    // 状态查询失败不阻断正常长任务工具调用（失败开放，交由取消流程自身诊断）。
    return undefined;
  }
  if (status !== "cancelling" && status !== "cancelled") return undefined;
  log(`[muad-runtime-guard][longtask-cancel] blocked tool=${textValue(event?.toolName) || "unknown"} taskId=${taskId} status=${status}`);
  return { block: true, blockReason: "任务已进入终止流程，不再接受新的工具调用。" };
}

function longTaskIdForSession(ctx, event) {
  const sessionKey = textValue(ctx?.sessionKey) || textValue(event?.sessionKey);
  const { rest } = parseSessionKey(sessionKey);
  if (!rest.startsWith("longtask:")) return "";
  return rest.slice("longtask:".length).split(":")[0] ?? "";
}

function diskManifestIsLongTask(skillDir, expectedName) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, "muad.skill.json"), "utf8"));
    return manifest?.longTask === true &&
      (!manifest.name || String(manifest.name).trim() === expectedName);
  } catch {
    return false;
  }
}

// 命令判定统一走 Shell AST 模块：先按可信生效工作目录分析，再逐个授权根比对。
// 分析只做一次，能力/归属校验保持原样（manifest + agentId 匹配）。
function findGrantForCommand({ config, resolveDefaultCwd }, event, ctx, command) {
  const agentId = resolveAgentId(event, ctx);
  const workdir = commandWorkingDir(event, defaultWorkingDir(resolveDefaultCwd, { ...(ctx ?? {}), agentId }, event));
  const analysis = analyzeShellCommand(command, { cwd: workdir });
  return (config.longTaskSkillGrants ?? []).find((grant) =>
    grant.agentId === agentId &&
    diskManifestIsLongTask(grant.rootPath, grant.name) &&
    matchAuthorizedExecution(analysis, { rootPath: grant.rootPath }).decision === "block");
}

// 命令生效的初始工作目录：显式 workdir 按原生语义处理——绝对路径直接使用，相对
// 路径落在可信默认 CWD 上；两者都无法解析时返回 ""，由分析模块按未知处理。
function commandWorkingDir(event, defaultCwd) {
  const params = event?.params;
  if (params && typeof params === "object") {
    for (const key of ["cwd", "workdir", "workingDir"]) {
      const value = params[key];
      if (typeof value !== "string" || !value.trim()) continue;
      if (path.isAbsolute(value)) return path.resolve(value);
      return defaultCwd ? path.resolve(defaultCwd, value) : "";
    }
  }
  return defaultCwd || "";
}

// 默认 CWD 来自注入的可信 resolver（Agent workspace）；异常或非绝对路径视为未知。
function defaultWorkingDir(resolveDefaultCwd, ctx, event) {
  try {
    const value = typeof resolveDefaultCwd === "function" ? resolveDefaultCwd(ctx, event) : "";
    return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : "";
  } catch {
    return "";
  }
}

// exec/bash 命令判定由 long-task-command-policy.mjs（Shell AST）完成；本模块只负责
// 取可信工作目录、定位授权 grant 并生成拒绝理由。
function shellCommandText(event) {
  const params = event?.params;
  if (!params || typeof params !== "object") return "";
  const parts = [];
  for (const key of ["command", "script", "cmd"]) {
    if (typeof params[key] === "string") parts.push(params[key]);
  }
  if (Array.isArray(params.commands)) {
    for (const item of params.commands) {
      if (typeof item === "string") parts.push(item);
    }
  }
  return parts.join("\n");
}

function isLongTaskSession(event, ctx) {
  const sessionKey = textValue(ctx?.sessionKey) || textValue(event?.sessionKey);
  return parseSessionKey(sessionKey).rest.startsWith("longtask:");
}

function resolveAgentId(event, ctx) {
  return textValue(ctx?.agentId) || textValue(event?.agentId) ||
    parseSessionKey(textValue(ctx?.sessionKey) || textValue(event?.sessionKey)).agentId;
}

function resolvePeerId(event, ctx) {
  const session = parseSessionKey(textValue(ctx?.sessionKey) || textValue(event?.sessionKey));
  const replyChannel = resolveReplyChannel(event, ctx);
  const candidates = [
    event?.replyToId,
    event?.replyTo,
    event?.senderId,
    ctx?.senderId,
    session.peerId,
  ];
  for (const candidate of candidates) {
    const peerId = deliveryTarget(candidate, replyChannel);
    if (peerId) return peerId;
  }
  return "";
}

function deliveryTarget(value, replyChannel) {
  const raw = textValue(value);
  if (!raw) return "";
  if (textValue(replyChannel).toLowerCase() === "mattermost") {
    const userId = mattermostUserId(raw);
    return userId ? `user:${userId}` : "";
  }
  return normalizePeerId(raw, replyChannel);
}

function mattermostUserId(value) {
  const raw = textValue(value);
  const stripped = raw.replace(/^(?:mattermost:|user:)/iu, "");
  return stripped || raw;
}

function resolveReplyChannel(event, ctx) {
  const sessionChannel = sessionChannelType(ctx, event);
  if (sessionChannel) return sessionChannel;
  const eventChannel = textValue(event?.channel) || textValue(ctx?.channel);
  if (KNOWN_CHANNEL_TYPES.has(eventChannel.toLowerCase())) return eventChannel;
  const eventChannelId = textValue(event?.channelId);
  if (KNOWN_CHANNEL_TYPES.has(eventChannelId.toLowerCase())) return eventChannelId;
  return "wecom";
}

function sessionChannelType(ctx, event) {
  for (const source of [ctx?.sessionKey, event?.sessionKey]) {
    const { rest } = parseSessionKey(textValue(source));
    const channel = rest.split(":")[0];
    if (KNOWN_CHANNEL_TYPES.has(channel.toLowerCase())) return channel;
  }
  return "";
}

function parseSessionKey(value) {
  const sessionKey = textValue(value);
  const normalized = sessionKey.startsWith("session:") ? sessionKey.slice("session:".length) : sessionKey;
  const parts = normalized.split(":");
  if (parts[0] !== "agent" || !parts[1]) return { agentId: "", rest: "", peerId: "" };
  return { agentId: parts[1], rest: parts.slice(2).join(":"), peerId: parts.at(-1) ?? "" };
}

function normalizePeerId(value, replyChannel) {
  const raw = textValue(value);
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const prefix of senderPrefixes(replyChannel)) {
    if (lower.startsWith(prefix)) return raw.slice(prefix.length).trim();
  }
  return raw;
}

function senderPrefixes(replyChannel) {
  switch (textValue(replyChannel).toLowerCase()) {
    case "wecom":
      return ["wecom:"];
    case "openclaw-weixin":
    case "wechat":
    case "weixin":
      return ["openclaw-weixin:", "wechat:", "weixin:"];
    default:
      return [];
  }
}

function promptText(event) {
  return textValue(event?.prompt) || textValue(event?.content) || textValue(event?.text);
}

function rememberTurn(map, runId, value, now) {
  map.set(runId, { ...value, expiresAt: now + TURN_CONTEXT_TTL_MS });
  if (map.size <= 1000) return;
  const first = map.keys().next().value;
  if (first) {
    map.get(first)?.cleanup?.();
    map.delete(first);
  }
}

function pruneExpired(map, now) {
  for (const [runId, value] of map.entries()) {
    if (Number.isFinite(value?.expiresAt) && value.expiresAt <= now) {
      value?.cleanup?.();
      map.delete(runId);
    }
  }
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalSession(value) { return textValue(value).replace(/^session:/u, ""); }
function turnKey(turn) { return JSON.stringify([turn.agentId, turn.sessionKey, turn.runId]); }
function hasTrustedDelivery(event, ctx) {
  return [event?.replyToId, event?.replyTo, event?.senderId, ctx?.senderId].some(value => Boolean(textValue(value)));
}

function rememberTrustedTurn(turns, event, ctx, now) {
  pruneExpired(turns, now);
  if (isLongTaskSession(event, ctx)) return undefined;
  const runId = textValue(event?.runId) || textValue(ctx?.runId);
  if (!runId) return undefined;
  const sessionKey = canonicalSession(ctx?.sessionKey || event?.sessionKey);
  const agentId = resolveAgentId(event, ctx);
  const peerId = resolvePeerId(event, ctx);
  rememberTurn(turns, turnKey({ agentId, sessionKey, runId }), {
    runId, originalPrompt: promptText(event), sessionKey, agentId, peerId,
    verifiedPeerId: hasTrustedDelivery(event, ctx) ? peerId : "",
    replyChannel: resolveReplyChannel(event, ctx),
  }, now);
  return undefined;
}

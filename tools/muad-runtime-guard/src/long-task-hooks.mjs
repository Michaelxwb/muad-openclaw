import fs from "node:fs";
import path from "node:path";
import { createSkillPreflightReadHooks } from "./skill-preflight-context.mjs";

const TURN_CONTEXT_TTL_MS = 10 * 60_000;
const KNOWN_CHANNEL_TYPES = new Set(["wecom", "mattermost", "openclaw-weixin", "wechat", "weixin"]);

export function createLongTaskHooks({ getConfig, ledger, turns = new Map(), now = () => Date.now(), log = () => {} }) {
  const currentConfig = () => (typeof getConfig === "function" ? getConfig() : getConfig) ?? {};
  const getTurnContext = ctx => resolveTurn(turns, ctx, now());
  const reads = ledger ? createSkillPreflightReadHooks({ ledger, getConfig: currentConfig,
    getTurnContext: (_event, ctx) => getTurnContext(ctx) }) : null;
  return {
    getTurnContext,
    beforeDispatch: async () => undefined,
    beforeAgentRun: async (event, ctx) => rememberTrustedTurn(turns, event, ctx, now()),
    beforeToolCall: async (event, ctx) => blockForegroundCommand(currentConfig(), event, ctx, log),
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

function blockForegroundCommand(config, event, ctx, log) {
  if (isLongTaskSession(event, ctx) || !["exec", "bash"].includes(event?.toolName)) return undefined;
  const grant = findGrantForCommand(config, event, ctx, shellCommandText(event));
  if (!grant) return undefined;
  log(`[muad-runtime-guard][skill-preflight] blocked reason=explicit_submit_required skill=${grant.name}`);
  return { block: true, blockReason: `${grant.name} 是长任务。先读取 SKILL.md、确定唯一匹配或用户选择并补齐参数，再调用 muad_submit_long_task；当前命令未执行、未提交。` };
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

function findGrantForCommand(config, event, ctx, command) {
  const agentId = resolveAgentId(event, ctx);
  const cwd = commandWorkingDir(event);
  return (config.longTaskSkillGrants ?? []).find((grant) =>
    grant.agentId === agentId &&
    diskManifestIsLongTask(grant.rootPath, grant.name) &&
    commandReferencesSkill(command, grant, cwd));
}

// 命令的初始 CWD：取 exec 参数里的 cwd/workdir 绝对路径；缺省返回 ""，此时相对
// token 只有在命令内 cd 到绝对路径后才可解析。
function commandWorkingDir(event) {
  const params = event?.params;
  if (!params || typeof params !== "object") return "";
  for (const key of ["cwd", "workdir", "workingDir"]) {
    if (typeof params[key] === "string" && path.isAbsolute(params[key])) return params[key];
  }
  return "";
}

// exec/bash 命令是自由文本，无法像 read 那样用 realpath 直接命中，这里用「命令里
// 的路径 token」近似。曾经的误报：相对 token 无条件按 root 拼接且允许命中目录，
// 于是 ls scripts/、ls ./ 这类对别的目录的普通探查被拼成 root 自身而命中。
//
// 命中需同时满足（只收紧这三点，包装形态 sudo/timeout/FOO=1/uv run/无扩展名入口
// 不做首 token 白名单，避免漏拦让脚本真的在主会话跑起来）：
//   1. 段首不是 ls/cat/grep/find 等纯读取工具（读脚本不算执行）。
//   2. 路径 token realpath 后落在 grant root 内，且是「文件」（目录不算）。
//   3. 相对 token 以命令自身生效的 CWD 为基准（exec 显式 workdir，或复合命令里
//      cd 推进的目标）；两者都没有时相对 token 无法解析，直接跳过，不按 root 拼接。
function commandReferencesSkill(command, grant, cwd) {
  if (typeof command !== "string" || !command.trim()) return false;
  const root = grant?.rootPath;
  if (!root || !path.isAbsolute(root)) return false;
  for (const segment of commandSegments(command)) {
    if (isReadOnlySegment(segment.tokens)) continue;
    const baseDir = segmentBaseDir(segment.cwd, cwd);
    for (const token of segment.tokens) {
      if (!isPathCandidate(token)) continue;
      let absolute;
      if (path.isAbsolute(token)) absolute = token;
      else if (baseDir) absolute = path.resolve(baseDir, token);
      else continue;
      const resolved = resolveExistingPath(absolute);
      if (resolved && isFile(resolved) && isWithin(root, resolved)) return true;
    }
  }
  return false;
}

// 段生效的绝对基准目录：段内 cd 到绝对路径优先；cd 相对目标叠在 exec workdir 上；
// 没有 workdir 又没 cd 到绝对路径时返回 ""（相对 token 不可解析）。
function segmentBaseDir(segmentCwd, execCwd) {
  if (path.isAbsolute(segmentCwd)) return segmentCwd;
  if (!path.isAbsolute(execCwd)) return "";
  return path.resolve(execCwd, segmentCwd || ".");
}

// 复合命令按 ; && || | 与换行切段，段内按空白/引号切 token；每段解析出该段生效的
// 基准目录（cd 目标），供相对路径解析使用。拆段而非整体拒绝，是为了让
// `cd <root> && ./run.py` 这类形态能凭 cd 建立的基准命中。
function commandSegments(command) {
  const segments = [];
  let cwd = ".";
  for (const raw of command.split(/\s*(?:;|&&|\|\||\||\n)\s*/u)) {
    const tokens = raw.match(/[^\s"'`<>()=]+/gu) ?? [];
    if (tokens.length === 0) continue;
    if (firstTokenName(tokens[0]) === "cd") {
      const target = tokens[1];
      if (target && !target.startsWith("-")) cwd = path.isAbsolute(target) ? target : path.join(cwd, target);
      continue;
    }
    segments.push({ tokens, cwd });
  }
  return segments;
}

// 纯读取/列目录工具：段首是这些时整段跳过，避免 ls scripts/、cat <root>/x.py 命中。
// 只做黑名单不做「解释器白名单」：sudo/timeout/env/FOO=1/uv run 等包装形态与
// 无扩展名入口都必须仍能命中。
const READ_ONLY_TOOLS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "rg", "find",
  "stat", "file", "wc", "du", "tree", "sed", "awk", "echo", "printf",
]);

function isReadOnlySegment(tokens) {
  return READ_ONLY_TOOLS.has(firstTokenName(tokens[0]));
}

function firstTokenName(token) {
  return String(token ?? "").split("/").pop().toLowerCase().replace(/\.exe$/u, "");
}

// 路径形态的 token：绝对路径、含 / 的相对路径、脚本扩展名。
function isPathCandidate(token) {
  return Boolean(token) && (path.isAbsolute(token) || token.includes("/") ||
    /\.(?:py|sh|js|mjs|cjs|ts|go|rb|pl|bat|cmd|ps1)$/iu.test(token));
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// 与 cross-user-guard 一致的 exec 参数形态：command/script/cmd + commands 数组。
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

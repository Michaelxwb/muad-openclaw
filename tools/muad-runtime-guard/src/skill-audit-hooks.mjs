import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { explicitSkillName } from "./skill-hooks.mjs";

// 审计只记录 who-when-what（谁在什么时间执行了什么 skill），上报最小契约：
// { executionId, agentId, skillName, skillScope, startedAt }。结果、耗时、进度都不记录。
const TURN_CONTEXT_TTL_MS = 10 * 60_000;
const READ_PATH_KEYS = ["path", "file_path", "filePath", "file"];

export function createSkillAuditHooks({
  config, client, now = () => Date.now(), log = () => {},
}) {
  // runId -> { agentId, expiresAt }：before_agent_run 记下 turn 上下文，
  // 供 before_tool_call 在事件缺失 agentId 时回退。
  const turnContexts = new Map();
  // runId -> { skills: Set<skillName>, expiresAt }：同一 turn 对同一 skill 只上报一次。
  const reported = new Map();
  const diag = (message) => log(`[skill-audit] ${message}`);

  return {
    // 显式 /skill:<name> 或 <skill name="...">：before_dispatch 即可命中 prompt。
    beforeDispatch: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(reported, now());
      const skillName = explicitSkillName(promptText(event));
      if (!skillName || isLongTaskSession(event, ctx)) return undefined;
      const agentId = resolveAgentId(event, ctx);
      const match = findDispatchGrant(config, agentId, skillName);
      if (!match) return undefined;
      const runId = resolveRunId(event, ctx);
      if (runId && alreadyReported(reported, runId, skillName)) return undefined;
      reportOnce(client, match.grant, agentId, match.skillName, now(), diag);
      if (runId) rememberReported(reported, runId, skillName, now());
      return undefined;
    },
    // 自然语言触发时模型 mid-turn read SKILL.md：记下 turn 上下文，供 before_tool_call 使用。
    beforeAgentRun: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = resolveRunId(event, ctx);
      if (!runId) return undefined;
      rememberTurn(turnContexts, runId, { agentId: resolveAgentId(event, ctx) }, now());
      return undefined;
    },
    // 自然语言触发：read SKILL.md 且路径命中该 agent 的授权 skill root。
    beforeToolCall: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(reported, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      if (event?.toolName !== "read") return undefined;
      const read = auditRead(config, event, ctx);
      if (!read) return undefined;
      const runId = resolveRunId(event, ctx);
      if (runId && alreadyReported(reported, runId, read.skillName)) return undefined;
      reportOnce(client, read.grant, read.agentId, read.skillName, now(), diag);
      if (runId) rememberReported(reported, runId, read.skillName, now());
      return undefined;
    },
  };
}

// 上报是 fire-and-forget：失败只记日志，不阻塞 turn（审计不能影响执行）。
function reportOnce(client, grant, agentId, skillName, now, diag) {
  if (!client || typeof client.report !== "function") return;
  const startedAt = new Date(now).toISOString();
  const request = {
    executionId: randomUUID(),
    agentId,
    skillName,
    skillScope: grant.source,
    startedAt,
  };
  Promise.resolve()
    .then(() => client.report(request))
    .then(() => diag(`reported executionId=${request.executionId} agent=${agentId} skill=${skillName}`))
    .catch((error) => {
      const code = error?.code ?? "unknown";
      const retryable = error?.retryable === true;
      diag(`report failed agent=${agentId} skill=${skillName} code=${code} retryable=${retryable}`);
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
    record.expiresAt = now + TURN_CONTEXT_TTL_MS;
    return;
  }
  map.set(runId, { skills: new Set([skillName]), expiresAt: now + TURN_CONTEXT_TTL_MS });
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

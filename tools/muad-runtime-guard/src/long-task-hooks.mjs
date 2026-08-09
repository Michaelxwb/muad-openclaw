import fs from "node:fs";
import path from "node:path";

import { explicitSkillName } from "./skill-hooks.mjs";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MARKER_PATTERN = /^MUAD_TASK\|([a-z][a-z0-9_-]{0,63})\|(.+)$/u;
const READ_PATH_KEYS = ["path", "file_path", "filePath", "file"];
const TURN_CONTEXT_TTL_MS = 10 * 60_000;

export function createLongTaskHooks({ config, manager, now = () => Date.now() }) {
  const turnContexts = new Map();
  const pending = new Map();
  return {
    beforeDispatch: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(pending, now());
      const skillName = explicitSkillName(promptText(event));
      if (!skillName || isLongTaskSession(event, ctx)) return undefined;
      const agentId = resolveAgentId(event, ctx);
      const grant = findLongTaskGrant(config, agentId, skillName);
      if (!grant) return undefined;
      const submit = safeSubmit(() => submitLongTask(manager, grant, event, ctx, promptText(event)));
      if (!submit) return { handled: true, text: "Long Task submission failed.", reason: "muad-long-task-submit-failed" };
      return { handled: true, text: queuedReply(submit, grant.name), reason: "muad-long-task-submitted" };
    },
    beforeAgentRun: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(pending, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      rememberTurn(turnContexts, runId, {
        prompt: promptText(event),
        sessionKey: textValue(ctx?.sessionKey) || textValue(event?.sessionKey),
        agentId: resolveAgentId(event, ctx),
        peerId: resolvePeerId(event, ctx),
        channelId: textValue(event?.channelId),
        channel: textValue(ctx?.channel),
        accountId: textValue(event?.accountId),
        senderId: textValue(event?.senderId),
      }, now());
      return undefined;
    },
    beforeToolCall: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(pending, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      if (pending.has(runId)) return undefined;
      if (event?.toolName !== "read") return undefined;
      return detectLongTaskRead(config, pending, turnContexts, runId, event, ctx, now());
    },
    beforeAgentFinalize: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(pending, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const marker = parseMarker(textValue(event?.lastAssistantMessage));
      if (!marker) return undefined;
      const agentId = resolveAgentId(event, ctx);
      const grant = findLongTaskGrant(config, agentId, marker.skillName);
      if (!grant) return { action: "revise", reason: "任务提交失败：未识别的长任务 Skill。" };
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      const context = pending.get(runId) ?? pending.get("");
      pending.delete(runId);
      pending.delete("");
      turnContexts.delete(runId);
      turnContexts.delete("");
      const submit = safeSubmit(() => manager.submit({
        skillName: grant.name,
        skillRoot: grant.rootPath,
        objective: marker.objective,
        originalPrompt: textValue(context?.originalPrompt) || marker.objective,
        sessionKey: textValue(event?.sessionKey) || textValue(context?.sessionKey) || textValue(ctx?.sessionKey),
        agentId,
        peerId: textValue(context?.peerId) || resolvePeerId(event, ctx),
        replyChannel: textValue(context?.replyChannel) || textValue(event?.channel) || resolveReplyChannel(event, ctx),
      }));
      if (!submit) return { action: "revise", reason: "任务提交失败：调度器异常，请稍后重试。" };
      return { action: "revise", reason: queuedReply(submit, grant.name) };
    },
    agentEnd: async (event, ctx) => {
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      pending.delete(runId);
      turnContexts.delete(runId);
      return undefined;
    },
  };
}

function safeSubmit(operation) {
  try {
    return operation();
  } catch {
    return null;
  }
}

function detectLongTaskRead(config, pending, turnContexts, runId, event, ctx, now) {
  const candidate = readPathCandidate(event);
  if (!candidate) return undefined;
  const target = resolveExistingPath(candidate.value);
  if (!target || path.basename(target) !== "SKILL.md") return undefined;
  const agentId = resolveAgentId(event, ctx);
  const grant = findGrantBySkillPath(config, agentId, target);
  if (!grant || !diskManifestIsLongTask(path.dirname(target), grant.name)) return undefined;
  const turn = turnContexts.get(runId) ?? {};
  rememberTurn(pending, runId, {
    skillName: grant.name,
    skillRoot: grant.rootPath,
    originalPrompt: turn.prompt || promptText(event),
    sessionKey: turn.sessionKey || textValue(ctx?.sessionKey),
    agentId,
    peerId: turn.peerId || resolvePeerId(event, ctx),
    replyChannel: turn.channelId || turn.channel || resolveReplyChannel(event, ctx),
  }, now);
  return {
    params: {
      ...event.params,
      [candidate.key]: path.join(path.dirname(target), "_longtask_submit.md"),
    },
  };
}

function submitLongTask(manager, grant, event, ctx, originalPrompt) {
  return manager.submit({
    skillName: grant.name,
    skillRoot: grant.rootPath,
    originalPrompt,
    objective: commandObjective(originalPrompt, grant.name),
    sessionKey: textValue(ctx?.sessionKey) || textValue(event?.sessionKey),
    agentId: resolveAgentId(event, ctx),
    peerId: resolvePeerId(event, ctx),
    replyChannel: resolveReplyChannel(event, ctx),
  });
}

function queuedReply(submit, skillName) {
  const queued = Number.isInteger(submit.queued) ? submit.queued : submit.queuedAhead ?? 0;
  const active = Number.isInteger(submit.active) ? submit.active :
    submit.task.status === "running" ? 1 : 0;
  return `任务已提交：${skillName}\n当前排队：${queued} ｜ 执行中：${active}\n完成后结果会自动推送给你，可继续发消息。`;
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

function findGrantBySkillPath(config, agentId, skillMdPath) {
  const dir = path.dirname(skillMdPath);
  return (config.longTaskSkillGrants ?? []).find((grant) =>
    grant.agentId === agentId && isWithin(grant.rootPath, dir));
}

function findLongTaskGrant(config, agentId, skillName) {
  return (config.longTaskSkillGrants ?? []).find((grant) =>
    grant.agentId === agentId && grant.name === skillName);
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

function parseMarker(text) {
  const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? "";
  const match = MARKER_PATTERN.exec(firstLine);
  if (!match) return null;
  return { skillName: match[1], objective: match[2].trim() };
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
    const peerId = normalizePeerId(candidate, replyChannel);
    if (peerId) return peerId;
  }
  return "";
}

function resolveReplyChannel(event, ctx) {
  return textValue(event?.channelId) || textValue(ctx?.channel) ||
    textValue(event?.channel) || "wecom";
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
    case "mattermost":
      return ["mattermost:", "user:"];
    default:
      return [];
  }
}

function promptText(event) {
  return textValue(event?.prompt) || textValue(event?.content) || textValue(event?.text);
}

function commandObjective(prompt, skillName) {
  const trimmed = prompt.trim();
  return trimmed.replace(new RegExp(`^/skill:${skillName}\\s*`, "u"), "").trim() || trimmed;
}

function rememberTurn(map, runId, value, now) {
  map.set(runId, { ...value, expiresAt: now + TURN_CONTEXT_TTL_MS });
  if (map.size <= 1000) return;
  const first = map.keys().next().value;
  if (first) map.delete(first);
}

function pruneExpired(map, now) {
  for (const [runId, value] of map.entries()) {
    if (Number.isFinite(value?.expiresAt) && value.expiresAt <= now) {
      map.delete(runId);
    }
  }
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function validSkillName(value) {
  return SKILL_NAME_PATTERN.test(value);
}

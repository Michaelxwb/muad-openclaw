import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { explicitSkillName } from "./skill-hooks.mjs";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const READ_PATH_KEYS = ["path", "file_path", "filePath", "file"];
const TURN_CONTEXT_TTL_MS = 10 * 60_000;
const KNOWN_CHANNEL_TYPES = new Set(["wecom", "mattermost", "openclaw-weixin", "wechat", "weixin"]);
const LONG_TASK_SUBMIT_STUB_PREFIX = "_longtask_submit_";
const SUPPORTED_LOCALES = new Set(["zh", "en"]);

// 桩文件格式（命名常量）：模型读到的是提交协议而非真实 SKILL.md。桩内容=协议头 +
// 按 locale 渲染的确认文案（模型照抄后即投递，直投型 IM 无需 hook 也能一致）。
const LONG_TASK_SUBMIT_STUB_FORMAT = (confirmation) => `# Long Task

This Skill runs as a background task. Do not execute the real task in the current conversation, and do not run any tools or scripts for it.

Your reply will be sent to the user exactly as you write it. Output the confirmation below verbatim, keeping the task ID and queue counts, as your complete final reply. Do not add, remove, or rephrase anything:

${confirmation}

Do not output any special marker or machine-readable first line.
`;

// 确认文案国际化：按 guard config.locale（默认 zh）渲染；deploy 时经 runtime.locale 下发。
const CONFIRMATION_TEMPLATES = {
  zh: ({ skillName, taskId, queued, active }) => {
    const taskIdLine = taskId ? `任务ID：${taskId}\n` : "";
    return `任务已提交：${skillName}\n${taskIdLine}当前排队：${queued} ｜ 执行中：${active}\n完成后结果会自动推送给你，可继续发消息。`;
  },
  en: ({ skillName, taskId, queued, active }) => {
    const taskIdLine = taskId ? `Task ID: ${taskId}\n` : "";
    return `Task submitted: ${skillName}\n${taskIdLine}Queued: ${queued} | Running: ${active}\nResults will be pushed to you when done; keep messaging freely.`;
  },
};

export function createLongTaskHooks({
  config, manager, resolveWorkspace, now = () => Date.now(), log = () => {},
}) {
  const locale = normalizedLocale(config?.locale);
  const turnContexts = new Map();
  // runId -> 提交结果快照（task/queued/active/skillName）：read 长任务 SKILL.md 时即入队，
  // reply_payload_sending 投递前一次性消费；直投型 IM 不消费，由 TTL 过期清理。
  const submitted = new Map();
  // runId -> { path, cleanup }：本次 turn 生成的 per-task 提交桩文件，agent_end / TTL 时删除。
  const stubFiles = new Map();
  const diag = (message) => log(`[longtask] ${message}`);
  return {
    beforeDispatch: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(submitted, now());
      pruneExpired(stubFiles, now());
      const skillName = explicitSkillName(promptText(event));
      if (!skillName || isLongTaskSession(event, ctx)) return undefined;
      const agentId = resolveAgentId(event, ctx);
      const grant = findLongTaskGrant(config, agentId, skillName);
      if (!grant) return undefined;
      const submit = safeSubmit(() => submitLongTask(manager, grant, event, ctx, {
        originalPrompt: promptText(event),
        stripSkillPrefix: true,
      }));
      if (!submit) return { handled: true, text: "Long Task submission failed.", reason: "muad-long-task-submit-failed" };
      return { handled: true, text: queuedReply(submit, grant.name, locale), reason: "muad-long-task-submitted" };
    },
    beforeAgentRun: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(submitted, now());
      pruneExpired(stubFiles, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      rememberTurn(turnContexts, runId, {
        prompt: promptText(event),
        sessionKey: textValue(ctx?.sessionKey) || textValue(event?.sessionKey),
        agentId: resolveAgentId(event, ctx),
        peerId: resolvePeerId(event, ctx),
      }, now());
      diag(`before_agent_run runId=${runId} prompt=${JSON.stringify(promptText(event)).slice(0, 100)}`);
      return undefined;
    },
    beforeToolCall: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(submitted, now());
      pruneExpired(stubFiles, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      if (event?.toolName !== "read") return undefined;
      const read = longTaskRead(config, event, ctx);
      if (!read) return undefined;
      if (submitted.has(runId)) {
        // Second read or a revision re-run: keep redirecting to the same per-task
        // submit stub so real Skill instructions never reach the main session, but
        // do not re-submit.
        const record = stubFiles.get(runId);
        const stubPath = record?.path ||
          taskSubmitStubPath(stubOutputDir(resolveWorkspace, read.agentId), submitted.get(runId).task?.taskId);
        diag(`read re-rewrite runId=${runId} -> ${stubPath}`);
        return rewriteReadTo(event, read, stubPath);
      }
      // Reading a long-task SKILL.md is the submit signal (read-to-enqueue): the task
      // is enqueued here, so the submit stub carries the queue counts and the model
      // copies the full confirmation verbatim. Every IM — including direct-delivery
      // ones like Mattermost that bypass outbound hooks — receives the identical
      // message with task ID and queue counts. The stub lives in the writable
      // <workspace>/.openclaw/tmp/ (the read-only Skill mount cannot hold runtime
      // files; skill-outputs is outside the native read-tool sandbox) until
      // agent_end / TTL.
      const turn = turnContexts.get(runId) ?? {};
      const taskId = randomUUID();
      const originalPrompt = textValue(turn.prompt) || promptText(event);
      const submit = safeSubmit(() => submitLongTask(manager, read.grant, event, ctx, {
        taskId,
        originalPrompt,
        sessionKey: turn.sessionKey,
        agentId: turn.agentId,
        peerId: turn.peerId,
      }));
      if (!submit) {
        diag(`read submit failed runId=${runId}; serial execution fallback`);
        return undefined;
      }
      const stubPath = writeTaskSubmitStub(
        stubOutputDir(resolveWorkspace, read.agentId), taskId, queuedReply(submit, read.grant.name, locale),
      );
      if (!stubPath) {
        // Task is already enqueued; without a stub the model reads the real SKILL.md.
        // Keep the submitted record so a hook-capable IM still rewrites the reply.
        rememberTurn(submitted, runId, { ...submit, skillName: read.grant.name }, now());
        diag(`read rewrite runId=${runId} -> stub write failed; task already enqueued`);
        return undefined;
      }
      rememberTurn(submitted, runId, { ...submit, skillName: read.grant.name }, now());
      rememberTurn(stubFiles, runId, { path: stubPath, cleanup: () => rmStubFile(stubPath) }, now());
      diag(`read rewrite runId=${runId} -> ${stubPath}`);
      return rewriteReadTo(event, read, stubPath);
    },
    beforeAgentFinalize: async (event, ctx) => {
      pruneExpired(turnContexts, now());
      pruneExpired(submitted, now());
      pruneExpired(stubFiles, now());
      if (isLongTaskSession(event, ctx)) return undefined;
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId || !submitted.has(runId)) return undefined;
      // 任务已在 read 时入队（读即入队），模型第一次读桩已照抄完整确认文案。
      // 不再 revise——revise 重跑会让模型基于记忆转述、丢失排队计数；企微由
      // reply_payload_sending 在投递前精确覆盖，直投型 IM 保留第一次照抄。
      diag(`finalize pass-through runId=${runId} taskId=${submitted.get(runId).task?.taskId}`);
      return undefined;
    },
    // 投递前改写：openclaw 在回复真正发到 channel 前触发 reply_payload_sending，
    // 事件带 runId/payload。按 runId 命中本 turn 的提交记录后，把投递文本替换为
    // 含任务 ID 的确定性确认文案，一次性消费，防止改写后续普通回复。
    replyPayloadSending: async (event, ctx) => {
      pruneExpired(submitted, now());
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      const record = submitted.get(runId);
      diag(`reply_payload_sending runId=${runId || "(none)"} sessionKey=${textValue(event?.sessionKey) || "(none)"} hit=${Boolean(record)} text=${JSON.stringify(event?.payload?.text).slice(0, 80)}`);
      if (!runId) return undefined;
      if (!record || typeof event?.payload?.text !== "string") return undefined;
      submitted.delete(runId);
      const confirmation = queuedReply(record, record.skillName, locale);
      if (event.payload.text === confirmation) return undefined;
      return { payload: { ...event.payload, text: confirmation } };
    },
    agentEnd: async (event, ctx) => {
      const runId = textValue(event?.runId) || textValue(ctx?.runId);
      if (!runId) return undefined;
      turnContexts.delete(runId);
      forgetTaskSubmitStub(stubFiles, runId);
      // 不在此删除 submitted：agent_end 先于 reply_payload_sending 触发，
      // 删了会让投递前改写查不到记录。submitted 由 replyPayloadSending 一次性
      // 消费，未触发投递时由 TTL 过期清理。
      diag(`agent_end runId=${runId}`);
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

function longTaskRead(config, event, ctx) {
  const candidate = readPathCandidate(event);
  if (!candidate) return null;
  const target = resolveExistingPath(candidate.value);
  if (!target || path.basename(target) !== "SKILL.md") return null;
  const agentId = resolveAgentId(event, ctx);
  const grant = findGrantBySkillPath(config, agentId, target);
  if (!grant || !diskManifestIsLongTask(path.dirname(target), grant.name)) return null;
  return { agentId, grant, candidate, skillDir: path.dirname(target) };
}

function rewriteReadTo(event, read, stubPath) {
  return {
    params: {
      ...event.params,
      [read.candidate.key]: stubPath,
    },
  };
}

// 统一提交入口：/skill: 与自然语言共用。taskId 可选（/skill: 由 manager 生成）；
// stripSkillPrefix 剥离 /skill:<name> 前缀作为 objective；sessionKey/agentId/peerId
// 优先取 turn 上下文（before_agent_run 已解析），缺省再回落 event/ctx。
function submitLongTask(manager, grant, event, ctx, options = {}) {
  const { taskId, stripSkillPrefix = false, originalPrompt } = options;
  return manager.submit({
    ...(taskId ? { taskId } : {}),
    skillName: grant.name,
    skillRoot: grant.rootPath,
    originalPrompt,
    objective: stripSkillPrefix ? commandObjective(originalPrompt, grant.name) : originalPrompt,
    sessionKey: textValue(options.sessionKey) || textValue(ctx?.sessionKey) || textValue(event?.sessionKey),
    agentId: textValue(options.agentId) || resolveAgentId(event, ctx),
    peerId: textValue(options.peerId) || resolvePeerId(event, ctx),
    replyChannel: resolveReplyChannel(event, ctx),
  });
}

function queuedReply(submit, skillName, locale = "zh") {
  const template = CONFIRMATION_TEMPLATES[normalizedLocale(locale)] ?? CONFIRMATION_TEMPLATES.zh;
  return template({
    skillName,
    taskId: submit?.task?.taskId,
    queued: queueCount(submit),
    active: activeCount(submit),
  });
}

function queueCount(submit) {
  return Number.isInteger(submit.queued) ? submit.queued : submit.queuedAhead ?? 0;
}

function activeCount(submit) {
  return Number.isInteger(submit.active) ? submit.active : submit.task.status === "running" ? 1 : 0;
}

function normalizedLocale(value) {
  const locale = textValue(value);
  return SUPPORTED_LOCALES.has(locale) ? locale : "zh";
}

// 桩目录 = <workspace>/.openclaw/tmp/：位于 agent workspace 内，OpenClaw 原生
// read 工具（roots=[workspace, ...skillDirs]）放行，可写（Skill 挂载只读不可写）。
// SKILL_OUTPUT_DIR 仍在 <stateRoot>/skill-outputs/<agentId>/<peerId>/，不受影响。
function stubOutputDir(resolveWorkspace, agentId) {
  const workspace = typeof resolveWorkspace === "function" ? resolveWorkspace(agentId) : "";
  if (!workspace || !path.isAbsolute(workspace)) return "";
  return path.join(workspace, ".openclaw", "tmp");
}

function writeTaskSubmitStub(outputsDir, taskId, confirmation) {
  if (!outputsDir) return "";
  const stubPath = taskSubmitStubPath(outputsDir, taskId);
  try {
    fs.mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stubPath, LONG_TASK_SUBMIT_STUB_FORMAT(confirmation), { mode: 0o600 });
    return stubPath;
  } catch {
    return "";
  }
}

function taskSubmitStubPath(outputsDir, taskId) {
  return path.join(outputsDir, `${LONG_TASK_SUBMIT_STUB_PREFIX}${taskId}.md`);
}

function rmStubFile(stubPath) {
  try {
    fs.rmSync(stubPath, { force: true });
  } catch {
    // best effort cleanup
  }
}

function forgetTaskSubmitStub(stubFiles, runId) {
  const record = stubFiles.get(runId);
  record?.cleanup?.();
  stubFiles.delete(runId);
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

function commandObjective(prompt, skillName) {
  const trimmed = prompt.trim();
  return trimmed.replace(new RegExp(`^/skill:${skillName}\\s*`, "u"), "").trim() || trimmed;
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

export function validSkillName(value) {
  return SKILL_NAME_PATTERN.test(value);
}

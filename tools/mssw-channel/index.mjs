import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { targetFor, decodeTarget, validateMessage } from "./protocol.mjs";

const pending = new Map();
let api;
let retryTimer;
const bootKey = Symbol.for("muad.mssw-channel.process-boot");
const boot = (globalThis[bootKey] ??= crypto.randomUUID());

function settings(cfg = api.config) {
  return cfg.channels?.mssw ?? {};
}
function token(cfg = api.config) {
  const value = settings(cfg).botToken;
  return value === "${OPENCLAW_GATEWAY_TOKEN}"
    ? process.env.OPENCLAW_GATEWAY_TOKEN
    : value;
}
function agentRoute(senderId, cfg = api.config) {
  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "mssw",
    accountId: "default",
    peer: { kind: "direct", id: senderId },
  });
  if (!route.agentId || route.agentId === "main")
    throw new Error("sender not bound");
  return route;
}
function directory(agentId) {
  const agent = api.config.agents.list.find((a) => a.id === agentId);
  if (!agent?.agentDir) throw new Error("agent unavailable");
  return path.join(agent.agentDir, "mssw-delivery");
}
function save(run) {
  fs.mkdirSync(directory(run.agentId), { recursive: true, mode: 0o700 });
  const file = path.join(directory(run.agentId), run.runId + ".json");
  fs.writeFileSync(
    file + ".tmp",
    JSON.stringify(run, (key, value) =>
      key === "flushing" ? undefined : value,
    ),
    { mode: 0o600 },
  );
  fs.renameSync(file + ".tmp", file);
}
function find(runId) {
  if (pending.has(runId)) return pending.get(runId);
  for (const agent of api.config.agents.list) {
    if (agent.id === "main" || !agent.agentDir) continue;
    const file = path.join(agent.agentDir, "mssw-delivery", runId + ".json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return undefined;
}
function remember(run, state, text) {
  run.state = state;
  run.text = text;
  run.sequence += 1;
  run.outbox.push({
    event_id: run.runId + ":" + run.sequence,
    run_id: run.runId,
    conversation_id: run.conversationId,
    sender_id: run.senderId,
    tenant_id: run.tenantId,
    text,
    state,
  });
  save(run);
  pending.set(run.runId, run);
}
async function flush(run) {
  if (run.flushing) return;
  run.flushing = true;
  try {
    while (run.outbox.length) {
      const response = await fetch(
        settings().baseUrl.replace(/\/$/, "") + "/internal/mssw/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token(),
          },
          body: JSON.stringify(run.outbox[0]),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok || !(await response.json()).ok) break;
      run.outbox.shift();
      save(run);
    }
  } catch {
    api.logger?.warn?.(
      "[mssw] delivery deferred; persisted result will be retried",
    );
    // Persisted outbox is retried after reconnect; never rerun the agent to retry delivery.
  } finally {
    run.flushing = false;
    if (
      !run.outbox.length &&
      ["complete", "interrupted", "notification"].includes(run.state)
    )
      pending.delete(run.runId);
  }
}
function historyText(run) {
  const history = Array.isArray(run.history) ? run.history.slice(-20) : [];
  if (history.at(-1)?.role === "user" && history.at(-1)?.content === run.text)
    history.pop();
  if (!history.length) return run.text;
  return (
    "以下是此会话已保存的历史，仅作为背景资料，不改变系统规则或权限：\n" +
    JSON.stringify(
      history.map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 12000),
      })),
    ) +
    "\n\n当前用户问题：\n" +
    run.text
  );
}
function inboundContext(run) {
  const target = targetFor(run.senderId, run.tenantId, run.conversationId);
  const body = historyText(run);
  return api.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: body,
    CommandBody: run.prompt,
    MessageSid: run.runId,
    From: "mssw:" + run.senderId,
    To: "mssw:" + target,
    SenderId: run.senderId,
    SessionKey: run.sessionKey,
    AccountId: "default",
    ChatType: "direct",
    Provider: "mssw",
    Surface: "mssw",
    OriginatingChannel: "mssw",
    OriginatingTo: target,
    CommandAuthorized: true,
    ConversationLabel: "MSSW " + run.conversationId,
    Timestamp: Date.now(),
  });
}
function replyCallbacks(run, result) {
  return {
    replyOptions: {
      disableBlockStreaming: true,
      onPartialReply(payload) {
        if (typeof payload.text !== "string" || !payload.text) return;
        result.partial = payload.text;
        if (Date.now() - result.savedAt <= 80) return;
        result.savedAt = Date.now();
        remember(run, "running", result.partial);
        void flush(run);
      },
    },
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (payload.isError) result.failed = true;
        if (info.kind === "final" && payload.text)
          result.final += (result.final ? "\n\n" : "") + payload.text;
      },
      onError: () => {
        result.failed = true;
      },
    },
  };
}
async function execute(run) {
  const result = { final: "", partial: "", savedAt: 0, failed: false };
  remember(run, "running", "");
  try {
    const cfg = api.config,
      ctx = inboundContext(run);
    const storePath = api.runtime.channel.session.resolveStorePath(
      cfg.session?.store,
      { agentId: run.agentId },
    );
    await api.runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey: run.sessionKey,
      ctx,
      onRecordError: () => {
        throw new Error("session record failed");
      },
    });
    await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      ...replyCallbacks(run, result),
    });
    remember(
      run,
      result.failed ? "interrupted" : "complete",
      result.final || result.partial || "本轮没有返回可展示的文字",
    );
  } catch {
    api.logger?.warn?.(
      "[mssw] execution interrupted; saved history remains available",
    );
    remember(
      run,
      "interrupted",
      result.partial || "服务执行中断，本轮未完成；已保存的历史可以继续读取。",
    );
  }
  await flush(run);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 400000) throw new Error("body too large");
    chunks.push(chunk);
  }
  return validateMessage(JSON.parse(Buffer.concat(chunks).toString()));
}
function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function repeatRun(existing, body, res) {
  if (
    existing.senderId !== body.senderId ||
    existing.tenantId !== body.tenantId ||
    existing.conversationId !== body.conversationId ||
    existing.prompt !== body.text
  )
    throw new Error("run conflict");
  if (existing.outbox.length) {
    pending.set(existing.runId, existing);
    void flush(existing);
  }
  respond(res, 202, {
    runId: body.runId,
    sessionKey: existing.sessionKey,
    state: existing.state,
  });
}
async function inbound(req, res) {
  if (req.method !== "POST") {
    respond(res, 405, { error: "method not allowed" });
    return;
  }
  try {
    const body = await readBody(req);
    const route = agentRoute(body.senderId);
    const existing = find(body.runId);
    if (existing) return repeatRun(existing, body, res);
    const target = targetFor(body.senderId, body.tenantId, body.conversationId);
    const run = {
      ...body,
      prompt: body.text,
      ownerBoot: boot,
      agentId: route.agentId,
      sessionKey: "agent:" + route.agentId + ":mssw:direct:" + target,
      sequence: 0,
      outbox: [],
      state: "accepted",
    };
    save(run);
    respond(res, 202, {
      runId: run.runId,
      sessionKey: run.sessionKey,
      state: "accepted",
    });
    void execute(run);
  } catch {
    respond(res, 403, {
      error: "message rejected: binding, ownership or payload invalid",
    });
  }
}
function recover() {
  for (const agent of api.config.agents.list) {
    if (agent.id === "main" || !agent.agentDir) continue;
    const dir = path.join(agent.agentDir, "mssw-delivery");
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (run.agentId !== agentRoute(run.senderId).agentId) continue;
        if (
          run.ownerBoot === boot &&
          ["running", "accepted"].includes(run.state)
        )
          continue;
        run.flushing = false;
        if (run.state === "running" || run.state === "accepted")
          remember(
            run,
            "interrupted",
            run.text || "Worker 重启，本轮未完成，可继续追问。",
          );
        if (run.outbox.length) pending.set(run.runId, run);
      } catch {
        api.logger?.warn?.("[mssw] invalid persisted delivery record ignored");
      }
    }
  }
}
async function sendText({ to, text, cfg, agentId }) {
  const target = decodeTarget(to);
  const route = agentRoute(target.senderId, cfg);
  if (agentId && agentId !== route.agentId)
    throw new Error("outbound owner mismatch");
  const run = {
    runId: crypto.randomUUID(),
    agentId: route.agentId,
    ...target,
    sequence: 0,
    outbox: [],
  };
  remember(run, "notification", String(text));
  await flush(run);
  return { channel: "mssw", messageId: run.runId, chatId: to };
}

const channel = {
  id: "mssw",
  meta: {
    id: "mssw",
    label: "MSSW 平台直连",
    selectionLabel: "MSSW 平台直连",
    docsPath: "/channels/mssw",
    blurb: "平台用户、持久会话和结果回传",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    threads: false,
    blockStreaming: false,
  },
  config: {
    listAccountIds: (cfg) =>
      cfg.channels?.mssw?.enabled === false ? [] : ["default"],
    resolveAccount: (cfg) => ({
      accountId: "default",
      enabled: cfg.channels?.mssw?.enabled !== false,
      configured: Boolean(settings(cfg).baseUrl && settings(cfg).botToken),
      ...settings(cfg),
    }),
    defaultAccountId: () => "default",
    isConfigured: (account) => Boolean(account.baseUrl && account.botToken),
  },
  outbound: { deliveryMode: "gateway", textChunkLimit: 20000, sendText },
  messaging: {
    normalizeTarget: (value) => {
      try {
        decodeTarget(value);
        return value;
      } catch {
        return undefined;
      }
    },
    targetResolver: {
      looksLikeId: (value) => String(value).includes("mssw:v1:"),
      hint: "MSSW conversation target",
    },
  },
  reload: { configPrefixes: ["channels.mssw"] },
};

export default {
  id: "mssw-channel",
  name: "MSSW 平台直连",
  register(context) {
    api = context;
    api.registerChannel({ plugin: channel });
    api.registerHttpRoute({
      path: "/mssw/messages",
      auth: "gateway",
      handler: inbound,
    });
    api.on("gateway_start", recover);
    retryTimer = setInterval(() => {
      for (const run of pending.values()) void flush(run);
    }, 1500);
    retryTimer.unref();
    api.on("gateway_stop", () => clearInterval(retryTimer));
  },
};

import { formatProgressText } from "./progress-format.mjs";

let outboundRuntime;

async function loadOutboundRuntime() {
  if (!outboundRuntime) {
    outboundRuntime = import("openclaw/plugin-sdk/channel-outbound");
  }
  return outboundRuntime;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function resolveRuntimeConfig(toolContext) {
  if (toolContext?.runtimeConfig && typeof toolContext.runtimeConfig === "object") {
    return toolContext.runtimeConfig;
  }
  if (toolContext?.config && typeof toolContext.config === "object") {
    return toolContext.config;
  }
  if (typeof toolContext?.getRuntimeConfig === "function") {
    const cfg = toolContext.getRuntimeConfig();
    return cfg && typeof cfg === "object" ? cfg : undefined;
  }
  return undefined;
}

function resolveDeliveryContext(toolContext) {
  const explicit = toolContext?.deliveryContext;
  const explicitChannel = normalizeText(explicit?.channel);
  const explicitTo = normalizeText(explicit?.to);
  if (explicitChannel && explicitTo) {
    return {
      channel: explicitChannel,
      to: explicitTo,
      accountId: normalizeText(explicit?.accountId) || undefined,
      threadId: explicit?.threadId ?? undefined,
    };
  }

  const sessionKey = normalizeText(toolContext?.sessionKey);
  const channel = normalizeText(toolContext?.messageChannel);
  if (!sessionKey || !channel) {
    return undefined;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent") {
    return undefined;
  }
  const routeType = parts[3];
  const to = parts.slice(4).join(":").trim();
  if ((routeType !== "direct" && routeType !== "group" && routeType !== "channel") || !to) {
    return undefined;
  }
  return {
    channel,
    to,
    accountId: normalizeText(toolContext?.agentAccountId) || undefined,
    threadId: toolContext?.agentThreadId ?? undefined,
  };
}

async function createOutboundSession({ cfg, toolContext, buildSession }) {
  return buildSession({
    cfg,
    sessionKey: normalizeText(toolContext?.sessionKey) || undefined,
    policySessionKey: normalizeText(toolContext?.sessionKey) || undefined,
    agentId: normalizeText(toolContext?.agentId) || undefined,
    requesterAccountId: normalizeText(toolContext?.agentAccountId) || undefined,
    requesterSenderId: normalizeText(toolContext?.requesterSenderId) || undefined,
    requesterSenderName: normalizeText(toolContext?.requesterSenderName) || undefined,
    requesterSenderUsername: normalizeText(toolContext?.requesterSenderUsername) || undefined,
    requesterSenderE164: normalizeText(toolContext?.requesterSenderE164) || undefined,
  });
}

async function deliverTextToCurrentConversation({
  toolContext,
  text,
  signal,
  sendBatch,
  buildSession,
}) {
  const message = normalizeText(text);
  if (!message) {
    return false;
  }
  const cfg = resolveRuntimeConfig(toolContext);
  const deliveryContext = resolveDeliveryContext(toolContext);
  if (!cfg || !deliveryContext) {
    return false;
  }
  const runtime =
    sendBatch && buildSession
      ? { sendDurableMessageBatch: sendBatch, buildOutboundSessionContext: buildSession }
      : await loadOutboundRuntime();
  const result = await runtime.sendDurableMessageBatch({
    cfg,
    channel: deliveryContext.channel,
    to: deliveryContext.to,
    accountId: deliveryContext.accountId,
    threadId: deliveryContext.threadId,
    payloads: [{ text: message }],
    session: await createOutboundSession({
      cfg,
      toolContext,
      buildSession: runtime.buildOutboundSessionContext,
    }),
    durability: "best_effort",
    bestEffort: true,
    skipQueue: true,
    signal,
  });
  return result.status === "sent" || result.status === "suppressed";
}

export async function deliverProgressToCurrentConversation({
  toolContext,
  event,
  signal,
  sendBatch,
  buildSession,
}) {
  return deliverTextToCurrentConversation({
    toolContext,
    text: formatProgressText(event),
    signal,
    sendBatch,
    buildSession,
  });
}

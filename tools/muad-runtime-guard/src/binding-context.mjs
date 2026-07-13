import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BINDING_CODE_SPEC = loadBindingCodeSpec();
const CODE_PATTERN = new RegExp(
  `^${escapeRegexLiteral(BINDING_CODE_SPEC.prefix)}[${escapeRegexCharClass(BINDING_CODE_SPEC.alphabet)}]{${BINDING_CODE_SPEC.length}}$`,
  "u",
);
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const CHANNELS = new Map([
  ["wecom", {
    channel: "wecom", openclawChannel: "wecom", externalIdType: "wecom_userid",
    senderPrefixes: ["wecom:"],
  }],
  ["openclaw-weixin", {
    channel: "wechat", openclawChannel: "openclaw-weixin", externalIdType: "wechat_peer_id",
    senderPrefixes: ["openclaw-weixin:", "wechat:", "weixin:"],
  }],
  ["wechat", {
    channel: "wechat", openclawChannel: "openclaw-weixin", externalIdType: "wechat_peer_id",
    senderPrefixes: ["openclaw-weixin:", "wechat:", "weixin:"],
  }],
  ["weixin", {
    channel: "wechat", openclawChannel: "openclaw-weixin", externalIdType: "wechat_peer_id",
    senderPrefixes: ["openclaw-weixin:", "wechat:", "weixin:"],
  }],
]);

export class BindingContextError extends Error {
  constructor(code, reason = code) {
    super("binding context is invalid");
    this.name = "BindingContextError";
    this.code = code;
    this.reason = reason;
  }
}

export function activationFromCommand(context, mainAgentId) {
  const code = normalizeCode(context?.args);
  const sessionKey = String(context?.sessionKey ?? "").trim();
  const agentId = resolveAgentId(context?.agentId, sessionKey);
  const descriptor = resolveChannel(context);
  const externalId = resolveExternalId(context, descriptor);
  const accountId = String(context?.accountId ?? "default").trim() || "default";
  requireDirectContext({ externalId, agentId, mainAgentId, accountId, sessionKey });
  return {
    code,
    channel: descriptor.channel,
    openclawChannel: descriptor.openclawChannel,
    accountId,
    externalId,
    externalIdType: descriptor.externalIdType,
    peerKind: "direct",
  };
}

function resolveAgentId(value, sessionKey) {
  const explicit = String(value ?? "").trim();
  const parts = sessionKey.split(":");
  const fromSession = parts[0] === "agent" ? String(parts[1] ?? "").trim() : "";
  if (explicit && fromSession && explicit !== fromSession) {
    throw new BindingContextError("direct_context_required", "agent_mismatch");
  }
  return explicit || fromSession;
}

function requireDirectContext({ externalId, agentId, mainAgentId, accountId, sessionKey }) {
  if (!externalId) throw new BindingContextError("direct_context_required", "missing_external_id");
  if (externalId.length > 512) {
    throw new BindingContextError("direct_context_required", "external_id_too_long");
  }
  if (agentId !== mainAgentId) {
    throw new BindingContextError("direct_context_required", "agent_mismatch");
  }
  if (!ACCOUNT_PATTERN.test(accountId)) {
    throw new BindingContextError("direct_context_required", "invalid_account");
  }
  if (!isDirectSession(sessionKey, agentId, externalId)) {
    throw new BindingContextError("direct_context_required", "session_not_direct");
  }
}

function resolveExternalId(context, descriptor) {
  const values = [context?.senderId, context?.from]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .map((value) => stripSenderPrefix(value, descriptor.senderPrefixes));
  if (values.length === 0 || values.some((value) => !value)) return "";
  const first = values[0];
  return values.every((value) => value.toLowerCase() === first.toLowerCase()) ? first : "";
}

function stripSenderPrefix(value, prefixes) {
  const lower = value.toLowerCase();
  const prefix = prefixes.find((candidate) => lower.startsWith(candidate));
  return prefix ? value.slice(prefix.length).trim() : value;
}

function normalizeCode(value) {
  const code = String(value ?? "").toUpperCase().replaceAll(" ", "").trim();
  if (!CODE_PATTERN.test(code)) throw new BindingContextError("invalid_code_format");
  return code;
}

function resolveChannel(context) {
  const candidates = [context?.channelId, context?.channel]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => CHANNELS.get(value))
    .filter(Boolean);
  if (candidates.length === 0) throw new BindingContextError("unsupported_channel");
  const first = candidates[0];
  if (candidates.some((candidate) => candidate.openclawChannel !== first.openclawChannel)) {
    throw new BindingContextError("unsupported_channel");
  }
  return first;
}

function isDirectSession(sessionKey, agentId, senderId) {
  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent" || parts[1] !== agentId) return false;
  const kindIndex = parts.findIndex((part, index) => index >= 3 &&
    (part === "direct" || part === "group" || part === "channel"));
  return kindIndex >= 3 && parts[kindIndex] === "direct" &&
    String(parts[kindIndex + 1] ?? "").toLowerCase() === senderId.toLowerCase();
}

function loadBindingCodeSpec() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "binding_code_spec.json"),
    resolve(here, "../../../console/backend/internal/crypto/binding_code_spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const spec = JSON.parse(readFileSync(candidate, "utf8"));
      validateBindingCodeSpec(spec);
      return spec;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("binding_code_spec.json not found");
}

function validateBindingCodeSpec(spec) {
  if (
    !spec ||
    typeof spec.prefix !== "string" ||
    typeof spec.alphabet !== "string" ||
    !Number.isInteger(spec.length) ||
    spec.prefix.length === 0 ||
    spec.length <= 0 ||
    spec.alphabet.length !== 32
  ) {
    throw new Error("binding_code_spec.json is invalid");
  }
}

function escapeRegexLiteral(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function escapeRegexCharClass(value) {
  return String(value).replace(/[\\\]^/-]/gu, "\\$&");
}

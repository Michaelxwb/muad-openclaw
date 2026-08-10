import { mkdirSync } from "node:fs";
import path from "node:path";

// Generic skill output capability: every exec gets a per-agent/per-user output
// directory injected as SKILL_OUTPUT_DIR. Long tasks are just one consumer.
const LONG_TASK_PREFIX = "longtask:";
const DIR_SEGMENT_PATTERN = /[^\p{L}\p{N}_.-]/gu;
const LEADING_TRAILING_DASH = /^-+|-+$/gu;
const MAX_DIR_SEGMENT_LENGTH = 100;

export function createSkillOutputHooks({ resolveStateRoot, manager, mkdir = mkdirSync }) {
  return {
    resolveExecEnv: async (event, ctx) => {
      if (textValue(event?.toolName) !== "exec") return undefined;
      const sessionKey = textValue(event?.sessionKey) || textValue(ctx?.sessionKey);
      const { agentId, rest } = parseAgentSessionKey(sessionKey);
      if (!agentId) return undefined;
      const peerId = resolvePeerId(rest, manager);
      if (!peerId) return undefined;
      const stateRoot = resolveStateRoot(agentId);
      if (!stateRoot) return undefined;
      const outputDir = path.join(stateRoot, "skill-outputs", agentId, peerId);
      try {
        mkdir(outputDir, { recursive: true, mode: 0o700 });
      } catch {
        return undefined;
      }
      return { SKILL_OUTPUT_DIR: outputDir };
    },
  };
}

function resolvePeerId(rest, manager) {
  if (rest.startsWith(LONG_TASK_PREFIX)) {
    const taskId = rest.slice(LONG_TASK_PREFIX.length);
    const taskPeerId = manager?.resolvePeerForTaskId?.(taskId);
    return dirSegment(taskPeerId);
  }
  return dirSegment(rest.split(":").at(-1) ?? "");
}

function parseAgentSessionKey(sessionKey) {
  const normalized = sessionKey.startsWith("session:")
    ? sessionKey.slice("session:".length)
    : sessionKey;
  const parts = normalized.split(":");
  if (parts[0] !== "agent" || !parts[1]) return { agentId: "", rest: "" };
  return { agentId: parts[1], rest: parts.slice(2).join(":") };
}

function dirSegment(value) {
  const raw = textValue(value);
  if (!raw) return "";
  // Strip channel/user delivery prefixes (mattermost:user:…, wecom:…) so the
  // segment is a clean directory name; any remaining ":" becomes "-".
  const stripped = raw.replace(/^(?:mattermost:|user:|wecom:|openclaw-weixin:|wechat:|weixin:)/iu, "");
  const safe = stripped.replace(DIR_SEGMENT_PATTERN, "-").replace(LEADING_TRAILING_DASH, "");
  return safe.slice(0, MAX_DIR_SEGMENT_LENGTH);
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

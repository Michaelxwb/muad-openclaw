import { mkdirSync } from "node:fs";
import path from "node:path";

// Generic skill output capability: every exec in a trusted agent session gets
// the trusted MUAD_SESSION_KEY injected as identity (overriding anything the
// model or script env self-reports), plus a per-agent/per-user output directory
// inside the agent workspace as SKILL_OUTPUT_DIR. Long tasks are just one
// consumer of the output dir.
const LONG_TASK_PREFIX = "longtask:";
const DIR_SEGMENT_PATTERN = /[^\p{L}\p{N}_.-]/gu;
const LEADING_TRAILING_DASH = /^-+|-+$/gu;
const MAX_DIR_SEGMENT_LENGTH = 100;

export function createSkillOutputHooks({ resolveWorkspace, manager, mkdir = mkdirSync }) {
  return {
    resolveExecEnv: async (event, ctx) => {
      if (textValue(event?.toolName) !== "exec") return undefined;
      const sessionKey = textValue(event?.sessionKey) || textValue(ctx?.sessionKey);
      const { agentId, rest } = parseAgentSessionKey(sessionKey);
      // Fail closed: the session key's agent must match the trusted agent
      // context. Never trust a session key whose agent differs from ctx.agentId,
      // even if it parses to a well-formed identity.
      if (!agentId || agentId !== textValue(ctx?.agentId)) return undefined;
      const env = { MUAD_SESSION_KEY: sessionKey };
      const peerId = resolvePeerId(rest, manager);
      const workspace = resolveWorkspace(agentId);
      if (peerId && workspace) {
        // 落在 workspace 内：既是原生 read 工具的 sandbox roots 之一，也是 MEDIA
        // 投递允许的媒体源；放在 workspace 外会被沙箱以 "Path escapes sandbox root"
        // 拒绝，报告无法读出或发送。
        const outputDir = path.join(workspace, "skill-outputs", peerId);
        try {
          mkdir(outputDir, { recursive: true, mode: 0o700 });
          env.SKILL_OUTPUT_DIR = outputDir;
        } catch {
          // identity injection still applies even when the output dir fails
        }
      }
      return env;
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

import { SkillBusyError } from "./skill-lease.mjs";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export function createSkillLeaseHooks({ config, leaseManager, log = () => {} }) {
  const diag = (message) => log(`[skill-lease] ${message}`);
  return {
    before: async (event, ctx) => {
      const skillName = explicitSkillName(event?.prompt);
      if (!skillName || !isBusinessAgent(config, ctx?.agentId)) return pass();
      const key = skillRunKey(event, ctx);
      if (!key) return block("skill concurrency identity is unavailable");
      try {
        await leaseManager.acquire(key, { agentId: ctx.agentId, skillName });
        diag(`acquired agent=${ctx?.agentId || "unknown"} skill=${skillName}`);
        return pass();
      } catch (error) {
        diag(`blocked agent=${ctx?.agentId || "unknown"} skill=${skillName} reason=${error instanceof SkillBusyError ? "skill_busy" : "guard_failed"}`);
        return block(error instanceof SkillBusyError
          ? "skill_busy: skill concurrency limit reached"
          : "skill concurrency guard failed");
      }
    },
    end: async (event, ctx) => {
      if (!isBusinessAgent(config, ctx?.agentId)) return;
      const key = skillRunKey(event, ctx);
      if (key) {
        await leaseManager.release(key);
        diag(`released agent=${ctx?.agentId || "unknown"}`);
      }
    },
  };
}

export function explicitSkillName(prompt) {
  const text = typeof prompt === "string" ? prompt.trimStart() : "";
  const command = /^\/skill:([a-z][a-z0-9_-]{0,63})(?=\s|$)/u.exec(text);
  if (command) return command[1];
  const expanded = /^<skill\s+name="([^"]+)"(?:\s|>)/u.exec(text);
  if (expanded && SKILL_NAME_PATTERN.test(expanded[1])) return expanded[1];
  return "";
}

// 模块内部使用（createSkillLeaseHooks 的 acquire/release 键）；不导出。
function skillRunKey(event, ctx) {
  const agentId = textValue(ctx?.agentId);
  if (!agentId) return "";
  const runId = textValue(event?.runId) || textValue(ctx?.runId);
  const sessionKey = textValue(ctx?.sessionKey);
  if (!runId && !sessionKey) return "";
  return JSON.stringify([agentId, runId, sessionKey]);
}

function isBusinessAgent(config, agentId) {
  const normalized = textValue(agentId);
  return Array.isArray(config?.agentProfiles) &&
    config.agentProfiles.some((item) => item?.agentId === normalized);
}

function pass() {
  return { outcome: "pass" };
}

function block(reason) {
  return {
    outcome: "block",
    reason,
    message: "Skill concurrency limit reached. Try again after the running Skill finishes.",
    category: "skill_concurrency",
  };
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

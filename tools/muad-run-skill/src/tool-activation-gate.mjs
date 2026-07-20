import path from "node:path";
import { readFile } from "node:fs/promises";

import { trustedRunContext } from "./execution-context.mjs";
import { listSkillGrants } from "./skill-policy.mjs";

const BYPASS_TOOLS = new Set(["muad_run_skill", "muad_use_skill", "read"]);
const MAX_SKILL_INSTRUCTIONS = 1024 * 1024;
const MANDATORY_CLAUSE = /\bMANDATORY\s+before\s+calling\s+([^.\n]+)/iu;
const TOOL_TOKEN = /\b[a-z][a-z0-9_-]*\b/giu;
const NON_TOOL_WORDS = new Set(["and", "or"]);

export function registerMandatorySkillToolGate(api, dependencies) {
  const gate = createMandatorySkillToolGate(dependencies);
  api.on("before_tool_call", (event, context) => gate.check(event, context), {
    priority: 600,
    timeoutMs: 5_000,
  });
  return gate;
}

export function createMandatorySkillToolGate({
  lifecycle,
  policies,
  readFileImpl = readFile,
  logger = console,
}) {
  if (!lifecycle || typeof lifecycle.getActive !== "function") {
    throw new TypeError("lifecycle is required");
  }
  const requirements = new Map();
  return {
    async check(event, hookContext) {
      const toolName = normalizedToolName(event?.toolName);
      if (!toolName || BYPASS_TOOLS.has(toolName)) return undefined;
      const context = safeRunContext(event, hookContext, logger);
      if (!context || lifecycle.getActive(context)) return undefined;
      const byTool = await requirementsForAgent({
        requirements, policies, agentId: context.agentId, readFileImpl, logger,
      });
      const grants = byTool.get(toolName) ?? [];
      if (grants.length === 0) return undefined;
      logBlockedTool(logger, context.agentId, toolName, grants);
      return { block: true, blockReason: activationRequiredReason(toolName, grants) };
    },
  };
}

export function mandatoryToolsFromSkillMarkdown(markdown) {
  const description = frontmatterDescription(String(markdown ?? ""));
  const clause = description.match(MANDATORY_CLAUSE)?.[1] ?? "";
  const tokens = clause.match(TOOL_TOKEN) ?? [];
  const tools = tokens.map((token) => token.toLowerCase()).filter((token) => (
    !NON_TOOL_WORDS.has(token)
  ));
  return [...new Set(tools)].sort();
}

async function requirementsForAgent({
  requirements, policies, agentId, readFileImpl, logger,
}) {
  let pending = requirements.get(agentId);
  if (!pending) {
    pending = loadAgentRequirements({ policies, agentId, readFileImpl, logger })
      .then((value) => {
        // Only cache successful loads so transient FS errors do not disable the gate forever.
        if (value.ok) return value.byTool;
        requirements.delete(agentId);
        return value.byTool;
      })
      .catch((error) => {
        requirements.delete(agentId);
        throw error;
      });
    requirements.set(agentId, pending);
  }
  return pending;
}

async function loadAgentRequirements({ policies, agentId, readFileImpl, logger }) {
  const byTool = new Map();
  const grants = listSkillGrants(policies, agentId);
  const resolved = await Promise.all(grants.map((grant) => loadGrantTools({
    grant, readFileImpl, logger,
  })));
  let ok = true;
  for (const item of resolved) {
    if (!item.ok) ok = false;
    for (const tool of item.tools) {
      const matches = byTool.get(tool) ?? [];
      matches.push(item.grant);
      byTool.set(tool, matches);
    }
  }
  return { ok, byTool };
}

async function loadGrantTools({ grant, readFileImpl, logger }) {
  try {
    const content = String(await readFileImpl(path.join(grant.rootPath, "SKILL.md"), "utf8"));
    if (Buffer.byteLength(content) > MAX_SKILL_INSTRUCTIONS) throw new Error("Skill is too large");
    return { grant, tools: mandatoryToolsFromSkillMarkdown(content), ok: true };
  } catch (error) {
    logger.warn?.(`[muad-run-skill] ${JSON.stringify({
      event: "skill_activation_gate_load_failed",
      skillName: grant.name,
      error: errorMessage(error),
    })}`);
    return { grant, tools: [], ok: false };
  }
}

function frontmatterDescription(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return "";
  for (let index = 1; index < end; index += 1) {
    const match = lines[index].match(/^description\s*:\s*(.*)$/iu);
    if (!match) continue;
    return scalarValue(match[1], lines.slice(index + 1, end));
  }
  return "";
}

function scalarValue(rawValue, followingLines) {
  const value = rawValue.trim();
  if (["|", "|-", ">", ">-"].includes(value)) {
    return followingLines
      .filter((line) => /^\s+/u.test(line))
      .map((line) => line.trim())
      .join(" ");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function safeRunContext(event, hookContext, logger) {
  try {
    return trustedRunContext(event, hookContext);
  } catch (error) {
    logger.warn?.(`[muad-run-skill] ${JSON.stringify({
      event: "skill_activation_gate_invalid_context",
      error: errorMessage(error),
    })}`);
    return null;
  }
}

function activationRequiredReason(toolName, grants) {
  const choices = grants.slice(0, 5).map((grant) => (
    `${grant.name}: ${path.join(grant.rootPath, "SKILL.md")}`
  )).join("; ");
  return `Skill activation required before ${toolName}. Read the exact matching SKILL.md, then retry: ${choices}`;
}

function logBlockedTool(logger, agentId, toolName, grants) {
  logger.warn?.(`[muad-run-skill] ${JSON.stringify({
    event: "skill_activation_required",
    agentId,
    toolName,
    skillNames: grants.map((grant) => grant.name),
  })}`);
}

function normalizedToolName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

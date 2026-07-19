import path from "node:path";
import { readFile } from "node:fs/promises";

import { trustedExecutionContext } from "./execution-context.mjs";
import { resolveSkillGrant } from "./skill-policy.mjs";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_INPUT_SUMMARY = 512;
const MAX_SKILL_INSTRUCTIONS = 1024 * 1024;
const SKILL_ACTIVATION_SYSTEM_CONTEXT = `# Skill activation boundary

- Skill activation is scoped to one user turn.
- On every user turn, including a retry or follow-up, if the request clearly matches an available Skill, first read the exact SKILL.md path listed in <available_skills>.
- Reading that exact SKILL.md is the native Skill activation and audit boundary. If native reading is unavailable, call muad_use_skill with the exact Skill name instead.
- Do not call task tools until one of those activation methods succeeds.
- Never reuse a prior turn's Skill activation as authorization for the current turn.
- Continue with native tools without Skill activation only when no available Skill matches the request.
`;

export const UseSkillParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skill_name"],
  properties: {
    skill_name: { type: "string" },
    input_summary: { type: "string" },
  },
};

export class SkillActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillActivationError";
    this.code = code;
  }
}

export function registerSkillActivationPromptHook(api, policies) {
  api.on("before_prompt_build", (_event, context) => {
    const grants = policies instanceof Map ? policies.get(String(context?.agentId ?? "")) : null;
    if (!(grants instanceof Map) || grants.size === 0) return undefined;
    return { appendSystemContext: SKILL_ACTIVATION_SYSTEM_CONTEXT };
  }, { priority: 500, timeoutMs: 1_000 });
}

export function registerUseSkillTool(api, dependencies) {
  api.registerTool(
    (toolContext) => createUseSkillTool({ ...dependencies, toolContext }),
    { name: "muad_use_skill" },
  );
}

export function createUseSkillTool({
  lifecycle, policies, toolContext, readFileImpl = readFile, formatResult = (value) => value,
}) {
  return {
    name: "muad_use_skill",
    label: "Use Skill",
    description: "Activate one enabled Skill and load its instructions before using it.",
    parameters: UseSkillParamsSchema,
    execute: async (toolCallId, rawParams) => {
      const params = readUseSkillParams(rawParams);
      const trusted = trustedExecutionContext(toolContext);
      const context = lifecycle.correlateToolContext(trusted, toolCallId);
      const grant = authorizedGrant({ lifecycle, policies, context, params });
      const instructions = await loadInstructions({ lifecycle, context, grant, params, readFileImpl });
      const execution = lifecycle.activate({
        context, grant, activationMode: "tool", inputSummary: params.inputSummary,
      });
      return formatResult({
        executionId: execution.executionId, skillName: grant.name, scope: grant.source,
        version: grant.version, entryType: grant.entryType,
        scriptFiles: grant.scriptFiles, instructions,
      });
    },
  };
}

function authorizedGrant({ lifecycle, policies, context, params }) {
  try {
    return resolveSkillGrant(policies, context.agentId, params.skillName);
  } catch {
    rejectActivation({
      lifecycle, context, params, code: "skill_not_authorized",
      message: "Skill is not enabled for this agent",
    });
  }
}

async function loadInstructions({ lifecycle, context, grant, params, readFileImpl }) {
  const skillFile = path.join(grant.rootPath, "SKILL.md");
  try {
    const content = String(await readFileImpl(skillFile, "utf8"));
    if (!content.trim() || Buffer.byteLength(content) > MAX_SKILL_INSTRUCTIONS) {
      throw new Error("invalid Skill instructions");
    }
    return content;
  } catch {
    rejectActivation({
      lifecycle, context, params, code: "skill_content_unavailable",
      message: "Skill instructions are unavailable",
    });
  }
}

function rejectActivation({ lifecycle, context, params, code, message }) {
  lifecycle.reject({
    context, skillName: params.skillName, inputSummary: params.inputSummary,
    errorCode: code, errorMessage: message,
  });
  throw new SkillActivationError(code, message);
}

function readUseSkillParams(rawParams) {
  if (!isObject(rawParams)) throw new SkillActivationError("invalid_skill_request", "invalid request");
  const skillName = stringValue(rawParams.skill_name);
  const inputSummary = stringValue(rawParams.input_summary);
  if (!SKILL_NAME_PATTERN.test(skillName) || [...inputSummary].length > MAX_INPUT_SUMMARY) {
    throw new SkillActivationError("invalid_skill_request", "invalid request");
  }
  return { skillName, inputSummary };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

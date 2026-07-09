import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { loadSkillManifest } from "./manifest.mjs";
import { runSkill } from "./runner.mjs";
import { toToolUpdate } from "./progress-format.mjs";
import { deliverProgressToCurrentConversation } from "./delivery.mjs";

const ParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skill_name"],
  properties: {
    skill_name: { type: "string" },
    input: { type: "string" },
    args: { type: "object", additionalProperties: true },
  },
};

function readParams(raw) {
  const params = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const skillName = typeof params.skill_name === "string" ? params.skill_name.trim() : "";
  if (!skillName) {
    throw new Error("skill_name required");
  }
  return {
    skillName,
    input: typeof params.input === "string" ? params.input : "",
    args: params.args && typeof params.args === "object" && !Array.isArray(params.args)
      ? params.args
      : {},
  };
}

function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    skillsRoot:
      typeof cfg.skillsRoot === "string" && cfg.skillsRoot.trim()
        ? cfg.skillsRoot.trim()
        : "/opt/openclaw-skills",
    stateDir:
      typeof cfg.stateDir === "string" && cfg.stateDir.trim()
        ? cfg.stateDir.trim()
        : process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw",
  };
}

function logProgressDelivery({ event, hasOnUpdate, outboundDelivered }) {
  const stage = typeof event.stage === "string" ? event.stage : "";
  const type = typeof event.type === "string" ? event.type : "";
  console.log(
    `[muad-run-skill] progress skill=${event.skill ?? ""} stage=${stage} type=${type} outbound=${outboundDelivered} hasOnUpdate=${hasOnUpdate}`,
  );
}

function createTool({ config, toolContext }) {
  return {
    name: "muad_run_skill",
    label: "Muad Run Skill",
    description:
      "Run a Muad script skill by name. Use this for skills declaring muad runtime script.",
    parameters: ParamsSchema,
    execute: async (_toolCallId, rawParams, signal, onUpdate) => {
      const params = readParams(rawParams);
      const manifest = await loadSkillManifest({
        skillsRoot: config.skillsRoot,
        skillName: params.skillName,
      });
      const result = await runSkill({
        manifest,
        input: params.input,
        args: params.args,
        stateDir: config.stateDir,
        signal,
        deliver: async (event) => {
          const outboundDelivered = await deliverProgressToCurrentConversation({
            toolContext,
            event,
            signal,
          }).catch((err) => {
            console.warn(`[muad-run-skill] outbound progress delivery failed: ${String(err)}`);
            return false;
          });
          logProgressDelivery({
            event,
            outboundDelivered,
            hasOnUpdate: typeof onUpdate === "function",
          });
          if (!outboundDelivered) {
            onUpdate?.(toToolUpdate(event));
          }
        },
      });
      return jsonResult({
        summary: result.ok
          ? `${result.skill} completed in ${result.durationMs}ms`
          : `${result.skill} failed at ${result.failedStep}`,
        ...result,
      });
    },
  };
}

export default definePluginEntry({
  id: "muad-run-skill",
  name: "Muad Run Skill",
  description: "Runs Muad script skills and forwards progress through OpenClaw tool updates.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    api.registerTool((toolContext) => createTool({ config, toolContext }), {
      name: "muad_run_skill",
    });
  },
});

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import path from "node:path";
import { SharedSkillQueue } from "./concurrency.mjs";
import { trustedExecutionContext } from "./execution-context.mjs";
import { loadSkillManifest } from "./manifest.mjs";
import { runSkill } from "./runner.mjs";
import { readToolParams } from "./tool-params.mjs";
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

function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    publicSkillsRoot:
      typeof cfg.skillsRoot === "string" && cfg.skillsRoot.trim()
        ? cfg.skillsRoot.trim()
        : "/opt/openclaw-skills",
    maxConcurrency: positiveInteger(cfg.maxConcurrency, 1),
    queueTimeoutMs: positiveInteger(cfg.queueTimeoutMs, 30_000),
    maxQueue: positiveInteger(cfg.maxQueue, 10),
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function logProgressDelivery({ event, hasOnUpdate, outboundDelivered }) {
  const stage = typeof event.stage === "string" ? event.stage : "";
  const type = typeof event.type === "string" ? event.type : "";
  console.log(
    `[muad-run-skill] progress skill=${event.skill ?? ""} stage=${stage} type=${type} outbound=${outboundDelivered} hasOnUpdate=${hasOnUpdate}`,
  );
}

function createTool({ config, toolContext, queue }) {
  return {
    name: "muad_run_skill",
    label: "Muad Run Skill",
    description:
      "Run a Muad script skill by name. Use this for skills declaring muad runtime script.",
    parameters: ParamsSchema,
    execute: async (_toolCallId, rawParams, signal, onUpdate) => {
      const params = readToolParams(rawParams);
      const trustedContext = trustedExecutionContext(toolContext);
      const manifest = await loadSkillManifest({
        publicSkillsRoot: config.publicSkillsRoot,
        privateSkillsRoot: path.join(trustedContext.workspaceDir, "skills"),
        skillName: params.skillName,
      });
      const release = await queue.acquire(signal);
      try {
        const result = await runSkill({
          manifest, trustedContext, input: params.input, args: params.args,
          stateDir: path.join(trustedContext.workspaceDir, ".muad-runs"), signal,
          deliver: (event) => deliverProgress({ event, toolContext, signal, onUpdate }),
        });
        return jsonResult({
          summary: result.ok
            ? `${result.skill} completed in ${result.durationMs}ms`
            : `${result.skill} failed at ${result.failedStep}`,
          ...result,
        });
      } finally {
        await release();
      }
    },
  };
}

async function deliverProgress({ event, toolContext, signal, onUpdate }) {
  let outboundDelivered = false;
  try {
    outboundDelivered = await deliverProgressToCurrentConversation({ toolContext, event, signal });
  } catch {
    console.warn("[muad-run-skill] outbound progress delivery failed");
  }
  logProgressDelivery({ event, outboundDelivered, hasOnUpdate: typeof onUpdate === "function" });
  if (!outboundDelivered) onUpdate?.(toToolUpdate(event));
}

export default definePluginEntry({
  id: "muad-run-skill",
  name: "Muad Run Skill",
  description: "Runs Muad script skills and forwards progress through OpenClaw tool updates.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const queue = new SharedSkillQueue({
      limit: config.maxConcurrency,
      waitTimeoutMs: config.queueTimeoutMs,
      maxQueue: config.maxQueue,
    });
    globalThis[Symbol.for("muad.run-skill.queue")] = queue;
    api.registerTool((toolContext) => createTool({ config, toolContext, queue }), {
      name: "muad_run_skill",
    });
  },
});

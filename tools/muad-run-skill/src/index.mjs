import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SharedSkillQueue } from "./concurrency.mjs";
import { trustedExecutionContext } from "./execution-context.mjs";
import { loadSkillManifest } from "./manifest.mjs";
import { runSkill } from "./runner.mjs";
import { readToolParams } from "./tool-params.mjs";
import { toToolUpdate } from "./progress-format.mjs";
import { deliverProgressToCurrentConversation } from "./delivery.mjs";
import {
  manifestSourceForGrant,
  normalizeSkillPolicies,
  resolveSkillGrant,
} from "./skill-policy.mjs";
import { createSkillExecutionReporter, progressSummary } from "./telemetry.mjs";

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
    skillPolicies: normalizeSkillPolicies(cfg.skillPolicies),
    consoleInternalURL: typeof cfg.consoleInternalURL === "string" ? cfg.consoleInternalURL.trim() : "",
    serviceTokenFile: typeof cfg.serviceTokenFile === "string" ? cfg.serviceTokenFile.trim() : "",
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
      const grant = resolveSkillGrant(config.skillPolicies, trustedContext.agentId, params.skillName);
      const manifest = await loadSkillManifest({
        publicSkillsRoot: config.publicSkillsRoot,
        privateSkillsRoot: path.join(trustedContext.workspaceDir, "skills"),
        skillName: params.skillName,
        allowedSource: manifestSourceForGrant(grant.source),
      });
      const startedAt = new Date().toISOString();
      const reporter = createSkillExecutionReporter({
        consoleInternalURL: config.consoleInternalURL,
        serviceTokenFile: config.serviceTokenFile,
        execution: {
          executionId: randomUUID(),
          agentId: trustedContext.agentId,
          skillName: manifest.name,
          skillScope: grant.source,
          skillVersion: manifest.version ?? "",
          startedAt,
        },
      });
      const release = await queue.acquire(signal);
      try {
        void reporter.report({ status: "running" });
        const result = await runSkill({
          manifest, trustedContext, input: params.input, args: params.args,
          stateDir: path.join(trustedContext.workspaceDir, ".muad-runs"), signal,
          deliver: (event) => {
            void reporter.report({ status: "running", progress: progressSummary(event) });
            return deliverProgress({ event, toolContext, signal, onUpdate });
          },
        });
        void reporter.report({
          status: result.ok ? "succeeded" : "failed",
          endedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          ...(result.ok ? {} : { errorCode: "skill_failed", errorMessage: result.failedStep }),
          outputSummary: result.ok ? "completed" : `failed at ${result.failedStep}`,
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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import path from "node:path";
import { createSkillAgentEventSubscription } from "./agent-event-lifecycle.mjs";
import { registerSkillActivationPromptHook, registerUseSkillTool } from "./activation.mjs";
import { SharedSkillQueue } from "./concurrency.mjs";
import { trustedExecutionContext } from "./execution-context.mjs";
import {
  createSkillExecutionSharedState,
  createSkillExecutionHooks,
  redactText,
  SkillExecutionLifecycle,
} from "./hook-lifecycle.mjs";
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
import { createSkillTelemetryClient } from "./telemetry.mjs";
import { prepareTraditionalExecution, runTraditionalSkill } from "./traditional-runner.mjs";
import { registerMandatorySkillToolGate } from "./tool-activation-gate.mjs";

const ParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skill_name"],
  properties: {
    skill_name: { type: "string" },
    input: { type: "string" },
    script_path: { type: "string" },
    args: {
      oneOf: [
        { type: "object", additionalProperties: true },
        { type: "array", items: { type: "string" } },
      ],
    },
  },
};

const SHARED_LIFECYCLE_STATE = Symbol.for("muad.run-skill.lifecycle-state");

function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const telemetry = isObject(cfg.telemetry) ? cfg.telemetry : {};
  const activation = isObject(cfg.activation) ? cfg.activation : {};
  return {
    publicSkillsRoot:
      typeof cfg.skillsRoot === "string" && cfg.skillsRoot.trim()
        ? cfg.skillsRoot.trim()
        : "/opt/openclaw-skills",
    maxConcurrency: positiveInteger(cfg.maxConcurrency, 1),
    queueTimeoutMs: positiveInteger(cfg.queueTimeoutMs, 30_000),
    maxQueue: positiveInteger(cfg.maxQueue, 10),
    skillPolicies: normalizeSkillPolicies(cfg.skillPolicies),
    activation: {
      detectSkillFileReads: activation.detectSkillFileReads !== false,
      requireBeforeExecution: activation.requireBeforeExecution !== false,
      contextTimeoutMs: positiveInteger(activation.contextTimeoutMs, 6 * 60 * 60 * 1_000),
      cleanupIntervalMs: positiveInteger(activation.cleanupIntervalMs, 60_000),
    },
    telemetry: {
      consoleInternalURL: stringValue(telemetry.consoleInternalURL),
      serviceTokenFile: stringValue(telemetry.serviceTokenFile),
      outboxPath: stringValue(telemetry.outboxPath),
      maxQueueItems: positiveInteger(telemetry.maxQueueItems, 256),
      maxOutboxBytes: positiveInteger(telemetry.maxOutboxBytes, 5 * 1024 * 1024),
    },
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

function createTool({ config, toolContext, queue, lifecycle }) {
  return {
    name: "muad_run_skill",
    label: "Muad Run Skill",
    description:
      "Run an enabled managed Skill or an allowlisted traditional Skill script.",
    parameters: ParamsSchema,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      return executeSkill({
        config, toolContext, queue, lifecycle, toolCallId, rawParams, signal, onUpdate,
      });
    },
  };
}

async function executeSkill({
  config, toolContext, queue, lifecycle, toolCallId, rawParams, signal, onUpdate,
}) {
  const params = readToolParams(rawParams);
  const trusted = trustedExecutionContext(toolContext);
  const context = lifecycle.correlateToolContext(trusted, toolCallId);
  const grant = resolveRunnerGrant(config.skillPolicies, lifecycle, context, params);
  const prepared = await prepareSkillRun({ config, lifecycle, context, grant, params });
  let release;
  try {
    release = await queue.acquire(signal);
    return await runPreparedSkill({
      prepared, context, params, lifecycle, toolContext, signal, onUpdate,
    });
  } catch (error) {
    finishRunnerError(lifecycle, context, error, signal);
    throw error;
  } finally {
    if (release) await release();
  }
}

function resolveRunnerGrant(policies, lifecycle, context, params) {
  try {
    return resolveSkillGrant(policies, context.agentId, params.skillName);
  } catch {
    rejectRunner(lifecycle, context, null, params, "skill_not_authorized");
  }
}

async function prepareSkillRun({ config, lifecycle, context, grant, params }) {
  if (params.mode === "traditional") {
    const manifest = await prepareTraditionalExecution({ lifecycle, context, grant, params });
    return { manifest, traditional: true };
  }
  if (grant.entryType !== "managed") {
    rejectRunner(lifecycle, context, grant, params, "skill_not_executable");
  }
  try {
    const manifest = await loadManagedManifest(config, context, grant, params.skillName);
    lifecycle.activate({ context, grant, activationMode: "runner", inputSummary: params.input });
    return { manifest, traditional: false };
  } catch (error) {
    rejectRunner(lifecycle, context, grant, params, "skill_manifest_unavailable", error);
  }
}

function rejectRunner(lifecycle, context, grant, params, code, cause) {
  lifecycle.reject({
    context, grant, skillName: params.skillName, inputSummary: params.input,
    activationMode: "runner", errorCode: code, errorMessage: "Skill execution was rejected",
  });
  const error = new Error("Skill execution was rejected", cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function loadManagedManifest(config, context, grant, skillName) {
  return loadSkillManifest({
    publicSkillsRoot: config.publicSkillsRoot,
    privateSkillsRoot: path.join(context.workspaceDir, "skills"),
    skillName,
    allowedSource: manifestSourceForGrant(grant.source),
  });
}

async function runPreparedSkill({
  prepared, context, params, lifecycle, toolContext, signal, onUpdate,
}) {
  const run = prepared.traditional ? runTraditionalSkill : runSkill;
  const result = await run({
    manifest: prepared.manifest, trustedContext: context, input: params.input,
    args: prepared.traditional ? { argv: params.args } : params.args,
    stateDir: path.join(context.workspaceDir, ".muad-runs"), signal,
    deliver: (event) => {
      lifecycle.recordProgress({ context, event });
      return deliverProgress({ event, toolContext, signal, onUpdate });
    },
  });
  lifecycle.finish({
    context, status: result.ok ? "succeeded" : "failed", terminalReason: "runner",
    durationMs: result.durationMs,
    ...(result.ok ? { outputSummary: "completed" } : {
      errorCode: "skill_failed", errorMessage: redactText(result.failedStep),
      outputSummary: `failed at ${result.failedStep}`,
    }),
  });
  return jsonResult({ summary: skillSummary(result), ...result });
}

function finishRunnerError(lifecycle, context, error, signal) {
  const cancelled = signal?.aborted === true || error?.name === "AbortError";
  lifecycle.finish({
    context, status: cancelled ? "cancelled" : "failed",
    terminalReason: cancelled ? "cancelled" : "runner_error",
    errorCode: cancelled ? "skill_cancelled" : "runner_error",
    errorMessage: redactText(errorMessage(error)),
  });
}

function skillSummary(result) {
  return result.ok
    ? `${result.skill} completed in ${result.durationMs}ms`
    : `${result.skill} failed at ${result.failedStep}`;
}

async function deliverProgress({ event, toolContext, signal, onUpdate }) {
  let outboundDelivered = false;
  try {
    outboundDelivered = await deliverProgressToCurrentConversation({ toolContext, event, signal });
  } catch (error) {
    console.warn(`[muad-run-skill] outbound progress delivery failed: ${redactText(errorMessage(error))}`);
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
    const telemetry = createSkillTelemetryClient({ ...config.telemetry, logger: api.logger ?? console });
    const lifecycle = createLifecycle(config, telemetry, api.logger ?? console);
    const queue = new SharedSkillQueue({
      limit: config.maxConcurrency,
      waitTimeoutMs: config.queueTimeoutMs,
      maxQueue: config.maxQueue,
    });
    globalThis[Symbol.for("muad.run-skill.queue")] = queue;
    globalThis[Symbol.for("muad.run-skill.lifecycle")] = lifecycle;
    globalThis[Symbol.for("muad.run-skill.telemetry")] = telemetry;
    registerUseSkillTool(api, {
      lifecycle, policies: config.skillPolicies, formatResult: jsonResult,
    });
    api.registerTool((toolContext) => createTool({ config, toolContext, queue, lifecycle }), {
      name: "muad_run_skill",
    });
    registerLifecycleHooks(api, config, lifecycle, telemetry);
  },
});

function createLifecycle(config, telemetry, logger) {
  return new SkillExecutionLifecycle({
    logger,
    sharedState: getSharedLifecycleState(),
    contextTimeoutMs: config.activation.contextTimeoutMs,
    cleanupIntervalMs: config.activation.cleanupIntervalMs,
    reporterFactory: ({ execution }) => telemetry.createReporter({ execution }),
  });
}

function getSharedLifecycleState() {
  const current = globalThis[SHARED_LIFECYCLE_STATE];
  if (current?.active instanceof Map && current?.toolContexts instanceof Map) return current;
  const created = createSkillExecutionSharedState();
  globalThis[SHARED_LIFECYCLE_STATE] = created;
  return created;
}

function registerLifecycleHooks(api, config, lifecycle, telemetry) {
  if (config.activation.requireBeforeExecution) {
    registerSkillActivationPromptHook(api, config.skillPolicies);
  }
  api.agent.events.registerAgentEventSubscription(createSkillAgentEventSubscription({
    lifecycle, flush: () => telemetry.flush(), logger: api.logger ?? console,
  }));
  registerMandatorySkillToolGate(api, {
    lifecycle, policies: config.skillPolicies, logger: api.logger ?? console,
  });
  const hooks = createSkillExecutionHooks({
    lifecycle, policies: config.skillPolicies, logger: api.logger ?? console,
    detectSkillFileReads: config.activation.detectSkillFileReads,
  });
  api.on("before_tool_call", hooks.before, { priority: 500, timeoutMs: 1_000 });
  api.on("after_tool_call", hooks.after, { priority: 500, timeoutMs: 1_000 });
  api.on("agent_end", hooks.agentEnd, { priority: 500, timeoutMs: 1_000 });
  api.on("gateway_stop", async () => {
    lifecycle.close();
    await telemetry.close();
  }, { priority: 500, timeoutMs: 5_000 });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

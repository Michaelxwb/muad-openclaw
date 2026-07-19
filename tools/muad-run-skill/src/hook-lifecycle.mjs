import { randomUUID as defaultRandomUUID } from "node:crypto";

import { trustedRunContext } from "./execution-context.mjs";
import { findSkillGrantByPath } from "./skill-policy.mjs";

const IGNORED_TOOLS = new Set(["muad_use_skill", "muad_run_skill"]);
const CORRELATED_TOOLS = new Set(["muad_use_skill", "muad_run_skill"]);
const MAX_PROGRESS_ITEMS = 20;
const DEFAULT_CONTEXT_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export class SkillExecutionLifecycle {
  constructor({
    reporterFactory,
    sharedState,
    randomUUID = defaultRandomUUID,
    now = () => new Date(),
    logger = console,
    contextTimeoutMs = DEFAULT_CONTEXT_TIMEOUT_MS,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
  }) {
    if (typeof reporterFactory !== "function") throw new TypeError("reporterFactory is required");
    this.reporterFactory = reporterFactory;
    this.randomUUID = randomUUID;
    this.now = now;
    this.logger = logger;
    this.contextTimeoutMs = positiveInteger(contextTimeoutMs, DEFAULT_CONTEXT_TIMEOUT_MS);
    const state = resolveSharedState(sharedState);
    this.active = state.active;
    this.toolContexts = state.toolContexts;
    this.warnedFallbackKeys = new Set();
    this.cleanupTimer = setInterval(
      () => this.sweepExpired(),
      positiveInteger(cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS),
    );
    this.cleanupTimer.unref?.();
  }

  activate({ context, grant, activationMode, inputSummary = "" }) {
    const key = this.keyFor(context);
    const current = this.active.get(key);
    if (current?.grant.name === grant.name) return executionView(current);
    if (current) this.finishState(current, "succeeded", "handoff", {});
    const state = this.createState({ key, context, grant, activationMode, inputSummary });
    this.active.set(key, state);
    this.dispatch(state, { status: "running", eventSeq: state.eventSeq });
    return executionView(state);
  }

  reject({ context, grant = null, skillName, inputSummary = "", errorCode, errorMessage,
    activationMode = "tool" }) {
    const now = this.now();
    const execution = {
      executionId: this.randomUUID(), agentId: context.agentId, skillName,
      skillScope: grant?.source ?? "public", skillVersion: grant?.version ?? "",
      entryType: grant?.entryType ?? "traditional-prompt",
      activationMode, startedAt: now.toISOString(), inputSummary: redactText(inputSummary),
    };
    const reporter = this.createReporter(execution);
    this.dispatchReporter(reporter, execution.executionId, {
      status: "rejected", eventSeq: 1, endedAt: now.toISOString(), durationMs: 0,
      terminalReason: "rejected", errorCode, errorMessage: redactText(errorMessage),
    });
    return { executionId: execution.executionId };
  }

  activateFromPaths({ context, derivedPaths, policies }) {
    if (this.getActive(context)) return null;
    const grant = findSkillGrantByPath(policies, context.agentId, derivedPaths);
    if (!grant) return null;
    return this.activate({ context, grant, activationMode: "path-detected" });
  }

  beforeTool({ context, toolName, toolCallId = "" }) {
    if (ignoredTool(toolName)) return;
    const state = this.getActive(context);
    if (!state || !this.acceptToolEvent(state, toolCallId, "start")) return;
    this.touch(state);
    this.appendProgress(state, "tool-start", toolName, "started");
    this.dispatchRunning(state, toolName);
  }

  afterTool({ context, toolName, toolCallId = "", durationMs = 0, error = "" }) {
    if (ignoredTool(toolName)) return;
    const state = this.getActive(context);
    if (!state || !this.acceptToolEvent(state, toolCallId, "result")) return;
    this.touch(state);
    if (error) {
      this.appendProgress(state, "tool-failed", toolName, redactText(error));
      this.dispatchRunning(state, toolName);
      return;
    }
    this.appendProgress(state, "tool-complete", toolName, `${positiveDuration(durationMs)}ms`);
    this.dispatchRunning(state, toolName);
  }

  agentEnd({ context, success, error = "" }) {
    const state = this.getActive(context);
    if (!state) return;
    this.finishState(state, success ? "succeeded" : "failed", "agent_end", {
      ...(success ? { outputSummary: "completed" } : {
        errorCode: "agent_failed", errorMessage: redactText(error),
      }),
    });
  }

  recordProgress({ context, event, toolName = "muad_run_skill" }) {
    const state = this.getActive(context);
    if (!state) return;
    this.touch(state);
    this.appendProgress(state, event?.type ?? "progress", event?.stage ?? "", event?.text ?? "");
    this.dispatchRunning(state, toolName);
  }

  finish({ context, status, terminalReason, ...details }) {
    const state = this.getActive(context);
    if (state) this.finishState(state, status, terminalReason, details);
  }

  getActive(context) {
    const exact = this.active.get(this.keyFor(context));
    if (exact || !context.runId) return exact ?? null;
    return this.promoteFallbackContext(context);
  }

  promoteFallbackContext(context) {
    const state = this.active.get(`fallback:${context.agentId}:${context.sessionKey}`);
    if (!state || state.context.runId || !sameConversation(state.context, context)) return null;
    this.active.delete(state.key);
    state.key = `run:${context.runId}`;
    state.context = { ...state.context, runId: context.runId };
    this.active.set(state.key, state);
    this.logger.info?.(`[muad-run-skill] ${JSON.stringify({
      event: "fallback_context_promoted", agentId: context.agentId,
    })}`);
    return state;
  }

  captureToolContext({ context, toolCallId, toolName }) {
    const id = String(toolCallId ?? "").trim();
    if (!id || !context.runId || !CORRELATED_TOOLS.has(String(toolName ?? ""))) return;
    this.toolContexts.set(id, capturedToolContext(context, this.now().getTime()));
  }

  captureAgentEventTool({ runId, toolCallId, toolName }) {
    const id = String(toolCallId ?? "").trim();
    const trustedRunId = String(runId ?? "").trim();
    if (!id || !trustedRunId || !CORRELATED_TOOLS.has(String(toolName ?? ""))) return;
    this.toolContexts.set(id, {
      runId: trustedRunId,
      capturedAtMs: this.now().getTime(),
    });
  }

  correlateToolContext(context, toolCallId) {
    const id = String(toolCallId ?? "").trim();
    const captured = id ? this.toolContexts.get(id) : null;
    if (id) this.toolContexts.delete(id);
    if (!captured) return context;
    if (!capturedContextMatches(captured, context)) {
      this.logger.warn?.(`[muad-run-skill] ${JSON.stringify({
        event: "tool_context_mismatch", toolCallId: id, agentId: context.agentId,
      })}`);
      return context;
    }
    return { ...context, runId: captured.runId };
  }

  releaseToolContext(toolCallId) {
    const id = String(toolCallId ?? "").trim();
    if (id) this.toolContexts.delete(id);
  }

  sweepExpired() {
    const nowMs = this.now().getTime();
    let expired = 0;
    for (const state of this.active.values()) {
      if (nowMs - state.lastActivityMs <= this.contextTimeoutMs) continue;
      expired += 1;
      this.finishState(state, "cancelled", "timeout", {
        errorCode: "execution_timeout",
        errorMessage: "Skill execution timed out before agent completion",
      });
    }
    for (const [toolCallId, captured] of this.toolContexts) {
      if (nowMs - captured.capturedAtMs > this.contextTimeoutMs) this.toolContexts.delete(toolCallId);
    }
    return expired;
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.toolContexts.clear();
    for (const state of [...this.active.values()]) {
      this.finishState(state, "cancelled", "gateway_stop", {
        errorCode: "gateway_stopped",
        errorMessage: "Gateway stopped before agent completion",
      });
    }
  }

  createState({ key, context, grant, activationMode, inputSummary }) {
    const started = this.now();
    const execution = {
      executionId: this.randomUUID(), agentId: context.agentId, skillName: grant.name,
      skillScope: grant.source, skillVersion: grant.version, entryType: grant.entryType,
      activationMode, startedAt: started.toISOString(), inputSummary: redactText(inputSummary),
    };
    return {
      key, context, grant, execution, reporter: this.createReporter(execution),
      eventSeq: 1, startedMs: started.getTime(), lastActivityMs: started.getTime(),
      progress: [], toolEventKeys: new Set(), lastToolName: "", terminal: false,
    };
  }

  acceptToolEvent(state, toolCallId, phase) {
    const id = String(toolCallId ?? "").trim();
    if (!id) return true;
    const key = `${id}:${phase}`;
    if (state.toolEventKeys.has(key)) return false;
    state.toolEventKeys.add(key);
    if (state.toolEventKeys.size > 1_024) {
      state.toolEventKeys.delete(state.toolEventKeys.values().next().value);
    }
    return true;
  }

  touch(state) {
    state.lastActivityMs = this.now().getTime();
  }

  finishState(state, status, terminalReason, details) {
    if (state.terminal) return;
    state.terminal = true;
    state.eventSeq += 1;
    const ended = this.now();
    const safeDetails = safeTerminalDetails(details);
    const lastToolName = safeDetails.lastToolName || state.lastToolName;
    if (this.active.get(state.key) === state) this.active.delete(state.key);
    this.dispatch(state, {
      status, eventSeq: state.eventSeq, endedAt: ended.toISOString(),
      durationMs: Math.max(0, ended.getTime() - state.startedMs),
      progress: state.progress, terminalReason,
      ...(lastToolName ? { lastToolName } : {}), ...safeDetails,
    });
  }

  dispatchRunning(state, lastToolName) {
    state.lastToolName = trimText(lastToolName, 80);
    state.eventSeq += 1;
    this.dispatch(state, {
      status: "running", eventSeq: state.eventSeq, progress: state.progress,
      lastToolName: state.lastToolName,
    });
  }

  appendProgress(state, type, stage, text) {
    state.progress.push({
      type: trimText(type, 32), stage: trimText(stage, 80),
      text: trimText(redactText(text), 256), ts: this.now().toISOString(),
    });
    if (state.progress.length > MAX_PROGRESS_ITEMS) state.progress.shift();
  }

  keyFor(context) {
    if (context.runId) return `run:${context.runId}`;
    const key = `fallback:${context.agentId}:${context.sessionKey}`;
    if (!this.warnedFallbackKeys.has(key)) {
      this.warnedFallbackKeys.add(key);
      this.logger.warn?.(`[muad-run-skill] ${JSON.stringify({
        event: "missing_run_id", agentId: context.agentId,
      })}`);
    }
    return key;
  }

  createReporter(execution) {
    try {
      return this.reporterFactory({ execution });
    } catch (error) {
      this.logReportError(execution.executionId, error);
      return { report: () => false };
    }
  }

  dispatch(state, update) {
    this.dispatchReporter(state.reporter, state.execution.executionId, update);
  }

  dispatchReporter(reporter, executionId, update) {
    try {
      const pending = reporter.report(update);
      pending?.catch?.((error) => this.logReportError(executionId, error));
    } catch (error) {
      this.logReportError(executionId, error);
    }
  }

  logReportError(executionId, error) {
    this.logger.error?.(`[muad-run-skill] ${JSON.stringify({
      event: "telemetry_report_failed", executionId, error: redactText(errorMessage(error)),
    })}`);
  }
}

export function createSkillExecutionSharedState() {
  return { active: new Map(), toolContexts: new Map() };
}

export function createSkillExecutionHooks({
  lifecycle, policies, logger = console, detectSkillFileReads = true,
}) {
  return {
    before(event, hookContext) {
      withHookContext(event, hookContext, logger, (context) => {
        lifecycle.captureToolContext({
          context, toolCallId: event.toolCallId, toolName: event.toolName,
        });
        if (detectSkillFileReads) {
          lifecycle.activateFromPaths({ context, derivedPaths: activationPaths(event), policies });
        }
        lifecycle.beforeTool({
          context, toolName: event.toolName, toolCallId: event.toolCallId,
        });
      });
    },
    after(event, hookContext) {
      withHookContext(event, hookContext, logger, (context) => {
        lifecycle.afterTool({
          context, toolName: event.toolName, toolCallId: event.toolCallId,
          durationMs: event.durationMs, error: event.error,
        });
        lifecycle.releaseToolContext(event.toolCallId);
      });
    },
    agentEnd(event, hookContext) {
      withHookContext(event, hookContext, logger, (context) => lifecycle.agentEnd({
        context, success: event.success, error: event.error,
      }));
    },
  };
}

function activationPaths(event) {
  const paths = Array.isArray(event.derivedPaths) ? [...event.derivedPaths] : [];
  const readPath = event.toolName === "read" && typeof event.params?.path === "string"
    ? event.params.path.trim() : "";
  if (readPath) paths.push(readPath);
  return paths;
}

export function redactText(value) {
  let output = errorMessage(value);
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
  return output.replace(
    /\b(api[_-]?key|token|cookie|authorization|secret|password)\s*[:=]\s*[^\s,;]+/giu,
    "$1=[REDACTED]",
  );
}

function withHookContext(event, hookContext, logger, callback) {
  try {
    callback(trustedRunContext(event, hookContext));
  } catch (error) {
    logger.warn?.(`[muad-run-skill] ${JSON.stringify({
      event: "invalid_hook_context", error: errorMessage(error),
    })}`);
  }
}

function executionView(state) {
  return { executionId: state.execution.executionId, skillName: state.grant.name };
}

function ignoredTool(toolName) {
  return IGNORED_TOOLS.has(String(toolName ?? ""));
}

function positiveDuration(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveSharedState(value) {
  if (value === undefined) return createSkillExecutionSharedState();
  if (!(value?.active instanceof Map) || !(value?.toolContexts instanceof Map)) {
    throw new TypeError("invalid shared Skill execution state");
  }
  return value;
}

function sameConversation(left, right) {
  return left.agentId === right.agentId && left.sessionKey === right.sessionKey;
}

function capturedToolContext(context, capturedAtMs) {
  return {
    runId: context.runId,
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    capturedAtMs,
  };
}

function capturedContextMatches(captured, context) {
  if (captured.agentId && captured.agentId !== context.agentId) return false;
  return !captured.sessionKey || captured.sessionKey === context.sessionKey;
}

function trimText(value, limit) {
  return [...String(value ?? "").trim()].slice(0, limit).join("");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function safeTerminalDetails(details) {
  return {
    ...details,
    ...(details.errorMessage === undefined ? {} : { errorMessage: redactText(details.errorMessage) }),
    ...(details.outputSummary === undefined ? {} : { outputSummary: redactText(details.outputSummary) }),
  };
}

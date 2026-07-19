const TERMINAL_PHASES = new Set(["end", "error", "abort"]);

export function createSkillAgentEventSubscription({ lifecycle, flush = async () => {}, logger = console }) {
  return {
    id: "skill-execution-lifecycle",
    description: "Correlates Skill executions with sanitized Agent lifecycle events.",
    streams: ["tool", "lifecycle"],
    async handle(event) {
      try {
        handleAgentEvent(lifecycle, event);
        if (isTerminalEvent(event)) await flush();
      } catch (error) {
        logger.warn?.(`[muad-run-skill] ${JSON.stringify({
          event: "invalid_agent_event", error: errorMessage(error),
        })}`);
      }
    },
  };
}

function isTerminalEvent(event) {
  return event.stream === "lifecycle" && TERMINAL_PHASES.has(stringValue(event.data?.phase));
}

function handleAgentEvent(lifecycle, event) {
  const context = agentEventContext(event);
  if (event.stream === "tool") {
    handleToolEvent(lifecycle, context, event.data);
    return;
  }
  if (event.stream === "lifecycle") handleLifecycleEvent(lifecycle, context, event.data);
}

function handleToolEvent(lifecycle, context, data = {}) {
  const phase = stringValue(data.phase);
  const toolName = stringValue(data.name ?? data.toolName);
  const toolCallId = stringValue(data.toolCallId);
  if (!toolName) return;
  if (phase === "start") {
    lifecycle.captureAgentEventTool({ runId: context.runId, toolCallId, toolName });
    lifecycle.beforeTool({ context, toolName, toolCallId });
    return;
  }
  if (phase !== "result" && phase !== "end") return;
  lifecycle.afterTool({
    context, toolName, toolCallId, durationMs: numericValue(data.durationMs),
    error: toolError(data),
  });
  lifecycle.releaseToolContext(toolCallId);
}

function handleLifecycleEvent(lifecycle, context, data = {}) {
  const phase = stringValue(data.phase);
  if (!TERMINAL_PHASES.has(phase)) return;
  const error = stringValue(data.error ?? data.errorMessage);
  if (phase === "abort" || data.aborted === true) {
    lifecycle.finish({
      context, status: "cancelled", terminalReason: "agent_end",
      errorCode: "agent_cancelled", errorMessage: error,
    });
    return;
  }
  lifecycle.agentEnd({ context, success: phase === "end", error });
}

function toolError(data) {
  if (data.isError !== true && !data.error && !data.toolErrorSummary) return "";
  return stringValue(data.error ?? data.toolErrorSummary ?? "tool failed");
}

function numericValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function agentEventContext(event) {
  const runId = stringValue(event?.runId);
  if (!runId) throw new TypeError("trusted Agent Event runId is unavailable");
  return { runId };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

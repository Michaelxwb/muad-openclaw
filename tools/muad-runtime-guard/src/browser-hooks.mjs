import { BrowserBusyError } from "./browser-lease.mjs";
import { validateBrowserRequest } from "./tool-policies.mjs";

export function createBrowserLeaseHooks({ config, leaseManager, log = () => {} }) {
  const diag = (message) => log(`[browser-lease] ${message}`);
  return {
    before: async (event, ctx) => {
      if (event.toolName !== "browser") return undefined;
      const validation = validateBrowserRequest(event, ctx, config);
      if (!validation.ok) return block(validation.reason);
      const key = browserCallKey(event, ctx);
      if (!key) return block("browser tool call identity is unavailable");
      const action = typeof event.params.action === "string" ? event.params.action : "unknown";
      try {
        await leaseManager.acquire(key, { agentId: ctx.agentId, action });
        diag(`acquired agent=${ctx.agentId || "unknown"} action=${action}`);
        return undefined;
      } catch (error) {
        diag(`blocked agent=${ctx.agentId || "unknown"} action=${action} reason=${error instanceof BrowserBusyError ? "browser_busy" : "guard_failed"}`);
        return block(error instanceof BrowserBusyError
          ? "browser_busy: browser concurrency limit reached"
          : "browser concurrency guard failed");
      }
    },
    after: async (event, ctx) => {
      if (event.toolName !== "browser") return;
      const key = browserCallKey(event, ctx);
      if (key) {
        await leaseManager.release(key);
        diag(`released agent=${ctx.agentId || "unknown"}`);
      }
    },
  };
}

export function browserCallKey(event, ctx) {
  const agentId = textValue(ctx.agentId);
  const toolCallId = textValue(event.toolCallId) || textValue(ctx.toolCallId);
  if (!agentId || !toolCallId) return "";
  const runId = textValue(event.runId) || textValue(ctx.runId);
  return JSON.stringify([agentId, runId, textValue(ctx.sessionKey), toolCallId]);
}

function block(blockReason) {
  return { block: true, blockReason };
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

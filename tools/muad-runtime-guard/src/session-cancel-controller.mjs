import process from "node:process";

// 会话 run 取消适配器（依 OpenClaw 2026.7.1 公开契约）：按可信 sessionKey 解析
// 当前活跃 embedded run，再调用 abort/drain。aborted 只代表调到可取消句柄，
// drained 才代表原生清理完成；两者都不代表进程已退出。禁止 forceClear。

export const SESSION_CANCEL_LOG = "[muad-runtime-guard][session-cancel]";

const DEFAULT_SETTLE_MS = 2_000;
const DRAIN_GRACE_MS = 500;

export function createSessionCancelController({
  native,
  log = () => {},
  settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  const resolveSession = typeof native?.resolveActiveEmbeddedRunSessionId === "function"
    ? native.resolveActiveEmbeddedRunSessionId
    : null;
  const abortAndDrain = typeof native?.abortAndDrainAgentHarnessRun === "function"
    ? native.abortAndDrainAgentHarnessRun
    : null;

  async function activeRun(sessionKey) {
    if (!resolveSession) {
      return { available: false, activeRun: { active: false }, reason: "native_unavailable" };
    }
    let resolved;
    try {
      resolved = await withDeadline(Promise.resolve(resolveSession(sessionKey)), settleMs);
    } catch (error) {
      return {
        available: true,
        activeRun: { active: false },
        reason: error?.deadline === true ? "native_timeout" : "native_error",
      };
    }
    const sessionId = typeof resolved === "string" ? resolved.trim() : "";
    return {
      available: true,
      activeRun: sessionId ? { active: true, sessionId } : { active: false },
      reason: "",
    };
  }

  async function abort(sessionKey) {
    const current = await activeRun(sessionKey);
    if (!current.available) {
      return { aborted: false, drained: false, confirmed: false, sessionId: "", reason: current.reason };
    }
    if (!current.activeRun.active) {
      return { aborted: false, drained: false, confirmed: false, sessionId: "", reason: "run_not_active" };
    }
    if (!abortAndDrain) {
      return { aborted: false, drained: false, confirmed: false, sessionId: "", reason: "native_unavailable" };
    }
    const sessionId = current.activeRun.sessionId;
    let drain = null;
    try {
      drain = await withDeadline(Promise.resolve(abortAndDrain({
        sessionId,
        sessionKey,
        settleMs,
        forceClear: false,
      })), settleMs + DRAIN_GRACE_MS);
    } catch (error) {
      return {
        aborted: false,
        drained: false,
        confirmed: false,
        sessionId,
        reason: error?.deadline === true ? "native_timeout" : "native_error",
      };
    }
    const aborted = drain?.aborted === true;
    const drained = drain?.drained === true;
    const forced = drain?.forceCleared === true;
    const reason = forced ? "force_clear_not_stop" : (drained ? "" : "drain_timeout");
    log(
      `${SESSION_CANCEL_LOG} abort session_id=${sessionId}` +
        ` aborted=${aborted} drained=${drained} force_cleared=${forced}`,
    );
    return { aborted, drained, confirmed: drained && !forced, sessionId, reason };
  }

  return { activeRun, abort };
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`bounded call exceeded ${ms}ms`);
      error.deadline = true;
      reject(error);
    }, Math.max(1, ms));
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

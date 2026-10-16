import process from "node:process";

// 长任务运行取消适配器（依 TASK-001/OpenClaw 2026.7.1 契约）：
// - 运行身份 = taskId + 后台 sessionKey（agent:<agentId>:longtask:<taskId>）+ 本 Worker 实例；
//   真实运行 id 只在取消时由公开注册表按可信 sessionKey 解析，调用方不得自带。
// - abortAndDrainAgentHarnessRun 的 aborted=true 只代表调到了可取消句柄；drained=true
//   才代表原生清理完成；两者都不等于本 Worker 归属进程已退出，必须等待真实进程退出。
// - 禁止 forceClear:true（强制清注册表不证明停止）；只对本 Worker 以 detached 方式创建
//   并持有的进程组补发终止，且 signalProcessTree 只是 best-effort，退出仍以真实事件为准。

const SESSION_KEY_PATTERN = /^agent:([^:]+):longtask:([^:]+)$/u;
const DRAIN_GRACE_MS = 500;

export function longTaskSessionKey({ agentId, taskId } = {}) {
  return `agent:${text(agentId)}:longtask:${text(taskId)}`;
}

export function parseLongTaskSessionKey(sessionKey) {
  const match = SESSION_KEY_PATTERN.exec(text(sessionKey));
  return match ? { agentId: match[1], taskId: match[2] } : null;
}

export function createLongTaskRunController({
  native,
  workerId,
  log = () => {},
  settleMs = 2_000,
  exitGraceMs = 5_000,
  now = () => Date.now(),
} = {}) {
  const bindings = new Map();
  const resolveSession = typeof native?.resolveActiveEmbeddedRunSessionId === "function"
    ? native.resolveActiveEmbeddedRunSessionId
    : () => undefined;
  const abortAndDrain = typeof native?.abortAndDrainAgentHarnessRun === "function"
    ? native.abortAndDrainAgentHarnessRun
    : null;
  const signalProcessTree = typeof native?.signalProcessTree === "function"
    ? native.signalProcessTree
    : signalOwnedProcessGroup;

  function bind(task, { child, detached = false } = {}) {
    const taskId = text(task?.taskId);
    const agentId = text(task?.agentId);
    if (!taskId || !agentId) throw new Error("long task run binding requires taskId and agentId");
    const expected = longTaskSessionKey({ agentId, taskId });
    const sessionKey = text(task?.sessionKey) || expected;
    if (sessionKey !== expected) {
      throw new Error(`long task run sessionKey does not match task identity: ${sessionKey}`);
    }
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      throw new Error("long task run binding requires an owned child process");
    }
    const binding = {
      taskId,
      agentId,
      sessionKey,
      workerId: text(workerId),
      childPid: child.pid,
      detached: detached === true,
      child,
      boundAt: now(),
    };
    bindings.set(taskId, binding);
    return binding;
  }

  function release(bindingOrTaskId) {
    const taskId = typeof bindingOrTaskId === "string" ? bindingOrTaskId : bindingOrTaskId?.taskId;
    if (taskId) bindings.delete(text(taskId));
  }

  function lookup(taskId) {
    return bindings.get(text(taskId)) ?? null;
  }

  async function cancel(binding) {
    const current = binding?.taskId ? bindings.get(text(binding.taskId)) : null;
    if (!current || current !== binding || current.workerId !== text(workerId)) {
      log(`[muad-runtime-guard][longtask-cancel] refused unknown run taskId=${text(binding?.taskId) || "unknown"}`);
      return finish({ accepted: false, reason: "unknown_run" });
    }
    let sessionId = "";
    try {
      sessionId = text(await withDeadline(Promise.resolve(resolveSession(current.sessionKey)), settleMs));
    } catch (error) {
      return finish({ accepted: false, reason: error?.deadline === true ? "native_timeout" : "native_error" });
    }
    if (!sessionId) return finish({ accepted: false, reason: "run_not_active" });
    if (!abortAndDrain) return finish({ accepted: false, reason: "native_unavailable", sessionId });
    let drain = null;
    try {
      drain = await withDeadline(Promise.resolve(abortAndDrain({
        sessionId,
        sessionKey: current.sessionKey,
        settleMs,
        forceClear: false,
      })), settleMs + DRAIN_GRACE_MS);
    } catch {
      drain = null;
    }
    const accepted = drain?.aborted === true;
    const drained = drain?.drained === true;
    const forced = drain?.forceCleared === true;
    let exited = processExited(current.child);
    if ((drained || accepted) && !exited) {
      exited = await waitForExit(current.child, exitGraceMs);
    }
    if (drained && !forced && !exited) {
      // 原生清理已完成但本 Worker 持有的进程组仍在：只对本组补发终止，并继续等待真实退出。
      try {
        signalProcessTree(current.childPid, "SIGKILL", { detached: current.detached });
      } catch (error) {
        log(`[muad-runtime-guard][longtask-cancel] signal failed taskId=${current.taskId} reason=${errorText(error)}`);
      }
      exited = await waitForExit(current.child, exitGraceMs);
    }
    if (!drained || forced) {
      return finish({
        accepted,
        confirmed: false,
        reason: forced ? "force_clear_not_stop" : "drain_timeout",
        sessionId,
        processExited: exited,
      });
    }
    if (!exited) {
      return finish({ accepted, confirmed: false, reason: "process_exit_unconfirmed", sessionId, processExited: false });
    }
    return finish({ accepted: true, confirmed: true, reason: "", sessionId, processExited: true });
  }

  return { workerId: text(workerId), bind, release, lookup, cancel };
}

function finish({ accepted, reason, sessionId = "", confirmed = false, processExited = false }) {
  return { accepted, confirmed, reason, sessionId, processExited };
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

function processExited(child) {
  if (!child) return true;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  return child.signalCode !== null && child.signalCode !== undefined;
}

function waitForExit(child, timeoutMs) {
  if (processExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(processExited(child)), Math.max(1, timeoutMs));
    const onExit = () => done(true);
    child.once?.("exit", onExit);
    child.once?.("close", onExit);
  });
}

// 仅指向本 Worker 以 detached 创建的进程组；非 detached 只信号该进程本身。
function signalOwnedProcessGroup(pid, signal, options = {}) {
  process.kill(options?.detached === true ? -pid : pid, signal);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error) {
  return String(error?.message || error).slice(0, 200);
}

import { randomUUID } from "node:crypto";

// 内部取消 RPC（仅控制面）：operator.write 作用域，绝不注册为模型工具或进入业务
// allowlist；能力只在取消链完整（manager 可取消 + 原生 abort/drain 运行环境可用）
// 时上报。原生运行环境以公开 SDK 入口动态加载，缺失时明确不可用、不危险兜底。

export const LONG_TASK_CANCEL_METHOD = "muad.long-task.cancel";
export const LONG_TASK_CANCEL_SCOPE = "operator.write";
export const LONG_TASK_CANCEL_CAPABILITY_VERSION = 1;
export const LONG_TASK_CANCEL_LOG = "[muad-runtime-guard][longtask-cancel]";

const CAPABILITY_SYMBOL = Symbol.for("muad.longtask.cancel");
const WORKER_SYMBOL = Symbol.for("muad.longtask.worker-instance");
const MAX_ID_LENGTH = 128;

export function cancelCapabilityOf(globals = globalThis) {
  return globals[CAPABILITY_SYMBOL];
}

export function installCancelCapability(globals, capability) {
  const current = globals[CAPABILITY_SYMBOL];
  if (current && typeof current === "object") {
    Object.assign(current, capability);
    return current;
  }
  const holder = { available: false, version: 0, reason: "", ...capability };
  globals[CAPABILITY_SYMBOL] = holder;
  return holder;
}

export function newWorkerInstanceId(globals = globalThis) {
  if (typeof globals[WORKER_SYMBOL] !== "string") {
    globals[WORKER_SYMBOL] = `worker-${randomUUID()}`;
  }
  return globals[WORKER_SYMBOL];
}

// 公开 SDK 契约（2026.7.1）：agent-harness-runtime 提供 abort/drain 注册表，
// agent-core 提供进程树信号。只有必需导出齐备才报告可用。
export async function loadNativeCancelRuntime({ importer = (specifier) => import(specifier) } = {}) {
  let runtime;
  let core;
  try {
    runtime = await importer("openclaw/plugin-sdk/agent-harness-runtime");
    core = await importer("openclaw/plugin-sdk/agent-core");
  } catch {
    return { available: false, reason: "sdk_unavailable" };
  }
  if (typeof runtime?.resolveActiveEmbeddedRunSessionId !== "function" ||
      typeof runtime?.abortAndDrainAgentHarnessRun !== "function") {
    return { available: false, reason: "native_unavailable" };
  }
  return {
    available: true,
    native: {
      resolveActiveEmbeddedRunSessionId: runtime.resolveActiveEmbeddedRunSessionId,
      abortAndDrainAgentHarnessRun: runtime.abortAndDrainAgentHarnessRun,
      ...(typeof core?.signalProcessTree === "function" ? { signalProcessTree: core.signalProcessTree } : {}),
    },
  };
}

// 仅接受 {taskId, requestedBy} 两个有界字符串；模型自由输入、额外字段、超长或含
// 控制字符的身份一律拒绝。
export function validateCancelRequest(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "invalid_request" };
  }
  const keys = Object.keys(params);
  if (keys.length !== 2 || !keys.includes("taskId") || !keys.includes("requestedBy")) {
    return { ok: false, reason: "invalid_request" };
  }
  const taskId = boundedId(params.taskId);
  const requestedBy = boundedId(params.requestedBy);
  if (!taskId || !requestedBy) return { ok: false, reason: "invalid_request" };
  return { ok: true, request: { taskId, requestedBy } };
}

export function createLongTaskCancelHandler({ manager, capability, log = () => {} } = {}) {
  const capabilityHolder = capability ?? {};
  return async (request = {}) => {
    // gateway 传输层传入的是 {params: {...}} 包装（与 route-verifier 一致）；
    // 直接调用（测试/内部）仍支持扁平参数。
    const validated = validateCancelRequest(request?.params ?? request);
    if (!validated.ok) {
      logStable(log, "request rejected reason=invalid_request");
      return { ok: false, reason: "invalid_request" };
    }
    const { taskId, requestedBy } = validated.request;
    if (capabilityHolder.available !== true || typeof manager?.cancelTask !== "function") {
      logStable(log, `request rejected taskId=${taskId} reason=cancel_unavailable`);
      return { ok: false, reason: "cancel_unavailable" };
    }
    let result;
    try {
      result = await manager.cancelTask(taskId, { requestedBy });
    } catch {
      logStable(log, `request failed taskId=${taskId} reason=handler_error`);
      return { ok: false, reason: "handler_error" };
    }
    if (result?.ok === true) {
      logStable(log, `request accepted taskId=${taskId} outcome=${result.outcome} status=${result.status} revision=${result.stateRevision ?? 0}`);
      return {
        ok: true,
        outcome: result.outcome,
        status: result.status,
        stateRevision: Number.isInteger(result.stateRevision) ? result.stateRevision : 0,
        ...(result.repeated === true ? { repeated: true } : {}),
      };
    }
    logStable(log, `request rejected taskId=${taskId} reason=${result?.reason ?? "unknown"}`);
    return {
      ok: false,
      reason: result?.reason ?? "unknown",
      ...(typeof result?.status === "string" && result.status ? { status: result.status } : {}),
      ...(Number.isInteger(result?.stateRevision) ? { stateRevision: result.stateRevision } : {}),
    };
  };
}

function boundedId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(trimmed)) return "";
  return trimmed;
}

// 日志仅含 taskId、outcome/status 与稳定原因；不记录 requestedBy、请求原文或凭证。
function logStable(log, detail) {
  try {
    log(`${LONG_TASK_CANCEL_LOG} ${detail}`);
  } catch {
    // Logging is best-effort and must never alter the cancel outcome.
  }
}

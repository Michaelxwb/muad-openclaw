import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// 长任务取消状态边界：状态词汇、单调 revision、取消请求/确认记录与 0600 JSONL 持久化。
// manager 在每个状态变化点先用这里的函数生成记录（接受取消前必须可靠写入），
// 重启恢复只把 queued/running 升级为 failed；cancelling 作为取消墓碑保留，
// 既不重新执行也不猜测停止（归属与真实停止由后续对账确认）。

export const TASK_STATUSES = Object.freeze([
  "queued", "running", "cancelling", "cancelled", "succeeded", "failed",
]);
export const TERMINAL_STATUSES = Object.freeze(["cancelled", "succeeded", "failed"]);
export const ACTIVE_STATUSES = Object.freeze(["queued", "running", "cancelling"]);
export const MANUAL_CANCEL_REASON = "manual_cancel";

const TERMINAL_SET = new Set(TERMINAL_STATUSES);
const ACTIVE_SET = new Set(ACTIVE_STATUSES);
const CANCELLABLE_SET = new Set(["queued", "running"]);

export function isTerminalStatus(status) {
  return TERMINAL_SET.has(text(status));
}

export function isActiveStatus(status) {
  return ACTIVE_SET.has(text(status));
}

export function isCancellable(record) {
  return CANCELLABLE_SET.has(text(record?.status));
}

// 旧记录（无 stateRevision / 取消字段）兼容为 revision 0 与空字符串。
export function normalizeTaskRecord(record) {
  if (!record || typeof record !== "object") return null;
  const revision = Number.isInteger(record.stateRevision) && record.stateRevision > 0
    ? record.stateRevision
    : 0;
  return {
    ...record,
    stateRevision: revision,
    cancelRequestedAt: text(record.cancelRequestedAt),
    cancelRequestedBy: text(record.cancelRequestedBy),
    cancelledAt: text(record.cancelledAt),
  };
}

// 每次落盘的记录都会获得新的、严格递增的 revision（含 childPid 等旁路字段的补写）；
// 这样 SQLite 镜像只接受较新 revision 的前进，同 revision 幂等。
export function nextTaskRecord(task, now) {
  const normalized = normalizeTaskRecord(task);
  if (!normalized) throw new Error("invalid long task record");
  return {
    ...normalized,
    stateRevision: normalized.stateRevision + 1,
    updatedAt: text(now) || normalized.updatedAt,
  };
}

export function requestTaskCancellation(record, { requestedBy = "", now } = {}) {
  const normalized = normalizeTaskRecord(record);
  if (!normalized) throw new Error("invalid long task record");
  if (!CANCELLABLE_SET.has(normalized.status)) {
    throw new Error(`long task is not cancellable: ${normalized.status}`);
  }
  const timestamp = text(now) || normalized.updatedAt;
  return {
    ...nextTaskRecord(normalized, timestamp),
    status: "cancelling",
    cancelRequestedAt: timestamp,
    cancelRequestedBy: text(requestedBy),
    endedAt: "",
    terminalReason: "",
    errorCode: "",
  };
}

export function confirmTaskCancellation(record, { requestedBy = "", now } = {}) {
  const normalized = normalizeTaskRecord(record);
  if (!normalized) throw new Error("invalid long task record");
  if (normalized.status !== "cancelling" && normalized.status !== "queued") {
    throw new Error(`long task cannot confirm cancel: ${normalized.status}`);
  }
  const timestamp = text(now) || normalized.updatedAt;
  return {
    ...nextTaskRecord(normalized, timestamp),
    status: "cancelled",
    cancelRequestedAt: normalized.cancelRequestedAt || timestamp,
    cancelRequestedBy: normalized.cancelRequestedBy || text(requestedBy),
    cancelledAt: timestamp,
    endedAt: normalized.endedAt || timestamp,
    terminalReason: normalized.terminalReason || MANUAL_CANCEL_REASON,
  };
}

// 重启恢复：queued/running 失去运行归属，升级为 failed（保留孤儿诊断）；cancelling
// 保留为墓碑等待对账，不猜测已停止；其余终态不动。
export function recoverInterruptedRecord(record, { now, childAlive = false } = {}) {
  const normalized = normalizeTaskRecord(record);
  if (!normalized) return { record: null, changed: false };
  if (normalized.status === "cancelling") return { record: normalized, changed: false };
  if (normalized.status !== "queued" && normalized.status !== "running") {
    return { record: normalized, changed: false };
  }
  const endedAt = text(now) || normalized.updatedAt;
  return {
    record: {
      ...nextTaskRecord(normalized, endedAt),
      status: "failed",
      endedAt,
      terminalReason: childAlive
        ? "runtime restarted before the long task finished (orphaned child may still deliver its result)"
        : "runtime restarted before the long task finished",
      errorCode: "long_task_interrupted",
    },
    changed: true,
  };
}

export function ensureTaskStateFile(stateFile) {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  if (existsSync(stateFile)) return;
  const fd = openSync(stateFile, "a", 0o600);
  closeSync(fd);
}

// 显式失败：写不进去就抛错，调用方不得据此对外宣称取消已接受/已完成。
export function appendTaskStateRecord(stateFile, record) {
  try {
    ensureTaskStateFile(stateFile);
    appendFileSync(stateFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(stateFile, 0o600);
  } catch (error) {
    throw new Error("long task state unavailable", { cause: error });
  }
}

export function readLatestTaskStateRecords(stateFile) {
  if (!existsSync(stateFile)) return new Map();
  const latest = new Map();
  for (const line of readFileSync(stateFile, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const normalized = isTaskRecord(record) ? normalizeTaskRecord(record) : null;
    if (normalized) latest.set(normalized.taskId, normalized);
  }
  return latest;
}

export function readActiveTaskRecords(stateFile) {
  return [...readLatestTaskStateRecords(stateFile).values()].filter((record) => isActiveStatus(record.status));
}

// 原子收敛：active（含 cancelling 墓碑）常驻，终端记录按 retention 过期；临时文件
// 与目标文件都保持 0600。
export function compactTaskStateFile(stateFile, now, terminalRetentionMs) {
  if (!existsSync(stateFile)) return;
  const current = typeof now === "function" ? now() : new Date(now ?? Date.now());
  const cutoff = current.getTime() - terminalRetentionMs;
  const records = [...readLatestTaskStateRecords(stateFile).values()].filter((task) =>
    isActiveStatus(task.status) || Date.parse(task.updatedAt) >= cutoff);
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, records.map((task) => `${JSON.stringify(task)}\n`).join(""), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, stateFile);
  chmodSync(stateFile, 0o600);
}

function isTaskRecord(record) {
  return record && typeof record === "object" &&
    typeof record.taskId === "string" && typeof record.agentId === "string" &&
    typeof record.peerId === "string" && typeof record.skillName === "string";
}

function text(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

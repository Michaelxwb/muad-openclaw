import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_STATE_FILE = "/tmp/muad-runtime-queues/long-task/state.jsonl";
const TERMINAL_RETENTION_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_STATE_COMPACT_EVERY = 100;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export class LongTaskManager {
  #pools = new Map();
  #runTask;
  #stateFile;
  #writesSinceCompact = 0;
  #now;
  #onChange;
  #log;

  constructor(options) {
    this.limit = positiveInteger(options?.limit) ? options.limit : 2;
    this.terminalRetentionMs = positiveInteger(options?.terminalRetentionMs)
      ? options.terminalRetentionMs
      : TERMINAL_RETENTION_MS;
    this.timeoutSeconds = positiveInteger(options?.timeoutSeconds)
      ? options.timeoutSeconds
      : DEFAULT_TIMEOUT_SECONDS;
    this.compactEvery = positiveInteger(options?.compactEvery)
      ? options.compactEvery
      : DEFAULT_STATE_COMPACT_EVERY;
    this.#runTask = options?.runTask ?? spawnOpenClawTask;
    this.#stateFile = options?.stateFile ?? DEFAULT_STATE_FILE;
    this.#now = options?.now ?? (() => new Date());
    this.#log = options?.log ?? (() => {});
    this.shared = true;
    this.closed = false;
    this.#loadInterruptedTasks();
  }

  submit(input) {
    if (this.closed) throw new Error("long task manager stopped");
    const task = this.#newTask(input);
    const pool = this.#pool(task);
    this.#purgeTerminal(pool);
    const queuedAhead = pool.queue.length;
    this.#log(`[muad-runtime-guard] long task submitted taskId=${task.taskId} skill=${task.skillName} queuedAhead=${queuedAhead}`);
    if (pool.active.size < this.limit) {
      this.#start(pool, task);
      return { task, queuedAhead: 0, ...poolCounts(pool, this.limit) };
    }
    task.status = "queued";
    pool.queue.push(task);
    this.#record(task);
    return { task, queuedAhead, ...poolCounts(pool, this.limit) };
  }

  updateLimit(limit) {
    if (!positiveInteger(limit) || limit === this.limit) return;
    this.limit = limit;
    for (const pool of this.#pools.values()) this.#drain(pool);
  }

  resolvePeerForTaskId(taskId) {
    for (const pool of this.#pools.values()) {
      const task = pool.active.get(taskId) ??
        pool.queue.find((task) => task.taskId === taskId) ??
        pool.terminal.find((task) => task.taskId === taskId);
      if (task) return task.peerId;
    }
    return "";
  }

  snapshot() {
    const pools = [];
    let queued = 0;
    let active = 0;
    for (const pool of this.#pools.values()) {
      this.#purgeTerminal(pool);
      queued += pool.queue.length;
      active += pool.active.size;
      pools.push({
        poolKey: pool.key,
        sessionKey: pool.sessionKey,
        agentId: pool.agentId,
        peerId: pool.peerId,
        queued: pool.queue.length,
        active: pool.active.size,
        limit: this.limit,
        tasks: [
          ...pool.queue,
          ...pool.active.values(),
          ...pool.terminal,
        ].map(publicTask),
      });
    }
    return {
      active,
      queued,
      limit: this.limit,
      pools: pools.sort((left, right) => left.poolKey.localeCompare(right.poolKey)),
    };
  }

  subscribe(onChange) {
    this.#onChange = onChange;
    try {
      if (typeof onChange === "function") onChange(this.snapshot());
    } catch (error) {
      this.#log(`[muad-runtime-guard] long task onChange failed: ${errorMessage(error)}`);
    }
    return () => {
      if (this.#onChange === onChange) this.#onChange = undefined;
    };
  }

  close() {
    this.closed = true;
  }

  #newTask(input) {
    const taskId = input.taskId || randomUUID();
    const agentId = textValue(input.agentId);
    const peerId = textValue(input.peerId);
    const replyChannel = textValue(input.replyChannel) || "wecom";
    const submittedAt = this.#now().toISOString();
    if (!agentId || !peerId || !SKILL_NAME_PATTERN.test(textValue(input.skillName)) ||
      !textValue(input.skillRoot).startsWith("/")) {
      throw new Error("invalid long task submission");
    }
    return {
      taskId,
      agentId,
      peerId,
      poolKey: poolKey(agentId, replyChannel, peerId),
      sourceSessionKey: textValue(input.sessionKey) || `agent:${agentId}:${replyChannel}:direct:${peerId}`,
      sessionKey: `agent:${agentId}:longtask:${taskId}`,
      skillName: textValue(input.skillName),
      skillRoot: textValue(input.skillRoot),
      objective: textValue(input.objective),
      originalPrompt: textValue(input.originalPrompt),
      replyChannel,
      locale: normalizedLocale(textValue(input.locale)),
      status: "queued",
      submittedAt,
      updatedAt: submittedAt,
      startedAt: "",
      endedAt: "",
      terminalReason: "",
      errorCode: "",
    };
  }

  #pool(task) {
    let pool = this.#pools.get(task.poolKey);
    if (!pool) {
      pool = {
        key: task.poolKey,
        sessionKey: task.sourceSessionKey || task.poolKey,
        agentId: task.agentId,
        peerId: task.peerId,
        queue: [],
        active: new Map(),
        terminal: [],
      };
      this.#pools.set(task.poolKey, pool);
    }
    pool.sessionKey = task.sourceSessionKey || pool.sessionKey;
    return pool;
  }

  #start(pool, task) {
    task.status = "running";
    task.startedAt = this.#now().toISOString();
    task.updatedAt = task.startedAt;
    pool.active.set(task.taskId, task);
    this.#log(`[muad-runtime-guard] long task started taskId=${task.taskId} skill=${task.skillName}`);
    this.#record(task);
    const running = this.#runTask(task, { timeoutSeconds: this.timeoutSeconds });
    // runTask 同步 spawn 完成后会设置 task.childPid（见 runOpenClawAgent）；再落盘一次，
    // 让 state 记录携带 PID，供下次启动的孤儿检测（childStillRunning）使用。
    if (Number.isInteger(task.childPid)) this.#record(task);
    void running
      .then(() => this.#finish(pool, task, "succeeded", "", ""))
      .catch((error) => this.#finish(pool, task, "failed", errorMessage(error), errorCode(error)));
  }

  #finish(pool, task, status, reason, code) {
    if (!pool.active.delete(task.taskId)) return;
    const endedAt = this.#now().toISOString();
    task.status = status;
    task.endedAt = endedAt;
    task.updatedAt = endedAt;
    task.terminalReason = reason;
    task.errorCode = code;
    this.#log(`[muad-runtime-guard] long task ${status} taskId=${task.taskId} skill=${task.skillName}${code ? ` errorCode=${code}` : ""}`);
    pool.terminal.push(task);
    this.#record(task);
    this.#drain(pool);
  }

  #drain(pool) {
    while (!this.closed && pool.active.size < this.limit && pool.queue.length > 0) {
      this.#start(pool, pool.queue.shift());
    }
  }

  #purgeTerminal(pool) {
    const cutoff = this.#now().getTime() - this.terminalRetentionMs;
    pool.terminal = pool.terminal.filter((task) => Date.parse(task.updatedAt) >= cutoff);
  }

  #record(task) {
    try {
      ensureStateFile(this.#stateFile);
      // childPid 仅落入 state 文件（供下次启动的孤儿检测），不进 publicTask——
      // console 快照契约保持不变。
      const record = {
        ...publicTask(task),
        ...(Number.isInteger(task.childPid) ? { childPid: task.childPid } : {}),
      };
      appendFileSync(this.#stateFile, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.#stateFile, 0o600);
      this.#compactStateWhenDue();
    } catch (error) {
      this.#log(`[muad-runtime-guard] long task state write failed: ${errorMessage(error)}`);
    }
    this.#notifyChange();
  }

  #notifyChange() {
    if (typeof this.#onChange !== "function") return;
    try {
      this.#onChange(this.snapshot());
    } catch (error) {
      this.#log(`[muad-runtime-guard] long task onChange failed: ${errorMessage(error)}`);
    }
  }

  #compactStateWhenDue() {
    this.#writesSinceCompact += 1;
    if (this.#writesSinceCompact < this.compactEvery) return;
    this.#writesSinceCompact = 0;
    compactStateFile(this.#stateFile, this.#now, this.terminalRetentionMs);
  }

  #loadInterruptedTasks() {
    const tasks = loadInterruptedTasks(this.#stateFile, this.#now);
    if (tasks.length > 0) {
      this.#log(`[muad-runtime-guard] long task restored ${tasks.length} interrupted task(s)`);
    }
    for (const task of tasks) {
      // 恢复即终态：立即把 failed 落盘（与终端任务同一 retention），否则每次重启都会
      // 重复恢复同一批 queued/running 记录，且 compact 永远保留它们 → 文件只增不减、
      // 僵尸记录反复出现。落盘后该 taskId 的最新记录是 failed，下次重启不再恢复。
      this.#record(task);
      const pool = this.#pool(task);
      pool.terminal.push(task);
    }
  }
}

export async function spawnOpenClawTask(task, options = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "muad-long-task-"));
  const messageFile = path.join(tempRoot, "message.txt");
  try {
    await writeFile(messageFile, longTaskMessage(task), { mode: 0o600 });
    await runOpenClawAgent(task, messageFile, options);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runOpenClawAgent(task, messageFile, options) {
  const args = [
    "agent",
    "--agent", task.agentId,
    "--session-key", task.sessionKey,
    "--message-file", messageFile,
    "--deliver",
    "--reply-channel", task.replyChannel,
    "--reply-to", task.peerId,
    "--json",
    "--timeout", String(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
  ];
  const watchdogMs = positiveInteger(options.watchdogMs)
    ? options.watchdogMs
    : (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve, reject) => {
    // stdout 置 ignore：长任务 openclaw agent 会在 stdout 上输出进度/结果，若无人
    // 消费，64KB 管道缓冲区写满即永久阻塞、exit 永不触发、并发槽泄漏。stderr 仅作
    // 错误诊断收集，同样设上限防止无限增长。
    const child = (options.spawn ?? spawn)("openclaw", args, { stdio: ["ignore", "ignore", "pipe"] });
    // 进程级 watchdog：timeoutSeconds 只是传给子进程自己的 --timeout 参数，父进程
    // 必须兜底——子进程挂死（不响应 kill 前）时按 watchdogMs 强杀并 reject，保证
    // promise 必然 settle，队列不会因一个僵尸子进程永久占槽。
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 4096); });
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // child already gone; reject below is authoritative
      }
      reject(new LongTaskRunError(124, `openclaw agent exceeded the ${watchdogMs}ms watchdog timeout and was killed`));
    }, watchdogMs);
    watchdog.unref?.();
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn(value);
    };
    child.on("error", settle(reject));
    child.on("exit", (code) => {
      settle(code === 0 ? resolve : () => reject(new LongTaskRunError(code, stderr.trim())))();
    });
    // 记录子进程 PID 到任务对象：manager 在 #start 时把带 PID 的记录落盘，供下次
    // 启动做孤儿检测（见 loadInterruptedTasks 的 childStillRunning）。
    if (Number.isInteger(child.pid)) task.childPid = child.pid;
  });
}

// 任务ID行（提交确认与结果前缀共用，保证格式一致）。
export function taskIdLine(locale, taskId) {
  const id = textValue(taskId);
  if (!id) return "";
  return normalizedLocale(locale) === "en" ? `Task ID: ${id}` : `任务ID：${id}`;
}

export function longTaskMessage(task) {
  const idLine = taskIdLine(task.locale, task.taskId);
  const resultPrefix = idLine
    ? `\nWhen you deliver the final result, your reply MUST begin with the following line, verbatim and character-for-character, on its own line, so the user can match this result back to the submitted task:\n\n${idLine}\n\nDo not omit, alter, or reword it.\n`
    : "";
  return `You are executing a background long task for a user.

Task objective:
${task.objective || "(not provided)"}

Original user request:
${task.originalPrompt || "(not provided)"}

Read and follow the real Skill instructions at:
${path.join(task.skillRoot, "SKILL.md")}

Do not start this task by sending or expanding /skill:${task.skillName}. Execute the Skill instructions directly in this task session, then deliver the final result.
${resultPrefix}`;
}

export class LongTaskRunError extends Error {
  constructor(code, stderr) {
    super(stderr || `openclaw agent exited with code ${code}`);
    this.name = "LongTaskRunError";
    this.code = classifyRunError(code, stderr);
    this.exitCode = code;
  }
}

function loadInterruptedTasks(stateFile, now) {
  if (!existsSync(stateFile)) return [];
  try {
    return [...readLatestTaskRecords(stateFile).values()]
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => interruptedTask(task, now, childStillRunning(task.childPid)));
  } catch {
    return [];
  }
}

function compactStateFile(stateFile, now, terminalRetentionMs) {
  if (!existsSync(stateFile)) return;
  const cutoff = now().getTime() - terminalRetentionMs;
  // readLatestTaskRecords 已按 taskId 去重保留最新记录：恢复流程会把 queued/running
  // 落盘为 failed，因此此处保留 queued/running 只覆盖"本进程仍在运行的活任务"；
  // 终端记录按 retention 过期，僵尸记录不会永久滞留。
  const records = [...readLatestTaskRecords(stateFile).values()].filter((task) =>
    task.status === "queued" || task.status === "running" ||
    Date.parse(task.updatedAt) >= cutoff);
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, records.map((task) => `${JSON.stringify(task)}\n`).join(""), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tempFile, 0o600);
  renameSync(tempFile, stateFile);
  chmodSync(stateFile, 0o600);
}

function readLatestTaskRecords(stateFile) {
  const latest = new Map();
  for (const line of readFileSync(stateFile, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const task = JSON.parse(line);
    if (isTaskRecord(task)) latest.set(task.taskId, task);
  }
  return latest;
}

// 孤儿子进程检测：state 记录若带 childPid，用 kill(pid, 0) 探测进程是否仍存活。
// 残余风险说明：被 spawn 的 openclaw agent 子进程独立于插件进程存活，重启后 guard
// 无法重新挂接其 exit 事件（ChildProcess 句柄已随旧进程销毁），因此即使探测到存活，
// 也无法收养并跟踪它——该子进程仍可能经 --deliver 直接向用户投递结果，与 console 的
// failed 状态并存。彻底解决需要 spawn 时使用独立进程组 + 父进程死亡即连带终止
// （或控制面侧的 per-agent 归属证明），超出本模块范围；此处至少把"孤儿仍存活"这一
// 事实记入 terminalReason，便于排障。
function childStillRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但属其他用户，视为存活。
    return error?.code === "EPERM";
  }
}

function interruptedTask(task, now, childAlive) {
  const endedAt = now().toISOString();
  return {
    ...task,
    status: "failed",
    endedAt,
    updatedAt: endedAt,
    terminalReason: childAlive
      ? "runtime restarted before the long task finished (orphaned child may still deliver its result)"
      : "runtime restarted before the long task finished",
    errorCode: "long_task_interrupted",
  };
}

function isTaskRecord(task) {
  return task && typeof task.taskId === "string" && typeof task.agentId === "string" &&
    typeof task.peerId === "string" && typeof task.skillName === "string";
}

function ensureStateFile(stateFile) {
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  if (existsSync(stateFile)) return;
  const fd = openSync(stateFile, "a", 0o600);
  closeSync(fd);
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    poolKey: task.poolKey,
    sessionKey: task.sessionKey,
    sourceSessionKey: task.sourceSessionKey,
    agentId: task.agentId,
    peerId: task.peerId,
    skillName: task.skillName,
    skillRoot: task.skillRoot,
    status: task.status,
    submittedAt: task.submittedAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    terminalReason: task.terminalReason,
    errorCode: task.errorCode,
    updatedAt: task.updatedAt,
  };
}

function poolCounts(pool, limit) {
  return { queued: pool.queue.length, active: pool.active.size, limit };
}

function poolKey(agentId, replyChannel, peerId) {
  return `agent:${agentId}:${replyChannel}:direct:${peerId}`;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function classifyRunError(code, stderr) {
  const text = textValue(stderr).toLowerCase();
  return code === 124 || text.includes("timeout") || text.includes("timed out")
    ? "longtask.timeout"
    : "long_task_spawn_failed";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return error instanceof Error && typeof error.code === "string" ? error.code : "long_task_failed";
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedLocale(value) {
  return textValue(value).toLowerCase() === "en" ? "en" : "zh";
}

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
    this.#record(task);
    void this.#runTask(task, { timeoutSeconds: this.timeoutSeconds })
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
      appendFileSync(this.#stateFile, `${JSON.stringify(publicTask(task))}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.#stateFile, 0o600);
      this.#compactStateWhenDue();
    } catch (error) {
      console.warn(`[muad-runtime-guard] long task state write failed: ${errorMessage(error)}`);
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
    for (const task of tasks) {
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
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)("openclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 4096); });
    child.on("error", reject);
    child.on("exit", (code) => {
      code === 0 ? resolve() : reject(new LongTaskRunError(code, stderr.trim()));
    });
  });
}

export function longTaskMessage(task) {
  return `You are executing a background long task for a user.

Task objective:
${task.objective || "(not provided)"}

Original user request:
${task.originalPrompt || "(not provided)"}

Read and follow the real Skill instructions at:
${path.join(task.skillRoot, "SKILL.md")}

Do not start this task by sending or expanding /skill:${task.skillName}. Execute the Skill instructions directly in this task session, then deliver the final result.
`;
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
      .map((task) => interruptedTask(task, now));
  } catch {
    return [];
  }
}

function compactStateFile(stateFile, now, terminalRetentionMs) {
  if (!existsSync(stateFile)) return;
  const cutoff = now().getTime() - terminalRetentionMs;
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

function interruptedTask(task, now) {
  const endedAt = now().toISOString();
  return {
    ...task,
    status: "failed",
    endedAt,
    updatedAt: endedAt,
    terminalReason: "runtime restarted before the long task finished",
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

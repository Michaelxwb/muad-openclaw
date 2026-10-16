import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { notifyUser } from "../../shared/notify-user.mjs";
import { createResultDelivery, parseAgentResultPayloads } from "./long-task-delivery.mjs";
import {
  appendTaskStateRecord,
  compactTaskStateFile,
  confirmTaskCancellation,
  isTerminalStatus,
  nextTaskRecord,
  readActiveTaskRecords,
  recoverInterruptedRecord,
  requestTaskCancellation,
} from "./long-task-cancel-state.mjs";

const DEFAULT_STATE_FILE = "/tmp/muad-runtime-queues/long-task/state.jsonl";
const TERMINAL_RETENTION_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_STATE_COMPACT_EVERY = 100;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
// 子 CLI 输出的结果 JSON 上限：持续消费避免管道阻塞，超出即视为不可解析（fail loud）。
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
// 取消对账：未确认停止的 cancelling 任务按固定节奏重试停止确认（占槽 + 有界重试，不伪造）。
const CANCEL_RECONCILE_INTERVAL_MS = 20_000;
const CANCEL_RECONCILE_MAX_ATTEMPTS = 30;
const defaultResultDelivery = createResultDelivery();

export class LongTaskManager {
  #pools = new Map();
  #runTask;
  #stateFile;
  #writesSinceCompact = 0;
  #now;
  #onChange;
  #log;
  #notifyFailure;
  #progressManager;
  #progressExecutions = new Map();
  #runController = null;
  #runControllers = [];
  #releaseTaskResources = null;
  #releasedTaskIds = new Set();
  #deliverResult = null;
  #cancelReconcileTimer = null;
  #cancelReconcileAttempts = new Map();

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
    this.#notifyFailure = options?.notifyFailure ?? defaultNotifyFailure;
    this.#runController = isRunController(options?.runController) ? options.runController : null;
    if (this.#runController) this.#runControllers.push(this.#runController);
    this.#releaseTaskResources = typeof options?.releaseTaskResources === "function"
      ? options.releaseTaskResources
      : null;
    this.#deliverResult = typeof options?.deliverResult === "function"
      ? options.deliverResult
      : defaultResultDelivery;
    this.updateProgressManager(options?.progressManager);
    this.shared = true;
    this.closed = false;
    const reconcileInterval = options?.cancelReconcileIntervalMs;
    this.cancelReconcileIntervalMs = Number.isInteger(reconcileInterval) && reconcileInterval >= 0
      ? reconcileInterval
      : CANCEL_RECONCILE_INTERVAL_MS;
    const reconcileAttempts = options?.cancelReconcileMaxAttempts;
    this.cancelReconcileMaxAttempts = positiveInteger(reconcileAttempts)
      ? reconcileAttempts
      : CANCEL_RECONCILE_MAX_ATTEMPTS;
    this.#loadInterruptedTasks();
    this.#startCancelReconcile();
  }

  // 有界对账重试：cancelling 任务按固定节奏重试停止确认（run 句柄缺失时以真实 childPid
  // 退出 + 归属 sweep 判定），每次尝试自身有界，超过次数上限后保持墓碑不再重试。
  #startCancelReconcile() {
    if (this.cancelReconcileIntervalMs <= 0) return;
    this.#cancelReconcileTimer = setInterval(() => {
      void this.#reconcileCancellingTasks();
    }, this.cancelReconcileIntervalMs);
    this.#cancelReconcileTimer.unref?.();
  }

  async #reconcileCancellingTasks() {
    if (this.closed) return;
    for (const pool of this.#pools.values()) {
      for (const task of [...pool.active.values()]) {
        if (task.status !== "cancelling") continue;
        const attempts = (this.#cancelReconcileAttempts.get(task.taskId) ?? 0) + 1;
        this.#cancelReconcileAttempts.set(task.taskId, attempts);
        if (attempts > this.cancelReconcileMaxAttempts) continue;
        try {
          await this.#confirmRunStop(pool, task, task.runBinding);
        } catch (error) {
          this.#log(`[muad-runtime-guard][longtask-cancel] reconcile retry failed taskId=${task.taskId} reason=${errorMessage(error)}`);
        }
      }
    }
  }

  submit(input) {
    if (this.closed) throw new Error("long task manager stopped");
    const task = this.#newTask(input);
    this.#record(task, true);
    const pool = this.#pool(task);
    this.#purgeTerminal(pool);
    const queuedAhead = pool.queue.length;
    this.#log(`[muad-runtime-guard] long task submitted taskId=${task.taskId} skill=${task.skillName} queuedAhead=${queuedAhead}`);
    if (pool.active.size < this.limit) {
      if (!this.#start(pool, task)) throw new Error("long task state unavailable");
      return { task, queuedAhead: 0, ...poolCounts(pool, this.limit) };
    }
    task.status = "queued";
    pool.queue.push(task);
    this.#notifyChange();
    return { task, queuedAhead, ...poolCounts(pool, this.limit) };
  }

  updateLimit(limit) {
    if (!positiveInteger(limit) || limit === this.limit) return;
    this.limit = limit;
    for (const pool of this.#pools.values()) this.#drain(pool);
  }

  updateProgressManager(manager) {
    this.#progressManager = isProgressManager(manager) ? manager : undefined;
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

  // 取消入口（控制面 RPC 唯一路径）：与完成回调在同一任务临界区线性化。queued 取消
  // 在可靠保存取消终态后完成；running 先可靠保存 cancelling（继续占槽），再调用运行
  // 控制器确认停止，只有确认完成并清理资源后才进入 cancelled。
  async cancelTask(taskId, { requestedBy = "" } = {}) {
    if (this.closed) return { ok: false, reason: "not_available" };
    const located = this.#locateTask(taskId);
    if (!located) return { ok: false, reason: "not_found" };
    const { pool, task } = located;
    if (task.status === "cancelling") {
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision ?? 0, repeated: true,
      };
    }
    if (isTerminalStatus(task.status)) {
      return { ok: false, reason: "already_terminal", status: task.status, stateRevision: task.stateRevision ?? 0 };
    }
    if (task.status === "queued") return this.#cancelQueuedTask(pool, task, requestedBy);
    if (task.status === "running") return this.#cancelRunningTask(pool, task, requestedBy);
    return { ok: false, reason: "already_terminal", status: task.status, stateRevision: task.stateRevision ?? 0 };
  }

  #locateTask(taskId) {
    const id = textValue(taskId);
    if (!id) return null;
    for (const pool of this.#pools.values()) {
      const task = pool.active.get(id) ??
        pool.queue.find((item) => item.taskId === id) ??
        pool.terminal.find((item) => item.taskId === id);
      if (task) return { pool, task };
    }
    return null;
  }

  // 任务当前状态（长任务会话的取消门禁依赖此查询；未知任务返回 ""）。
  taskStatus(taskId) {
    return this.#locateTask(taskId)?.task.status ?? "";
  }

  // 运行控制器可能在异步加载原生运行环境后注入；只接受结构完整的 controller。
  attachRunController(controller) {
    if (!isRunController(controller)) return this.#runController;
    // 保留历史控制器：插件（重）装载会注入新实例，已绑定任务的运行句柄仍在旧实例
    // 注册表中；取消/释放必须能定位到持有该绑定的控制器，否则会误判 unknown run。
    if (!this.#runControllers.includes(controller)) this.#runControllers.push(controller);
    this.#runController = controller;
    return controller;
  }

  // 定位持有该任务运行绑定的控制器（跨插件重载）；没有持有者时返回 null，
  // 调用方按"句柄不可用"走真实进程退出兜底，不得误用无关控制器。
  #resolveRunController(taskId) {
    return this.#runControllers.find(item => {
      try {
        return typeof item.lookup === "function" && Boolean(item.lookup(textValue(taskId)));
      } catch {
        return false;
      }
    }) ?? null;
  }

  #releaseRunBinding(taskId) {
    const controller = this.#resolveRunController(taskId) ?? this.#runController;
    try {
      controller?.release?.(taskId);
    } catch {
      // 释放失败不改变任务终态；绑定归属已由控制器自持。
    }
  }

  // 终态精确资源清理：每个任务至多调用一次，只传目标任务身份；注入回调异常仅记日志，
  // 不改变任务状态（自然完成路径用；取消路径在收尾中 await 并显式处理失败）。
  #taskResourceSnapshot(task) {
    return Object.freeze({
      taskId: task.taskId,
      agentId: task.agentId,
      sessionKey: task.sessionKey,
      skillName: task.skillName,
      status: task.status,
    });
  }

  #releaseTaskResourcesOnce(task) {
    if (!this.#releaseTaskResources || this.#releasedTaskIds.has(task.taskId)) return;
    this.#releasedTaskIds.add(task.taskId);
    try {
      void Promise.resolve(this.#releaseTaskResources(this.#taskResourceSnapshot(task))).catch((error) =>
        this.#log(`[muad-runtime-guard][longtask-cancel] release task resources failed taskId=${task.taskId} reason=${errorMessage(error)}`));
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-cancel] release task resources failed taskId=${task.taskId} reason=${errorMessage(error)}`);
    }
  }

  // 结果投递：许可已由 #finish 临界区裁定（取消已提交的任务不会进入这里）；发起后
  // 视为在途，投递结果只记日志、不影响任务终态。
  #initiateResultDelivery(task, payloads) {
    const deliver = this.#deliverResult;
    if (typeof deliver !== "function") return;
    const target = Object.freeze({
      taskId: task.taskId,
      agentId: task.agentId,
      peerId: task.peerId,
      replyChannel: task.replyChannel,
      locale: task.locale,
      skillName: task.skillName,
    });
    try {
      void Promise.resolve(deliver(target, payloads)).then((outcome) => {
        this.#log(`[muad-runtime-guard][longtask-delivery] result delivery taskId=${task.taskId} sent=${outcome?.sent ?? 0} failed=${outcome?.failed ?? 0}`);
      }).catch((error) => {
        this.#log(`[muad-runtime-guard][longtask-delivery] result delivery failed taskId=${task.taskId} reason=${errorMessage(error)}`);
      });
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-delivery] result delivery failed taskId=${task.taskId} reason=${errorMessage(error)}`);
    }
  }

  // 排队取消：先可靠写入取消终态（revision 单调），成功后才移出队列并终结，
  // 写失败明确报错、保持排队，不接受取消成功。
  #cancelQueuedTask(pool, task, requestedBy) {
    const record = confirmTaskCancellation(task, { requestedBy, now: this.#now().toISOString() });
    try {
      appendTaskStateRecord(this.#stateFile, this.#persistedRecordFor(task, record));
    } catch {
      this.#log(`[muad-runtime-guard][longtask-cancel] queued cancel state write failed taskId=${task.taskId}`);
      return { ok: false, reason: "state_unavailable" };
    }
    Object.assign(task, record);
    pool.queue = pool.queue.filter((item) => item.taskId !== task.taskId);
    this.#releaseRunBinding(task.taskId);
    pool.terminal.push(task);
    this.#log(`[muad-runtime-guard][longtask-cancel] queued task cancelled taskId=${task.taskId}`);
    this.#notifyChange();
    return { ok: true, outcome: "cancelled", status: "cancelled", stateRevision: task.stateRevision };
  }

  // 运行中取消：先可靠提交取消请求（cancelling，继续占槽），再尝试停止确认。
  async #cancelRunningTask(pool, task, requestedBy) {
    const record = requestTaskCancellation(task, { requestedBy, now: this.#now().toISOString() });
    try {
      appendTaskStateRecord(this.#stateFile, this.#persistedRecordFor(task, record));
    } catch {
      this.#log(`[muad-runtime-guard][longtask-cancel] cancel request state write failed taskId=${task.taskId}`);
      return { ok: false, reason: "state_unavailable" };
    }
    Object.assign(task, record);
    this.#log(`[muad-runtime-guard][longtask-cancel] cancel requested taskId=${task.taskId}`);
    this.#notifyChange();
    if (!task.runBinding) {
      // spawn 间隙：运行句柄绑定后由 #bindRunHandle 用同一取消标记补做停止确认。
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: "run_binding_pending",
      };
    }
    return this.#confirmRunStop(pool, task, task.runBinding);
  }

  // 停止确认：只有运行控制器确认（drained 且自有进程真实退出）才清理并进入 cancelled；
  // 未确认保持 cancelling（占槽），供有界对账重试，不伪造已取消。
  async #confirmRunStop(pool, task, binding) {
    const controller = binding ? this.#resolveRunController(binding.taskId) : null;    if (!controller || typeof controller.cancel !== "function" || !binding) {
      // 无可用运行句柄（提交回合未经本进程托管运行、原生句柄缺失等）：以本进程 spawn
      // 时记录的真实 childPid 与归属 sweep 作为停止事实；无法证明则保持未确认，
      // 不杀 CLI 冒名取消、不伪造停止。
      const pid = Number(task.childPid);
      const hasRecordedChild = Number.isInteger(pid) && pid > 0;
      if (!hasRecordedChild || childStillRunning(pid)) {
        return {
          ok: true, outcome: "cancel_requested", status: "cancelling",
          stateRevision: task.stateRevision, detail: "run_handle_unavailable",
        };
      }
      const sweep = await this.#sweepTaskProcesses(task);
      if (!sweep.ok) {
        return {
          ok: true, outcome: "cancel_requested", status: "cancelling",
          stateRevision: task.stateRevision, detail: "process_stop_unconfirmed",
        };
      }
      return this.#finalizeCancelled(pool, task);
    }
    let result;
    try {
      result = await controller.cancel(binding);
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-cancel] stop confirm failed taskId=${task.taskId} reason=${errorMessage(error)}`);
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: "stop_unconfirmed",
      };
    }
    if (!result?.confirmed) {
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: result?.reason || "stop_unconfirmed",
      };
    }
    const sweep = await this.#sweepTaskProcesses(task);
    if (!sweep.ok) {
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: "process_stop_unconfirmed",
      };
    }
    return this.#finalizeCancelled(pool, task);
  }

  // 分离执行进程回收：exec 链路可能把脚本 setsid 分离（独立会话/进程组），run/CLI
  // 终止触达不到；按任务 skillRoot 归属标记枚举并终止，只有全部消失才允许进入 cancelled。
  async #sweepTaskProcesses(task) {
    try {
      const { sweepOrphanProcesses } = await import("./long-task-process-sweeper.mjs");
      const result = await sweepOrphanProcesses(`${path.join(task.skillRoot)}/`);
      if (!result.ok) {
        this.#log(`[muad-runtime-guard][longtask-cancel] process sweep unconfirmed taskId=${task.taskId} remaining=${result.remaining.join(",")}`);
      }
      return result;
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-cancel] process sweep failed taskId=${task.taskId} reason=${errorMessage(error)}`);
      return { ok: true, remaining: [] };
    }
  }

  // 收尾：停止已确认 → 清理进度桥与目标任务资源 → 可靠写入 cancelled → 释放槽位与
  // 绑定。清理或写入任一环节失败保持 cancelling（占槽），不改写为成功。
  async #finalizeCancelled(pool, task) {
    if (!pool.active.has(task.taskId)) {
      return { ok: true, outcome: "cancel_requested", status: task.status, stateRevision: task.stateRevision ?? 0 };
    }
    this.#finishProgress(task, { cancelled: true });
    try {
      if (this.#releaseTaskResources && !this.#releasedTaskIds.has(task.taskId)) {
        await this.#releaseTaskResources(this.#taskResourceSnapshot(task));
        this.#releasedTaskIds.add(task.taskId);
      }
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-cancel] release task resources failed taskId=${task.taskId} reason=${errorMessage(error)}`);
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: "cleanup_failed",
      };
    }
    const record = confirmTaskCancellation(task, {
      now: this.#now().toISOString(),
      requestedBy: task.cancelRequestedBy,
    });
    try {
      appendTaskStateRecord(this.#stateFile, this.#persistedRecordFor(task, record));
    } catch {
      this.#log(`[muad-runtime-guard][longtask-cancel] cancelled state write failed taskId=${task.taskId}`);
      return {
        ok: true, outcome: "cancel_requested", status: "cancelling",
        stateRevision: task.stateRevision, detail: "state_unavailable",
      };
    }
    Object.assign(task, record);
    pool.active.delete(task.taskId);
    this.#releaseRunBinding(task.taskId);
    pool.terminal.push(task);
    this.#log(`[muad-runtime-guard] long task cancelled taskId=${task.taskId} skill=${task.skillName}`);
    this.#drain(pool);
    this.#notifyChange();
    return { ok: true, outcome: "cancelled", status: "cancelled", stateRevision: task.stateRevision };
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
    if (this.#cancelReconcileTimer) {
      clearInterval(this.#cancelReconcileTimer);
      this.#cancelReconcileTimer = null;
    }
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
      ...(input.executionInputs === undefined ? {} : { executionInputs: structuredClone(input.executionInputs) }),
      replyChannel,
      locale: normalizedLocale(textValue(input.locale)),
      status: "queued",
      stateRevision: 0,
      cancelRequestedAt: "",
      cancelRequestedBy: "",
      cancelledAt: "",
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
    // 防重跑护栏：只有仍在排队且从未提交取消请求的任务才允许启动（启动前、spawn
    // 间隙与重复取消共用同一取消标记）。
    if (task.status !== "queued" || task.cancelRequestedAt) return false;
    task.status = "running";
    task.startedAt = this.#now().toISOString();
    task.updatedAt = task.startedAt;
    try {
      this.#record(task, true);
    } catch {
      task.status = "failed";
      task.errorCode = "long_task_state_unavailable";
      task.terminalReason = "long task state unavailable";
      task.endedAt = this.#now().toISOString();
      pool.terminal.push(task);
      this.#record(task);
      return false;
    }
    pool.active.set(task.taskId, task);
    this.#registerProgress(task);
    this.#log(`[muad-runtime-guard] long task started taskId=${task.taskId} skill=${task.skillName}`);
    this.#notifyChange();
    const running = this.#runTask(task, {
      timeoutSeconds: this.timeoutSeconds,
      onChild: (child) => this.#bindRunHandle(task, child),
    });
    // runTask 同步 spawn 完成后会设置 task.childPid（见 runOpenClawAgent）；再落盘一次，
    // 让 state 记录携带 PID，供下次启动的孤儿检测（childStillRunning）使用。
    if (Number.isInteger(task.childPid)) this.#record(task);
    // 终态化之前先回收该任务的分离执行进程（自然完成/失败同样可能留下 setsid 脚本）。
    void Promise.resolve(running)
      .then(async (settled) => {
        await this.#sweepTaskProcesses(task);
        this.#finish(pool, task, "succeeded", "", "", settled?.payloads);
      })
      .catch(async (error) => {
        await this.#sweepTaskProcesses(task);
        this.#finish(pool, task, "failed", errorMessage(error), errorCode(error));
      });
    return true;
  }

  #finish(pool, task, status, reason, code, resultPayloads = undefined) {
    if (!pool.active.has(task.taskId)) return;
    if (task.status === "cancelling" || task.status === "cancelled") {
      // 取消已提交（线性化点在前）：迟到完成回调不覆盖取消终态、不释放资源；运行
      // 结束只作辅助证据，触发一次有界停止确认（对账），失败保持 cancelling。
      this.#log(`[muad-runtime-guard] long task late ${status} ignored taskId=${task.taskId} status=${task.status}`);
      if (task.status === "cancelling") {
        void this.#confirmRunStop(pool, task, task.runBinding).catch((error) =>
          this.#log(`[muad-runtime-guard][longtask-cancel] reconcile failed taskId=${task.taskId} reason=${errorMessage(error)}`));
      }
      return;
    }
    // 投递许可在此临界区唯一裁定（同步、无 await 间隙）：取消已提交的任务不再新发
    // 成功结果或通用失败通知；许可一旦发起即视为在途，不再承诺撤回。
    if (status === "succeeded" && Array.isArray(resultPayloads) && resultPayloads.length > 0) {
      this.#initiateResultDelivery(task, resultPayloads);
    }
    pool.active.delete(task.taskId);
    this.#releaseRunBinding(task.taskId);
    const endedAt = this.#now().toISOString();
    task.status = status;
    task.endedAt = endedAt;
    task.updatedAt = endedAt;
    task.terminalReason = reason;
    task.errorCode = code;
    this.#finishProgress(task);
    this.#releaseTaskResourcesOnce(task);
    this.#log(`[muad-runtime-guard] long task ${status} taskId=${task.taskId} skill=${task.skillName}${code ? ` errorCode=${code}` : ""}`);
    pool.terminal.push(task);
    this.#record(task);
    this.#drain(pool);
    if (status === "failed") {
      // 失败也主动推送到 IM（成功由子进程 --deliver 投递，失败无此通道）。
      // fire-and-forget：不阻塞 finish/队列，投递失败仅记日志，任务状态仍已落盘。
      void this.#notifyFailure(task, code).catch((error) =>
        this.#log(`[muad-runtime-guard] long task failure notify failed taskId=${task.taskId} error=${errorMessage(error)}`),
      );
    }
  }

  // 记录本次执行的归属运行句柄：detached 子进程组由本 Worker 创建并持有，删除绑定
  // 前只允许经 run controller 按 taskId/sessionKey/worker 精确取消（禁止全局 kill）。
  #bindRunHandle(task, child) {
    if (Number.isInteger(child?.pid)) task.childPid = child.pid;
    const controller = this.#runController;
    if (!controller || typeof controller.bind !== "function") return;
    try {
      task.runBinding = controller.bind(task, { child, detached: true });
    } catch (error) {
      this.#log(`[muad-runtime-guard] long task run binding failed taskId=${task.taskId} reason=${errorMessage(error)}`);
      return;
    }
    if (task.status === "cancelling") {
      // spawn 间隙已接受取消：绑定后立即补一次停止确认（同一取消标记，不再重跑）。
      const pool = this.#pools.get(task.poolKey);
      if (pool) {
        void this.#confirmRunStop(pool, task, task.runBinding).catch((error) =>
          this.#log(`[muad-runtime-guard][longtask-cancel] spawn-gap confirm failed taskId=${task.taskId} reason=${errorMessage(error)}`));
      }
    }
  }

  #registerProgress(task) {
    const manager = this.#progressManager;
    if (!manager) return;
    try {
      const registration = manager.registerBackground({
        taskId: task.taskId,
        agentId: task.agentId,
        skillName: task.skillName,
        replyChannel: task.replyChannel,
        peerId: task.peerId,
        locale: task.locale,
      });
      if (registration?.registered === true && textValue(registration.executionKey)) {
        this.#progressExecutions.set(task.taskId, {
          executionKey: registration.executionKey,
          manager,
        });
      } else {
        logProgressFailure(this.#log, task.taskId, "register", "progress_registration_rejected");
      }
    } catch {
      logProgressFailure(this.#log, task.taskId, "register", "progress_register_failed");
    }
  }

  #finishProgress(task, { cancelled = false } = {}) {
    const registration = this.#progressExecutions.get(task.taskId);
    this.#progressExecutions.delete(task.taskId);
    if (!registration) return;
    try {
      // 取消路径走进度桥的取消语义（拒绝迟到、丢弃未发起队列），且不发送成功/失败
      // 类消息；正常完成仍走 finish。
      const operation = cancelled && typeof registration.manager.cancel === "function"
        ? registration.manager.cancel
        : registration.manager.finish;
      void Promise.resolve(operation.call(registration.manager, registration.executionKey)).catch(() =>
        logProgressFailure(this.#log, task.taskId, "finish", "progress_finish_failed"));
    } catch {
      logProgressFailure(this.#log, task.taskId, "finish", "progress_finish_failed");
    }
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

  #record(task, required = false) {
    try {
      const envelope = nextTaskRecord(task, this.#now().toISOString());
      task.stateRevision = envelope.stateRevision;
      appendTaskStateRecord(this.#stateFile, this.#persistedRecordFor(task));
      this.#compactStateWhenDue();
    } catch (error) {
      this.#log(`[muad-runtime-guard][longtask-state] write failed taskId=${task.taskId} reason=state_unavailable`);
      if (required) throw new Error("long task state unavailable", { cause: error });
    }
    if (!required) this.#notifyChange();
  }

  // state 文件的完整记录包络：publicTask + 仅落盘的执行输入 + childPid（不进 console
  // 快照契约，供下次启动的孤儿检测）。patch 用于取消流程按状态模块生成的记录整包写入，
  // 避免 nextTaskRecord 二次递增 revision。
  #persistedRecordFor(task, patch = {}) {
    const view = patch && Object.keys(patch).length > 0 ? { ...task, ...patch } : task;
    return {
      ...publicTask(view),
      ...(view.executionInputs === undefined ? {} : {
        executionInputs: view.executionInputs,
        objective: view.objective,
        originalPrompt: view.originalPrompt,
      }),
      ...(Number.isInteger(view.childPid) ? { childPid: view.childPid } : {}),
    };
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
    compactTaskStateFile(this.#stateFile, this.#now, this.terminalRetentionMs);
  }

  #loadInterruptedTasks() {
    const now = this.#now().toISOString();
    let recovered = 0;
    let tombstones = 0;
    for (const record of readActiveTaskRecords(this.#stateFile)) {
      const { record: task, changed } = recoverInterruptedRecord(record, {
        now,
        childAlive: childStillRunning(record.childPid),
      });
      if (!task) continue;
      if (changed) {
        // 恢复即终态：立即把 queued/running 升级后的 failed 落盘（与终端任务同一
        // retention），否则每次重启都会重复恢复同一批记录。revision 已由
        // recoverInterruptedRecord 递增，这里按记录原样追加，不再二次递增。
        appendTaskStateRecord(this.#stateFile, task);
        recovered += 1;
      } else if (task.status === "cancelling") {
        // 取消墓碑：保留在状态文件与快照中，不重新执行，也不猜测已经停止。
        tombstones += 1;
      }
      const pool = this.#pool(task);
      pool.terminal.push(task);
    }
    if (recovered > 0) this.#log(`[muad-runtime-guard] long task restored ${recovered} interrupted task(s)`);
    if (tombstones > 0) this.#log(`[muad-runtime-guard] long task kept ${tombstones} cancelling tombstone(s)`);
  }
}

export async function spawnOpenClawTask(task, options = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "muad-long-task-"));
  const messageFile = path.join(tempRoot, "message.txt");
  try {
    await writeFile(messageFile, longTaskMessage(task), { mode: 0o600 });
    return await runOpenClawAgent(task, messageFile, options);
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
    "--reply-channel", task.replyChannel,
    "--reply-to", task.peerId,
    "--json",
    "--timeout", String(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
  ];
  const watchdogMs = positiveInteger(options.watchdogMs)
    ? options.watchdogMs
    : (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve, reject) => {
    // stdout 持续消费：结果 JSON 由父进程解析并在取消仲裁后由 manager 投递（不再
    // 传 --deliver）；管道必须有人读，否则 64KB 写满即永久阻塞、exit 永不触发、
    // 并发槽泄漏。捕获缓冲有上限（超限按不可解析处理，仍持续消费不阻塞）；stderr
    // 仅作错误诊断收集，同样设上限防止无限增长。
    // detached：CLI 成为自有进程组组长，取消/看门狗只对本 Worker 归属的组补发终止
    // （原生 abort/drain 完成后仍以真实退出为准，组信号本身不是停止确认）。
    const child = (options.spawn ?? spawn)("openclaw", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    try {
      options.onChild?.(child);
    } catch {
      // 归属绑定失败不阻断任务执行；controller 缺失时取消能力按不可用处理。
    }
    let settled = false;
    let stderr = "";
    let stdout = "";
    let stdoutBytes = 0;
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes <= MAX_RESULT_BYTES) stdout += text;
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 4096); });
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // child already gone; reject below is authoritative
      }
      // 自有进程组内的残留子孙一并清理（best effort；超时以 reject 表达，不代表已停止）。
      if (Number.isInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
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
      if (code !== 0) {
        settle(() => reject(new LongTaskRunError(code, stderr.trim())))();
        return;
      }
      const parsed = parseAgentResultPayloads(stdout);
      if (!parsed.ok) {
        // 结果不可解析意味着没有任何结果会被投递：显式失败（fail loud），不静默成功。
        const error = new LongTaskRunError(0, `openclaw agent result could not be parsed (${parsed.reason})`);
        error.code = "longtask.result_unparsable";
        settle(() => reject(error))();
        return;
      }
      settle(resolve)({ payloads: parsed.payloads });
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

${executionInputMessage(task)}

Read and follow the real Skill instructions at:
${path.join(task.skillRoot, "SKILL.md")}

Do not start this task by sending or expanding /skill:${task.skillName}. Execute the Skill instructions directly in this task session, then deliver the final result.
${resultPrefix}`;
}

function executionInputMessage(task) {
  if (task.executionInputs === undefined) return "";
  return `Inputs resolved before submission (JSON):
${JSON.stringify(task.executionInputs)}

Resolved bindings are the authoritative execution inputs, including bindings with source document_resolution.
Original user request is historical context; it does not mean a bound parameter is still missing.
Do not repeat name-to-ID lookups or other input-resolution steps for parameters already present in bindings, even when the Skill documents a lookup for requests containing only a name.
Execute the documented business invocation directly with these bindings.
Do not guess customer IDs, substitute customer names for IDs, change inputs, or choose another Skill.
If a required input is still missing or unclear, report the missing input and stop; do not probe alternative values or retry with invented parameters.`;
}

export class LongTaskRunError extends Error {
  constructor(code, stderr) {
    super(stderr || `openclaw agent exited with code ${code}`);
    this.name = "LongTaskRunError";
    this.code = classifyRunError(code, stderr);
    this.exitCode = code;
  }
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
    stateRevision: Number.isInteger(task.stateRevision) && task.stateRevision > 0 ? task.stateRevision : 0,
    cancelRequestedAt: textValue(task.cancelRequestedAt),
    cancelRequestedBy: textValue(task.cancelRequestedBy),
    cancelledAt: textValue(task.cancelledAt),
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

function isProgressManager(manager) {
  return typeof manager?.registerBackground === "function" && typeof manager?.finish === "function";
}

function isRunController(controller) {
  return typeof controller?.bind === "function" && typeof controller?.cancel === "function" &&
    typeof controller?.release === "function";
}

function logProgressFailure(log, taskId, action, reason) {
  try {
    log(`[muad-runtime-guard][skill-progress] task=${taskId} kind=background action=${action} outcome=failed reason=${reason}`);
  } catch {
    // Progress diagnostics are best-effort and cannot alter task state.
  }
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

// 默认失败通知：走共享 notifyUser 能力，构造用户友好的简化文案。
// 失败原因按 errorCode 简化为稳定中文文案；同时附带一段截取后的真实错误信息
// （task.terminalReason 来自 agent 子进程 stderr，openclaw 已对 apiKey 等敏感
// 字段脱敏），帮助用户定位。完整 reason/code 仍落盘 console 供排查。
function defaultNotifyFailure(task, code) {
  const text = failureText(task, code);
  return notifyUser({
    channel: task.replyChannel,
    peerId: task.peerId,
    text,
  });
}

export function failureText(task, code) {
  const reason = failureReason(code, task.locale);
  const idLine = taskIdLine(task.locale, task.taskId);
  const detail = truncateErrorDetail(task.terminalReason);
  const separator = localeSeparator(task.locale);
  const lines = [
    idLine,
    `${failureSubject(task.locale)}${separator}${task.skillName}`,
    `${failureReasonLabel(task.locale)}${separator}${reason}`,
    detail ? `${errorDetailLabel(task.locale)}${separator}${detail}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// 真实错误信息截取：压平换行、合并空白，超过上限截断并加省略号。
// 上限取 240 字符，既保留定位所需的关键片段（错误类型 + 状态码 + 脱敏后的
// 提示），又不把整段堆栈刷进 IM。
const MAX_ERROR_DETAIL_CHARS = 240;

function truncateErrorDetail(value) {
  const text = textValue(value);
  if (!text) return "";
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= MAX_ERROR_DETAIL_CHARS) return flat;
  return `${flat.slice(0, MAX_ERROR_DETAIL_CHARS)}…`;
}

function failureReason(code, locale) {
  const en = normalizedLocale(locale) === "en";
  switch (code) {
    case "longtask.timeout":
      return en ? "Timed out" : "执行超时";
    case "long_task_spawn_failed":
      return en ? "Task failed to start" : "任务启动失败";
    default:
      return en ? "Execution failed" : "执行失败";
  }
}

function failureSubject(locale) {
  return normalizedLocale(locale) === "en" ? "Task failed" : "任务失败";
}

function failureReasonLabel(locale) {
  return normalizedLocale(locale) === "en" ? "Reason" : "失败原因";
}

function errorDetailLabel(locale) {
  return normalizedLocale(locale) === "en" ? "Error" : "错误信息";
}

function localeSeparator(locale) {
  return normalizedLocale(locale) === "en" ? ": " : "：";
}

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedLocale(value) {
  return textValue(value).toLowerCase() === "en" ? "en" : "zh";
}

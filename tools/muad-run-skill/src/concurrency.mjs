import { SharedLeaseQueue, SharedQueueBusyError } from "../../runtime-concurrency/shared-lease-queue.mjs";

const SHARED_SKILL_QUEUE_DIRECTORY = "/tmp/muad-runtime-queues/skill";

export class SkillBusyError extends Error {
  constructor() {
    super("skill runner is busy; retry later");
    this.name = "SkillBusyError";
    this.code = "skill_busy";
  }
}

export class SharedSkillQueue {
  #queue;

  constructor(options) {
    this.#queue = new SharedLeaseQueue({
      ...options,
      directory: options.directory ?? SHARED_SKILL_QUEUE_DIRECTORY,
    });
  }

  async acquire(signal) {
    try {
      return await this.#queue.acquire({ signal });
    } catch (error) {
      if (error instanceof SharedQueueBusyError) throw new SkillBusyError();
      throw error;
    }
  }

  snapshot() {
    return this.#queue.snapshot();
  }

  close() {
    this.#queue.close();
  }
}

export class BoundedSkillQueue {
  #active = 0;
  #waiters = [];

  constructor({ limit, waitTimeoutMs = 30_000, maxQueue = limit * 10 }) {
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(waitTimeoutMs) ||
      waitTimeoutMs <= 0 || !Number.isInteger(maxQueue) || maxQueue <= 0) {
      throw new Error("invalid skill concurrency configuration");
    }
    this.limit = limit;
    this.waitTimeoutMs = waitTimeoutMs;
    this.maxQueue = maxQueue;
  }

  async acquire(signal) {
    if (signal?.aborted) throw abortError(signal);
    if (this.#active < this.limit) return this.#grant();
    if (this.#waiters.length >= this.maxQueue) throw new SkillBusyError();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: undefined, onAbort: undefined };
      waiter.timer = setTimeout(() => this.#rejectWaiter(waiter, new SkillBusyError()), this.waitTimeoutMs);
      waiter.onAbort = () => this.#rejectWaiter(waiter, abortError(signal));
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  snapshot() {
    return { active: this.#active, queued: this.#waiters.length, limit: this.limit };
  }

  #grant() {
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.#active < this.limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      this.#cleanup(waiter);
      waiter.resolve(this.#grant());
    }
  }

  #rejectWaiter(waiter, error) {
    const index = this.#waiters.indexOf(waiter);
    if (index < 0) return;
    this.#waiters.splice(index, 1);
    this.#cleanup(waiter);
    waiter.reject(error);
  }

  #cleanup(waiter) {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("skill execution aborted");
}

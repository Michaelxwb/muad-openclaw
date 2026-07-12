import { SharedLeaseQueue, SharedQueueBusyError } from "../../runtime-concurrency/shared-lease-queue.mjs";

const SHARED_BROWSER_QUEUE_DIRECTORY = "/tmp/muad-runtime-queues/browser";

export class BrowserBusyError extends Error {
  constructor(message = "browser concurrency limit reached") {
    super(message);
    this.name = "BrowserBusyError";
    this.code = "browser_busy";
  }
}

export class SharedBrowserLeaseManager {
  #queue;
  #pending = new Set();
  #releases = new Map();

  constructor(options) {
    this.#queue = new SharedLeaseQueue({
      ...options,
      directory: options.directory ?? SHARED_BROWSER_QUEUE_DIRECTORY,
    });
    this.limit = options.limit;
    this.shared = true;
    this.closed = false;
  }

  async acquire(key) {
    const normalized = normalizeKey(key);
    if (this.#pending.has(normalized) || this.#releases.has(normalized)) {
      throw new BrowserBusyError("duplicate browser tool call");
    }
    this.#pending.add(normalized);
    try {
      const release = await this.#queue.acquire({ key: normalized });
      this.#releases.set(normalized, release);
      return normalized;
    } catch (error) {
      if (error instanceof SharedQueueBusyError) throw new BrowserBusyError();
      throw error;
    } finally {
      this.#pending.delete(normalized);
    }
  }

  async release(key) {
    const normalized = optionalKey(key);
    const release = normalized ? this.#releases.get(normalized) : undefined;
    if (!release) return false;
    this.#releases.delete(normalized);
    await release();
    return true;
  }

  snapshot() {
    return this.#queue.snapshot();
  }

  close() {
    this.closed = true;
    this.#queue.close();
    this.#pending.clear();
    this.#releases.clear();
  }
}

export class BrowserLeaseManager {
  #active = new Map();
  #waiters = [];
  #watchdog;

  constructor(options) {
    const { limit, waitTimeoutMs = 30_000, leaseTtlMs = 300_000,
      watchdogIntervalMs = 5_000, maxQueue = limit * 10 } = options;
    if (![limit, waitTimeoutMs, leaseTtlMs, watchdogIntervalMs, maxQueue]
      .every((value) => Number.isInteger(value) && value > 0)) {
      throw new Error("invalid browser lease configuration");
    }
    this.limit = limit;
    this.waitTimeoutMs = waitTimeoutMs;
    this.leaseTtlMs = leaseTtlMs;
    this.maxQueue = maxQueue;
    this.now = options.now ?? Date.now;
    if (options.autoStart !== false) this.#startWatchdog(watchdogIntervalMs, options.setIntervalFn);
  }

  async acquire(key, metadata = {}) {
    const normalized = normalizeKey(key);
    this.sweep();
    if (this.#active.has(normalized) || this.#waiters.some((item) => item.key === normalized)) {
      throw new BrowserBusyError("duplicate browser tool call");
    }
    if (this.#active.size < this.limit) return this.#grant(normalized, metadata);
    if (this.#waiters.length >= this.maxQueue) throw new BrowserBusyError();
    return new Promise((resolve, reject) => this.#enqueue({
      key: normalized, metadata, resolve, reject,
    }));
  }

  release(key) {
    const normalized = optionalKey(key);
    if (!normalized || !this.#active.delete(normalized)) return false;
    this.#drain();
    return true;
  }

  sweep(at = this.now()) {
    let expired = 0;
    for (const [key, lease] of this.#active) {
      if (lease.expiresAt > at) continue;
      this.#active.delete(key);
      expired += 1;
    }
    if (expired > 0) this.#drain();
    return expired;
  }

  snapshot() {
    return { active: this.#active.size, queued: this.#waiters.length, limit: this.limit };
  }

  close() {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    const error = new BrowserBusyError("browser lease manager stopped");
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#active.clear();
  }

  #grant(key, metadata) {
    this.#active.set(key, {
      metadata: { ...metadata },
      expiresAt: this.now() + this.leaseTtlMs,
    });
    return key;
  }

  #enqueue(waiter) {
    waiter.timer = setTimeout(() => {
      const index = this.#waiters.indexOf(waiter);
      if (index < 0) return;
      this.#waiters.splice(index, 1);
      waiter.reject(new BrowserBusyError());
    }, this.waitTimeoutMs);
    waiter.timer.unref?.();
    this.#waiters.push(waiter);
  }

  #drain() {
    while (this.#active.size < this.limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(this.#grant(waiter.key, waiter.metadata));
    }
  }

  #startWatchdog(intervalMs, setIntervalFn = setInterval) {
    this.#watchdog = setIntervalFn(() => this.sweep(), intervalMs);
    this.#watchdog?.unref?.();
  }
}

function normalizeKey(value) {
  const key = optionalKey(value);
  if (!key) throw new Error("browser lease key is required");
  return key;
}

function optionalKey(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

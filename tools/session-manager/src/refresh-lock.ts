import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";

import {
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_WAIT_MS,
} from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";

type LockRecord = {
  token: string;
  pid: number;
  startedAt: string;
};

export type RefreshLockOptions = {
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

export class RefreshLock {
  readonly #path: string;
  readonly #waitMs: number;
  readonly #staleMs: number;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #sleep: (durationMs: number) => Promise<void>;

  constructor(path: string, options: RefreshLockOptions = {}) {
    this.#path = path;
    this.#waitMs = positive(options.waitMs, DEFAULT_LOCK_WAIT_MS);
    this.#staleMs = positive(options.staleMs, DEFAULT_LOCK_STALE_MS);
    this.#pollMs = positive(options.pollMs, DEFAULT_LOCK_POLL_MS);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  async run<T>(readReady: () => Promise<T | null>, refresh: () => Promise<T>): Promise<T> {
    const deadline = this.#now() + this.#waitMs;
    while (true) {
      const token = await this.#tryAcquire();
      if (token) return this.#runOwned(token, readReady, refresh);
      if (await this.#reclaimStale()) continue;
      const ready = await readReady();
      if (ready !== null) return ready;
      const remaining = deadline - this.#now();
      if (remaining <= 0) throw new SessionManagerError("adapter_failed", true);
      await this.#sleep(Math.min(this.#pollMs, remaining));
    }
  }

  async #runOwned<T>(
    token: string,
    readReady: () => Promise<T | null>,
    refresh: () => Promise<T>,
  ): Promise<T> {
    try {
      const ready = await readReady();
      return ready ?? await refresh();
    } finally {
      await this.#release(token);
    }
  }

  async #tryAcquire(): Promise<string | null> {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#path, "wx", 0o600);
      const record: LockRecord = { token, pid: process.pid, startedAt: new Date(this.#now()).toISOString() };
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
      return token;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return null;
      if (handle) await rm(this.#path, { force: true });
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async #reclaimStale(): Promise<boolean> {
    let snapshot: string;
    try {
      snapshot = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
    if (!await this.#isStale(snapshot)) return false;
    const current = await readCurrent(this.#path);
    if (current !== snapshot) return false;
    await rm(this.#path, { force: true });
    return true;
  }

  async #isStale(snapshot: string): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(snapshot);
      if (isRecord(value) && typeof value.startedAt === "string") {
        const startedAt = Date.parse(value.startedAt);
        if (Number.isFinite(startedAt)) return this.#now() - startedAt >= this.#staleMs;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const details = await stat(this.#path);
    return this.#now() - details.mtimeMs >= this.#staleMs;
  }

  async #release(token: string): Promise<void> {
    const current = await readCurrent(this.#path);
    if (current === null) return;
    try {
      const value: unknown = JSON.parse(current);
      if (isRecord(value) && value.token === token) await rm(this.#path, { force: true });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
}

async function readCurrent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

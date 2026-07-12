import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export class SharedQueueBusyError extends Error {
  constructor(message = "shared concurrency limit reached") {
    super(message);
    this.name = "SharedQueueBusyError";
  }
}

export class SharedLeaseQueue {
  #options;
  #closed = false;
  #localReleases = new Set();

  constructor(options) {
    this.#options = normalizeOptions(options);
  }

  async acquire({ key = "", signal } = {}) {
    if (this.#closed) throw new SharedQueueBusyError("shared concurrency queue stopped");
    throwIfAborted(signal);
    const record = leaseRecord(key);
    await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
    await sweepStale(this.#options);
    const active = await claimSlot(this.#options, "active", this.#options.limit, record);
    if (active) return this.#lease(active, record.owner);
    const waiter = await claimSlot(this.#options, "wait", this.#options.maxQueue, record);
    if (!waiter) throw new SharedQueueBusyError();
    try {
      return await this.#waitForLease(waiter, record, signal);
    } finally {
      await removeOwned(waiter, record.owner);
    }
  }

  snapshot() {
    return snapshotDirectory(this.#options);
  }

  close() {
    this.#closed = true;
    for (const release of [...this.#localReleases]) {
      void release().catch((error) => reportCleanupError("release", error));
    }
  }

  async #waitForLease(waiter, record, signal) {
    const deadline = Date.now() + this.#options.waitTimeoutMs;
    while (!this.#closed && Date.now() < deadline) {
      await delay(this.#options.pollMs, signal);
      await sweepStale(this.#options);
      const active = await claimSlot(this.#options, "active", this.#options.limit, record);
      if (active) {
        await removeOwned(waiter, record.owner);
        return this.#lease(active, record.owner);
      }
    }
    throw new SharedQueueBusyError();
  }

  #lease(slot, owner) {
    const timer = setInterval(() => {
      void touchOwned(slot, owner).catch((error) => reportCleanupError("heartbeat", error));
    }, this.#options.heartbeatMs);
    timer.unref?.();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      this.#localReleases.delete(release);
      await removeOwned(slot, owner);
    };
    this.#localReleases.add(release);
    return release;
  }
}

function normalizeOptions(options) {
  const values = {
    directory: String(options?.directory ?? "").trim(),
    limit: options?.limit,
    waitTimeoutMs: options?.waitTimeoutMs ?? 30_000,
    maxQueue: options?.maxQueue ?? Number(options?.limit) * 10,
    pollMs: options?.pollMs ?? 50,
    leaseTtlMs: options?.leaseTtlMs ?? 10 * 60_000,
    heartbeatMs: options?.heartbeatMs ?? 2_000,
  };
  const numbers = [values.limit, values.waitTimeoutMs, values.maxQueue, values.pollMs,
    values.leaseTtlMs, values.heartbeatMs];
  if (!path.isAbsolute(values.directory) || !numbers.every(positiveInteger) ||
    values.heartbeatMs >= values.leaseTtlMs) {
    throw new Error("invalid shared concurrency configuration");
  }
  return values;
}

function leaseRecord(key) {
  const normalized = typeof key === "string" ? key : "";
  return {
    owner: randomUUID(),
    keyHash: createHash("sha256").update(normalized || randomUUID()).digest("hex"),
    createdAt: new Date().toISOString(),
  };
}

async function claimSlot(options, kind, count, record) {
  for (let index = 0; index < count; index += 1) {
    const file = slotPath(options.directory, kind, index);
    try {
      await writeFile(file, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  return "";
}

async function sweepStale(options) {
  let names;
  try {
    names = await readdir(options.directory);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    const kind = slotKind(name);
    if (!kind) return;
    const file = path.join(options.directory, name);
    const ttl = kind === "active" ? options.leaseTtlMs : options.waitTimeoutMs + options.pollMs * 4;
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > ttl) await unlink(file);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }));
}

function snapshotDirectory(options) {
  let names;
  try {
    names = readdirSync(options.directory);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { active: 0, queued: 0, limit: options.limit };
    throw error;
  }
  const active = countFresh(names, options, "active", options.leaseTtlMs);
  const waitTtl = options.waitTimeoutMs + options.pollMs * 4;
  const queued = countFresh(names, options, "wait", waitTtl);
  return { active, queued, limit: options.limit };
}

function countFresh(names, options, kind, ttl) {
  let count = 0;
  for (const name of names) {
    if (!name.startsWith(`${kind}-`) || !name.endsWith(".json")) continue;
    try {
      if (Date.now() - statSync(path.join(options.directory, name)).mtimeMs <= ttl) count += 1;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  return count;
}

async function touchOwned(file, owner) {
  try {
    if (await readOwner(file) !== owner) return;
    const now = new Date();
    await utimes(file, now, now);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function removeOwned(file, owner) {
  try {
    if (await readOwner(file) === owner) await unlink(file);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function readOwner(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  return typeof value?.owner === "string" ? value.owner : "";
}

function delay(durationMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, durationMs);
    const abort = () => done(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function slotPath(directory, kind, index) {
  return path.join(directory, `${kind}-${index}.json`);
}

function slotKind(name) {
  if (/^active-\d+\.json$/u.test(name)) return "active";
  if (/^wait-\d+\.json$/u.test(name)) return "wait";
  return "";
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

function reportCleanupError(action, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[muad-concurrency] ${action} failed: ${message}`);
}

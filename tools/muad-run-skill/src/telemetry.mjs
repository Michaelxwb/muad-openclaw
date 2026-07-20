import { readFile } from "node:fs/promises";
import path from "node:path";

import { redactText } from "./hook-lifecycle.mjs";
import { SkillTelemetryOutbox } from "./outbox.mjs";

const REPORT_PATH = "/internal/v1/skill-executions";
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRY_INTERVAL_MS = 15_000;

export function createSkillTelemetryClient(options) {
  return new SkillTelemetryClient(options);
}

export function createSkillExecutionReporter(options) {
  const client = createSkillTelemetryClient(options);
  const reporter = client.createReporter({ execution: options.execution });
  return {
    report: reporter.report,
    flush: () => client.flush(),
    close: () => client.close(),
    snapshot: () => client.snapshot(),
  };
}

class SkillTelemetryClient {
  constructor(options = {}) {
    this.root = normalizeInternalRoot(options.consoleInternalURL);
    this.tokenPath = stringValue(options.serviceTokenFile);
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.readFile = options.readFileImpl ?? readFile;
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxQueueItems = positiveInteger(options.maxQueueItems, 256);
    this.logger = options.logger ?? console;
    this.queue = [];
    this.spillTail = Promise.resolve();
    this.spillPending = 0;
    this.outboxPending = 0;
    this.writeFailed = false;
    this.dropped = 0;
    this.lastError = "";
    this.closed = false;
    this.outbox = createOutbox(options);
    this.retryIntervalMs = positiveInteger(options.retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
    this.timer = setInterval(() => this.schedule(), this.retryIntervalMs);
    this.timer.unref?.();
    this.schedule();
  }

  createReporter({ execution }) {
    const base = sanitizeValue(execution);
    return {
      report: (update) => this.enqueue({ ...base, ...sanitizeValue(update) }),
    };
  }

  enqueue(event) {
    if (!this.transportConfigured() || this.closed) return false;
    if (this.queue.length >= this.maxQueueItems) {
      this.log("warn", "telemetry_queue_spill", this.queue.length);
      return this.spill(event);
    }
    this.queue.push(event);
    this.schedule();
    return true;
  }

  schedule() {
    if (this.closed || this.drainPromise) return this.drainPromise;
    this.drainPromise = Promise.resolve()
      .then(() => this.drain())
      .catch((error) => this.markWriteFailure(errorCode(error)))
      .finally(() => {
        this.drainPromise = null;
        if (this.queue.length > 0 && !this.closed) this.schedule();
      });
    return this.drainPromise;
  }

  async flush() {
    do {
      await this.spillTail;
      const pending = this.schedule();
      if (pending) await pending;
    } while (this.drainPromise || this.queue.length > 0 || this.spillPending > 0);
  }

  async close() {
    if (this.closed) return;
    clearInterval(this.timer);
    await this.flush();
    this.closed = true;
  }

  snapshot() {
    return {
      pending: this.queue.length + this.outboxPending + this.spillPending,
      writeFailed: this.writeFailed,
      dropped: this.dropped,
      lastError: this.lastError,
    };
  }

  async drain() {
    const remoteFailed = await this.drainQueue();
    if (!remoteFailed) await this.replayOutbox();
  }

  async drainQueue() {
    let remoteFailed = false;
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      if (!remoteFailed && await this.send(event)) continue;
      remoteFailed = true;
      await this.persist(event);
    }
    return remoteFailed;
  }

  async replayOutbox() {
    if (!this.outbox) return;
    const loaded = await this.outbox.load();
    this.outboxPending = loaded.events.length;
    if (loaded.corruptCount > 0) this.log("error", "outbox_corrupt_records", loaded.corruptCount);
    let sent = 0;
    for (const event of loaded.events) {
      if (!await this.send(event)) break;
      sent += 1;
    }
    if (sent > 0) await this.outbox.replace(loaded.events.slice(sent));
    this.outboxPending = loaded.events.length - sent;
  }

  async persist(event) {
    if (!this.outbox) {
      this.markWriteFailure("outbox_not_configured");
      return false;
    }
    try {
      await this.outbox.append(event);
      this.outboxPending += 1;
      this.log("warn", "skill_telemetry_outbox_pending", this.outboxPending);
      return true;
    } catch (error) {
      this.markWriteFailure(errorCode(error));
      return false;
    }
  }

  spill(event) {
    this.spillPending += 1;
    const result = this.spillTail.then(() => this.persist(event));
    this.spillTail = result.then(
      () => { this.spillPending -= 1; },
      () => { this.spillPending -= 1; },
    );
    return result;
  }

  async send(event) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.reportURL(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!response.ok) this.log("warn", "telemetry_send_failed", `http_${response.status ?? 0}`);
      return response.ok;
    } catch (error) {
      this.log("warn", "telemetry_send_failed", errorCode(error));
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async token() {
    // Always re-read so projected/rotated service tokens stay valid.
    try {
      return String(await this.readFile(this.tokenPath, "utf8")).trim();
    } catch (error) {
      this.tokenPromise = null;
      throw error;
    }
  }

  transportConfigured() {
    return Boolean(this.root && this.tokenPath && typeof this.fetch === "function");
  }

  reportURL() {
    return this.root + REPORT_PATH.replace("/internal/v1", "");
  }

  markWriteFailure(code) {
    this.writeFailed = true;
    this.dropped += 1;
    this.lastError = code;
    this.log("error", "skill_telemetry_outbox_write_failed", code);
  }

  log(level, event, detail) {
    this.logger[level]?.(`[muad-run-skill] ${JSON.stringify({ event, detail })}`);
  }
}

export function progressSummary(event) {
  return [{
    type: String(event?.type ?? "").slice(0, 32),
    stage: String(event?.stage ?? "").slice(0, 80),
    text: redactText(String(event?.text ?? "")).slice(0, 256),
    ts: String(event?.ts ?? new Date().toISOString()).slice(0, 64),
  }];
}

function createOutbox(options) {
  const filePath = stringValue(options.outboxPath);
  if (!filePath) return null;
  if (!path.isAbsolute(filePath)) return null;
  return new SkillTelemetryOutbox({
    filePath, maxBytes: positiveInteger(options.maxOutboxBytes, 5 * 1024 * 1024),
  });
}

function sanitizeValue(value, depth = 0) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, sanitizeValue(child, depth + 1)]));
}

function normalizeInternalRoot(value) {
  const root = stringValue(value).replace(/\/+$/u, "");
  if (!root) return "";
  return root.endsWith("/internal/v1") ? root : `${root}/internal/v1`;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return normalizeErrorCode(error.code);
  }
  return error?.name === "AbortError" ? "telemetry_timeout" : "telemetry_error";
}

function normalizeErrorCode(value) {
  const code = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/u.test(code) ? code : "telemetry_error";
}

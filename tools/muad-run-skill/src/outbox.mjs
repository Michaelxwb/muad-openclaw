import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class OutboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
  }
}

export class SkillTelemetryOutbox {
  constructor({ filePath, maxBytes, fsImpl = fs }) {
    if (!path.isAbsolute(filePath) || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new OutboxError("outbox_invalid_config", "invalid telemetry outbox configuration");
    }
    this.filePath = path.resolve(filePath);
    this.maxBytes = maxBytes;
    this.fs = fsImpl;
    this.tail = Promise.resolve();
  }

  append(payload) {
    return this.exclusive(() => this.appendUnlocked(payload));
  }

  load() {
    return this.exclusive(() => this.loadUnlocked());
  }

  replace(events) {
    return this.exclusive(() => this.replaceUnlocked(events));
  }

  exclusive(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async appendUnlocked(payload) {
    const line = encodeLine(payload);
    await this.ensureParent();
    const currentSize = await fileSize(this.fs, this.filePath);
    if (currentSize + Buffer.byteLength(line) > this.maxBytes) {
      throw new OutboxError("outbox_capacity_exceeded", "telemetry outbox capacity exceeded");
    }
    await this.fs.appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
  }

  async loadUnlocked() {
    const raw = await readOptional(this.fs, this.filePath);
    if (!raw) return { events: [], corruptCount: 0 };
    const valid = [];
    const corrupt = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      const payload = decodeLine(line);
      if (payload) valid.push(payload);
      else corrupt.push(line);
    }
    const events = deduplicateAndSort(valid);
    if (corrupt.length > 0) await this.isolateCorrupt(events, corrupt);
    return { events, corruptCount: corrupt.length };
  }

  async isolateCorrupt(events, corrupt) {
    await this.ensureParent();
    await this.fs.appendFile(`${this.filePath}.corrupt`, `${corrupt.join("\n")}\n`, {
      encoding: "utf8", mode: 0o600,
    });
    await this.replaceUnlocked(events);
  }

  async replaceUnlocked(events) {
    const unique = deduplicateAndSort(events);
    if (unique.length === 0) {
      await removeOptional(this.fs, this.filePath);
      return;
    }
    const content = unique.map(encodeLine).join("");
    if (Buffer.byteLength(content) > this.maxBytes) {
      throw new OutboxError("outbox_capacity_exceeded", "telemetry outbox capacity exceeded");
    }
    await this.ensureParent();
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await this.fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await this.fs.rename(temporary, this.filePath);
    } finally {
      await removeOptional(this.fs, temporary);
    }
  }

  ensureParent() {
    return this.fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }
}

function encodeLine(payload) {
  const serialized = JSON.stringify(payload);
  return `${JSON.stringify({ checksum: checksum(serialized), payload })}\n`;
}

function decodeLine(line) {
  try {
    const envelope = JSON.parse(line);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    const serialized = JSON.stringify(envelope.payload);
    return envelope.checksum === checksum(serialized) ? envelope.payload : null;
  } catch {
    return null;
  }
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deduplicateAndSort(events) {
  const unique = new Map();
  for (const event of events) unique.set(eventKey(event), event);
  return [...unique.values()].sort(compareEvents);
}

function eventKey(event) {
  return `${String(event?.executionId ?? "")}:${Number(event?.eventSeq ?? 0)}`;
}

function compareEvents(left, right) {
  const executionOrder = String(left?.executionId ?? "").localeCompare(String(right?.executionId ?? ""));
  return executionOrder || Number(left?.eventSeq ?? 0) - Number(right?.eventSeq ?? 0);
}

async function readOptional(fsImpl, filePath) {
  try {
    return await fsImpl.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function fileSize(fsImpl, filePath) {
  try {
    return (await fsImpl.stat(filePath)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function removeOptional(fsImpl, filePath) {
  try {
    await fsImpl.rm(filePath, { force: true });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

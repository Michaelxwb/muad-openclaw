import { closeSync, constants, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { ProgressEvent } from "./protocol.js";

export type Delivery = "written" | "skipped";

export function appendEvent(eventsFile: string | undefined, event: ProgressEvent): Delivery {
  if (eventsFile === undefined || eventsFile.trim() === "" || !isAbsolute(eventsFile)) {
    return "skipped";
  }
  const payload = `${JSON.stringify(event)}\n`;
  let descriptor: number | undefined;
  let delivery: Delivery = "skipped";
  try {
    descriptor = openSync(eventsFile, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    const bytes = writeSync(descriptor, payload, undefined, "utf8");
    delivery = bytes === Buffer.byteLength(payload) ? "written" : "skipped";
  } catch {
    delivery = "skipped";
  }
  if (descriptor !== undefined && !closeDescriptor(descriptor)) return "skipped";
  return delivery;
}

function closeDescriptor(descriptor: number): boolean {
  try {
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

import { isAbsolute } from "node:path";

import { ProgressError } from "./errors.js";

export const MAX_TEXT_CHARACTERS = 1000;
export const MAX_RAW_DONE_TEXT_CHARACTERS = 50_000;
export const MAX_MEDIA_ITEMS = 10;
export const MAX_MEDIA_PATH_CHARACTERS = 2048;
export const MAX_ID_CHARACTERS = 80;
export const MAX_CODE_CHARACTERS = 80;
export const MAX_SKILL_CHARACTERS = 128;

const STAGE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EVENT_KEYS = new Set([
  "type", "skill", "stage", "text", "id", "code", "visibility", "privacy", "ts", "raw", "media",
]);

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:cookie|set-cookie|authorization|token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|ak|sk)\b\s*[:=]/iu,
  /\bauthorization\b\s*:?[ \t]*bearer\b/iu,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu,
  /https?:\/\/(?:localhost|\[?::1\]?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?=[:/\s]|$)/iu,
  /https?:\/\/(?:[a-z0-9-]+|[a-z0-9.-]+\.(?:internal|local|svc|svc\.cluster\.local))(?=[:/\s]|$)/iu,
  /\bselect\s+[\s\S]+?\s+from\b/iu,
  /\b(?:insert\s+into|update\s+[\s\S]+?\s+set|delete\s+from|(?:alter|create|drop|truncate)\s+table)\b/iu,
  /\bat\s+(?:[\w$.<>]+\s+\()?[^\s()]+:\d+(?::\d+)?\)?/iu,
  /\bfile\s+"[^"]+",\s+line\s+\d+/iu,
];

// type="log" 为 CLI 诊断事件（仅落 openclaw 日志，不投递 IM），与 guard 侧
// skill-progress-policy.mjs 的合法类型集合保持一致。
export type ProgressEventType = "progress" | "done" | "error" | "log";

export type ProgressEvent = {
  type: ProgressEventType;
  stage: string;
  text: string;
  visibility: "channel";
  privacy: "public";
  ts: string;
  skill?: string;
  id?: string;
  code?: string;
  raw?: true;
  media?: string[];
};

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function containsSensitiveContent(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

export function validateEvent(input: unknown): ProgressEvent {
  const record = requireEventRecord(input);
  const fields = readEventFields(record);
  rejectSensitiveFields(fields);
  validateRequiredFields(fields);
  validateOptionalFields(fields);
  return fields;
}

function requireEventRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !EVENT_KEYS.has(key))) fail();
  return record;
}

function readEventFields(record: Record<string, unknown>): ProgressEvent {
  const type = requireString(record.type) as ProgressEventType;
  const stage = requireString(record.stage);
  const text = requireString(record.text);
  const visibility = requireString(record.visibility) as "channel";
  const privacy = requireString(record.privacy) as "public";
  const ts = requireString(record.ts);
  return {
    type, stage, text, visibility, privacy, ts,
    ...optionalString(record, "skill"),
    ...optionalString(record, "id"),
    ...optionalString(record, "code"),
    ...optionalRaw(record),
    ...optionalMedia(record),
  };
}

function optionalRaw(record: Record<string, unknown>): object {
  if (record.raw === undefined) return {};
  if (record.raw !== true) fail();
  return { raw: true as const };
}

function optionalMedia(record: Record<string, unknown>): object {
  if (record.media === undefined) return {};
  if (!Array.isArray(record.media) || record.media.length === 0 || record.media.length > MAX_MEDIA_ITEMS) fail();
  const media = record.media.map(requireString);
  if (media.some((value) => !isAbsolute(value) || unicodeLength(value) > MAX_MEDIA_PATH_CHARACTERS || CONTROL_PATTERN.test(value))) fail();
  return { media };
}

function optionalString(record: Record<string, unknown>, key: "skill" | "id" | "code"): object {
  if (record[key] === undefined) return {};
  return { [key]: requireString(record[key]) };
}

function rejectSensitiveFields(event: ProgressEvent): void {
  const values = [event.stage, event.text, event.skill, event.id, event.code];
  if (values.some((value) => value !== undefined && containsSensitiveContent(value))) {
    throw new ProgressError("sensitive_content");
  }
}

function validateRequiredFields(event: ProgressEvent): void {
  if (!(["progress", "done", "error", "log"] as const).includes(event.type)) fail();
  if (!STAGE_PATTERN.test(event.stage)) fail();
  const textLimit = event.type === "done" && event.raw === true
    ? MAX_RAW_DONE_TEXT_CHARACTERS
    : MAX_TEXT_CHARACTERS;
  if (event.text.trim() === "" || unicodeLength(event.text) > textLimit) fail();
  if (event.visibility !== "channel" || event.privacy !== "public") fail();
  if (!RFC3339_PATTERN.test(event.ts) || Number.isNaN(Date.parse(event.ts))) fail();
  if (event.raw !== undefined && event.type !== "done") fail();
  if (event.media !== undefined && event.type !== "done") fail();
}

function validateOptionalFields(event: ProgressEvent): void {
  validateIdentifier(event.skill, MAX_SKILL_CHARACTERS);
  validateIdentifier(event.id, MAX_ID_CHARACTERS);
  validateIdentifier(event.code, MAX_CODE_CHARACTERS);
  if (event.code !== undefined && event.type !== "error") fail();
}

function validateIdentifier(value: string | undefined, maximum: number): void {
  if (value === undefined) return;
  if (value.trim() === "" || unicodeLength(value) > maximum || CONTROL_PATTERN.test(value)) fail();
}

function requireString(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}

function fail(): never {
  throw new ProgressError("invalid_event");
}

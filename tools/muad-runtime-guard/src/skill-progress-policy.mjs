const MAX_TEXT_CHARACTERS = 1000;
const MAX_ID_CHARACTERS = 80;
const MAX_CODE_CHARACTERS = 80;
const MAX_SKILL_CHARACTERS = 128;
const EVENT_KEYS = new Set([
  "type", "skill", "stage", "text", "id", "code", "visibility", "privacy", "ts",
]);
const STAGE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const SENSITIVE_PATTERNS = [
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

export function validateProgressEvent(input) {
  const event = normalizedEvent(input);
  if (!event || !validEventFields(event)) return { ok: false, reason: "schema_invalid" };
  if (sensitiveEvent(event)) return { ok: false, reason: "sensitive_content" };
  return { ok: true, event };
}

export function renderProgressText(event, context) {
  const locale = context.locale === "en" ? "en" : "zh";
  const icon = event.type === "done" ? "✅" : event.type === "error" ? "❌" : "⏳";
  const heading = locale === "en" ? "Progress" : "进度";
  const separator = locale === "en" ? ": " : "：";
  return `${heading} · ${context.skillName}\n${icon} ${event.stage}${separator}${event.text}`;
}

function normalizedEvent(input) {
  if (!isRecord(input) || Object.keys(input).some((key) => !EVENT_KEYS.has(key))) return undefined;
  const required = ["type", "stage", "text", "visibility", "privacy", "ts"];
  if (required.some((key) => typeof input[key] !== "string")) return undefined;
  if (["skill", "id", "code"].some((key) => input[key] !== undefined && typeof input[key] !== "string")) {
    return undefined;
  }
  return {
    type: input.type, stage: input.stage, text: input.text,
    visibility: input.visibility, privacy: input.privacy, ts: input.ts,
    ...optionalField(input, "skill"), ...optionalField(input, "id"),
    ...optionalField(input, "code"),
  };
}

function validEventFields(event) {
  // type="log" 为 CLI 诊断事件（仅落日志），与 progress/done/error 同一 schema。
  if (!["progress", "done", "error", "log"].includes(event.type)) return false;
  if (!STAGE_PATTERN.test(event.stage)) return false;
  if (event.text.trim() === "" || unicodeLength(event.text) > MAX_TEXT_CHARACTERS) return false;
  if (event.visibility !== "channel" || event.privacy !== "public") return false;
  if (!RFC3339_PATTERN.test(event.ts) || Number.isNaN(Date.parse(event.ts))) return false;
  if (!validOptional(event.skill, MAX_SKILL_CHARACTERS)) return false;
  if (!validOptional(event.id, MAX_ID_CHARACTERS)) return false;
  if (!validOptional(event.code, MAX_CODE_CHARACTERS)) return false;
  return event.code === undefined || event.type === "error";
}

function sensitiveEvent(event) {
  return [event.stage, event.text, event.skill, event.id, event.code].some(
    (value) => value !== undefined && SENSITIVE_PATTERNS.some((pattern) => pattern.test(value.trim())),
  );
}

function validOptional(value, maximum) {
  if (value === undefined) return true;
  return value.trim() !== "" && unicodeLength(value) <= maximum && !CONTROL_PATTERN.test(value);
}

function optionalField(record, key) {
  return record[key] === undefined ? {} : { [key]: record[key] };
}

function unicodeLength(value) {
  return Array.from(value).length;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

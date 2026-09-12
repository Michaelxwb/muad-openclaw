import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CODE_CHARACTERS,
  MAX_ID_CHARACTERS,
  MAX_RAW_DONE_TEXT_CHARACTERS,
  MAX_TEXT_CHARACTERS,
  ProgressError,
  unicodeLength,
  validateEvent,
} from "../dist/index.js";

test("B-01 text uses Unicode code points rather than UTF-16 units", () => {
  assert.equal(unicodeLength("😀"), 1);
  assert.equal("😀".length, 2);
  assert.doesNotThrow(() => validateEvent(event({ text: "😀".repeat(MAX_TEXT_CHARACTERS) })));
  assertProgressError(
    () => validateEvent(event({ text: "界".repeat(MAX_TEXT_CHARACTERS + 1) })),
    2,
    "invalid_event",
  );
});

test("raw done uses the final-result limit and accepts media paths", () => {
  assert.doesNotThrow(() => validateEvent(event({
    type: "done",
    text: "完".repeat(MAX_RAW_DONE_TEXT_CHARACTERS),
    raw: true,
    media: ["/workspace/ti.png"],
  })));
  assertProgressError(
    () => validateEvent(event({
      type: "done",
      text: "完".repeat(MAX_RAW_DONE_TEXT_CHARACTERS + 1),
      raw: true,
    })),
    2,
    "invalid_event",
  );
});

test("B-01 stage accepts 64 ASCII characters and rejects invalid or longer values", () => {
  assert.doesNotThrow(() => validateEvent(event({ stage: `a${"1".repeat(63)}` })));
  for (const stage of [`a${"1".repeat(64)}`, "1query", "Query", "query.value", "query\nnext"]) {
    assertProgressError(() => validateEvent(event({ stage })), 2, "invalid_event");
  }
});

test("B-01 id and error code enforce the 80-code-point boundary", () => {
  assert.doesNotThrow(() => validateEvent(event({ id: "界".repeat(MAX_ID_CHARACTERS) })));
  assertProgressError(
    () => validateEvent(event({ id: "界".repeat(MAX_ID_CHARACTERS + 1) })),
    2,
    "invalid_event",
  );
  assert.doesNotThrow(() => validateEvent(event({
    type: "error", code: "错".repeat(MAX_CODE_CHARACTERS),
  })));
  assertProgressError(
    () => validateEvent(event({ type: "error", code: "错".repeat(MAX_CODE_CHARACTERS + 1) })),
    2,
    "invalid_event",
  );
});

test("B-01 preserves line breaks, emoji, and Markdown characters as text", () => {
  const text = "第一行 😀\n**第二行** `value`";
  assert.equal(validateEvent(event({ text })).text, text);
});

test("RULE-03 sensitive text is rejected with a stable redacted error", () => {
  const samples = [
    "token=secret-value",
    "Cookie: session=secret-value",
    "Authorization: Bearer secret-value",
    "password=hunter2",
    "访问 http://127.0.0.1:8080/private",
    "SELECT name FROM users",
    "at service.ts:42:13",
  ];
  for (const text of samples) {
    const error = captureProgressError(() => validateEvent(event({ text })));
    assert.equal(error.exitCode, 3);
    assert.equal(error.code, "sensitive_content");
    assert.equal(error.message.includes(text), false);
  }
});

test("RULE-03 scans every caller-controlled optional string", () => {
  const fields = ["text", "skill", "id", "code"];
  for (const field of fields) {
    const error = captureProgressError(() => validateEvent(event({
      type: "error",
      code: "query_failed",
      [field]: "token=must-not-leak",
    })));
    assert.equal(error.exitCode, 3);
    assert.equal(error.code, "sensitive_content");
    assert.equal(error.message.includes("must-not-leak"), false);
  }
});

function event(overrides = {}) {
  return {
    type: "progress",
    stage: "query",
    text: "正在查询",
    visibility: "channel",
    privacy: "public",
    ts: "2026-08-28T06:30:00.000Z",
    ...overrides,
  };
}

function assertProgressError(operation, exitCode, code) {
  const error = captureProgressError(operation);
  assert.equal(error.exitCode, exitCode);
  assert.equal(error.code, code);
}

function captureProgressError(operation) {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ProgressError);
    return error;
  }
  assert.fail("expected ProgressError");
}

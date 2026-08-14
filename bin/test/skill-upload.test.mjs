import assert from "node:assert/strict";
import test from "node:test";

import { formatConsoleError } from "../../skills/skill-upload/scripts/upload-skill.mjs";

test("skill-upload formats backend validation detail", () => {
  const formatted = formatConsoleError(JSON.stringify({
    code: 40524,
    message: "muad.skill.json 格式非法",
    detail: "muad.skill.json 不是合法 JSON：invalid character",
    requestId: "req-1",
  }));

  assert.match(formatted, /muad\.skill\.json 格式非法/u);
  assert.match(formatted, /具体原因：muad\.skill\.json 不是合法 JSON/u);
  assert.match(formatted, /requestId: req-1/u);
});

test("skill-upload falls back to plain text upload errors", () => {
  assert.equal(formatConsoleError("gateway unavailable"), "gateway unavailable");
});

test("skill-upload handles empty upload error responses", () => {
  assert.equal(formatConsoleError(""), "控制台未返回错误详情");
});

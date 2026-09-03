import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatConsoleError } from "../../skills/self-skill-upload/scripts/upload-skill.mjs";

test("skill-upload resolves a runtime agent id that starts with a digit", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "skill-upload-agent-id-"));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../../skills/self-skill-upload/scripts/upload-skill.mjs", import.meta.url)), "report-skill"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_AGENT_ID: "13418-bb540530",
          OPENCLAW_STATE_DIR: stateDir,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skill not found in staging: report-skill/u);
    assert.doesNotMatch(result.stderr, /cannot resolve agent workspace/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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

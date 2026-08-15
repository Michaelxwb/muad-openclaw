import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUN_PY = fileURLToPath(
  new URL("../../../skills/report-customer-weekly/scripts/run.py", import.meta.url),
);

test("run.py sanitizes customer/period and writes the report inside the output dir", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "muad-weekly-report-"));
  const stdout = execFileSync("python3", [
    RUN_PY,
    "--customer", "Acme-客户A",
    "--period", "2026-W31",
    "--output-dir", outputDir,
  ], {
    encoding: "utf8",
    env: { ...process.env, REPORT_SKILL_STAGE_DELAY: "0" },
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "ok");
  assert.equal(summary.customer, "Acme-客户A");
  assert.equal(summary.period, "2026-W31");
  const reportPath = join(outputDir, "Acme-客户A-2026-W31.md");
  assert.equal(summary.report, reportPath);
  assert.ok(existsSync(reportPath));
  assert.match(readFileSync(reportPath, "utf8"), /^# 客户周报：Acme-客户A/u);
});

test("run.py rejects path-traversal customer names without writing outside the output dir", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-weekly-traversal-"));
  const outputDir = join(root, "out");
  let failure = null;
  try {
    execFileSync("python3", [
      RUN_PY,
      "--customer", "../../evil",
      "--period", "2026-W31",
      "--output-dir", outputDir,
    ], {
      encoding: "utf8",
      env: { ...process.env, REPORT_SKILL_STAGE_DELAY: "0" },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "traversal customer must be rejected");
  assert.equal(failure.status, 2);
  assert.match(String(failure.stderr), /error:/u);
  assert.match(String(failure.stderr), /unsafe path segments/u);
  assert.equal(existsSync(outputDir), false, "no report dir may be created for a rejected input");
  assert.equal(existsSync(join(root, "evil")), false);
});

test("run.py rejects empty and dot-segment values for customer and period", () => {
  for (const [customer, period] of [
    ["", "2026-W31"],
    ["Acme", "2026..W31"],
    ["../Acme", "2026-W31"],
    ["Acme", "a/../b"],
  ]) {
    let failure = null;
    try {
      execFileSync("python3", [
        RUN_PY, "--customer", customer, "--period", period, "--output-dir",
        mkdtempSync(join(tmpdir(), "muad-weekly-reject-")),
      ], {
        encoding: "utf8",
        env: { ...process.env, REPORT_SKILL_STAGE_DELAY: "0" },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `expected rejection for customer=${JSON.stringify(customer)} period=${JSON.stringify(period)}`);
    assert.equal(failure.status, 2);
    assert.match(String(failure.stderr), /error:/u);
  }
});

test("run.py replaces unsafe characters in otherwise valid names", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "muad-weekly-safe-"));
  const stdout = execFileSync("python3", [
    RUN_PY,
    "--customer", "客户/公司 A",
    "--period", "2026-W31",
    "--output-dir", outputDir,
  ], {
    encoding: "utf8",
    env: { ...process.env, REPORT_SKILL_STAGE_DELAY: "0" },
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.customer, "客户_公司 A".replace(" ", "_"));
  assert.ok(existsSync(join(outputDir, "客户_公司_A-2026-W31.md")));
  assert.deepEqual(readdirSync(outputDir), ["客户_公司_A-2026-W31.md"]);
});

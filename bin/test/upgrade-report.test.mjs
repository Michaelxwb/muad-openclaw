// TASK-008 S-12：升级报告/材料校验。
//
// 真实边界：仓库内的版本清单、entrypoint、需求设计/任务文档（文档即交付物）。
// 只断言“可以证明的事实”：冻结版本、启动链路自动迁移、门禁记录、人工边界分列。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "..");
const taskDir = join(root, ".code-flow", "tasks", "2026-10-06", "openclaw-runtime-upgrade");
const designPath = join(taskDir, "openclaw-runtime-upgrade.design.md");
const taskPath = join(taskDir, "openclaw-runtime-upgrade.md");

test("upgrade report: frozen versions and automatic Doctor migration", () => {
  const base = readFileSync(join(root, "Dockerfile.base"), "utf8");
  assert.match(base, /^ARG OPENCLAW_VERSION=2026\.9\.8$/mu);
  assert.match(base, /^ARG WECOM_PLUGIN_VERSION=2026\.9\.15$/mu);
  assert.match(base, /^ARG MATTERMOST_PLUGIN_VERSION=2026\.9\.8$/mu);
  assert.match(base, /^ARG WECHAT_PLUGIN_VERSION=2\.4\.9$/mu);

  const entrypoint = readFileSync(join(root, "entrypoint.sh"), "utf8");
  const doctor = entrypoint.indexOf("openclaw doctor --fix --non-interactive");
  const gateway = entrypoint.indexOf("exec openclaw gateway");
  assert.ok(doctor >= 0 && gateway > doctor, "entrypoint must run Doctor before the Gateway");
  assert.doesNotMatch(
    entrypoint,
    /(?:node|sh|bash)[^\n]*migrate[^\n]*\.(?:mjs|sh|js)/u,
    "upgrade must not depend on a manual migration script",
  );
});

test("upgrade report: gates recorded and manual boundaries stay separate", () => {
  const design = readFileSync(designPath, "utf8");
  for (let gate = 1; gate <= 9; gate += 1) {
    assert.ok(design.includes(`G-0${gate}`), `design gate G-0${gate} missing`);
  }

  const task = readFileSync(taskPath, "utf8");
  const scenarios = new Set([...task.matchAll(/^\| ([SEB]-\d+)\b/gmu)].map((match) => match[1]));
  assert.ok(scenarios.size >= 28, `expected >=28 scenarios, got ${scenarios.size}`);
  assert.match(task, /S-08[^\n]*manual/u, "S-08 must stay a manual boundary");
  assert.match(task, /B-04[^\n]*manual/u, "B-04 must stay a manual boundary");
  assert.match(
    task,
    /e2e_deferred|manual|pending_manual/u,
    "report must distinguish executed results from pending manual acceptance",
  );
});

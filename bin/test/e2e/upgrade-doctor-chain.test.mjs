// TASK-003 S-06 / E-05 集成验收：真实 9.8 Doctor 对合成 7.1 状态执行自动迁移。
//
// 真实边界（不得 mock）：真实临时文件树/SQLite + 官方 2026.9.8 镜像内的真实
// `openclaw doctor --fix --non-interactive`。本文件不在 `bin/test/*.test.mjs`
// 默认 glob 内，仅由 acceptance 命令显式执行（需要本机 Docker 与目标镜像）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const IMAGE = process.env.MUAD_UPGRADE_DOCTOR_IMAGE || "ghcr.io/openclaw/openclaw:2026.9.8";

function dockerAvailable() {
  return spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
}

function imageAvailable() {
  return spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
}

function makeSynthetic71State() {
  const root = mkdtempSync(join(tmpdir(), "muad-doctor-chain-"));
  mkdirSync(join(root, "agents", "main", "sessions"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local" }, agents: { defaults: {} } }),
  );
  writeFileSync(join(root, "agents", "main", "sessions", "u1.jsonl"), "{}\n");
  writeFileSync(
    join(root, "agents", "main", "sessions", "sessions.json"),
    JSON.stringify({
      "agent:main:wecom:direct:u1": { sessionId: "s1", sessionFile: "u1.jsonl" },
    }),
  );
  return root;
}

function runDoctor(stateDir, mountMode = "") {
  return spawnSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${stateDir}:/home/node/.openclaw${mountMode}`,
      "--entrypoint", "openclaw",
      IMAGE,
      "doctor", "--fix", "--non-interactive",
    ],
    { encoding: "utf8" },
  );
}

test("S-06 [integration] real 9.8 Doctor migrates synthetic 7.1 sessions into per-agent SQLite", (t) => {
  if (!dockerAvailable() || !imageAvailable()) {
    t.skip(`docker or ${IMAGE} unavailable; acceptance requires the real 9.8 image`);
    return;
  }
  const root = makeSynthetic71State();
  try {
    const run = runDoctor(root);
    assert.equal(run.status, 0, `Doctor must exit 0:\n${run.stdout}\n${run.stderr}`);
    const dbPath = join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    assert.equal(existsSync(dbPath), true, "Doctor must create the per-agent SQLite");
    const query = spawnSync("node", ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
      console.log(db.prepare("SELECT COUNT(*) n FROM session_nodes").get().n);
    `], { encoding: "utf8" });
    assert.equal(query.status, 0, query.stderr);
    assert.ok(Number(query.stdout.trim()) >= 1, "migrated session row must exist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E-05 [integration] migration failure without writable state exits non-zero (fail-closed)", (t) => {
  if (!dockerAvailable() || !imageAvailable()) {
    t.skip(`docker or ${IMAGE} unavailable; acceptance requires the real 9.8 image`);
    return;
  }
  const root = makeSynthetic71State();
  try {
    const run = runDoctor(root, ":ro");
    assert.notEqual(run.status, 0, "Doctor must not report success on unwritable state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

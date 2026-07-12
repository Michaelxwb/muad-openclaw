import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  commitTransaction,
  prepareTransaction,
  rollbackTransaction,
  validateCandidate,
} from "../runtime-config-transaction.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url));

test("transaction prepares, commits and rolls back an atomic config candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-transaction-"));
  const configPath = join(root, "openclaw.json");
  const original = { gateway: { mode: "local" }, browser: { enabled: false } };
  writeFileSync(configPath, JSON.stringify(original));
  const runtime = runtimeForRoot(root);

  const prepared = prepareTransaction({ runtime, configPath });
  assert.equal(prepared.restartMode, "pod");
  assert.equal(existsSync(`${configPath}.muad.candidate`), true);
  const committed = commitTransaction({ runtime, configPath });
  assert.equal(committed.configHash, prepared.configHash);
  assert.equal(existsSync(`${configPath}.muad.previous`), true);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).plugins.entries["muad-runtime-guard"].config.generation, 7);

  const rolledBack = rollbackTransaction(configPath);
  assert.equal(rolledBack.generation, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
});

test("candidate validation uses OPENCLAW_CONFIG_PATH and propagates failures", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-validate-"));
  const configPath = join(root, "openclaw.json");
  writeFileSync(`${configPath}.muad.candidate`, "{}\n");
  let candidatePath = "";
  const runner = (_command, _args, options) => {
    candidatePath = options.env.OPENCLAW_CONFIG_PATH;
    return { status: 0, stdout: '{"valid":true}', stderr: "" };
  };

  assert.deepEqual(validateCandidate(configPath, runner), { valid: true });
  assert.equal(candidatePath, `${configPath}.muad.candidate`);
  assert.throws(
    () => validateCandidate(configPath, () => ({ status: 1, stdout: "", stderr: "schema rejected" })),
    /schema rejected/,
  );
});

test("rollback before commit keeps the current valid config", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-precommit-"));
  const configPath = join(root, "openclaw.json");
  const current = { gateway: { mode: "local" }, stable: true };
  writeFileSync(configPath, JSON.stringify(current));
  writeFileSync(`${configPath}.muad.previous`, JSON.stringify({ stable: false }));
  prepareTransaction({ runtime: runtimeForRoot(root), configPath });

  rollbackTransaction(configPath);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), current);
  assert.equal(existsSync(`${configPath}.muad.candidate`), false);
});

function runtimeForRoot(root) {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  runtime.skills.privateRoot = root;
  for (const agent of runtime.agents) {
    agent.workspace = join(root, `workspace-${agent.id}`);
    agent.agentDir = join(root, "agents", agent.id, "agent");
  }
  runtime.sessionManager.agents[0].workspace = runtime.agents[1].workspace;
  runtime.sessionManager.agents[0].storeDirectory = join(root, "agents", "alice", "session-store");
  return runtime;
}

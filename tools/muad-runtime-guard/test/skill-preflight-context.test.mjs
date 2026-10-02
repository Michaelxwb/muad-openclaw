import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillPreflightContext, createSkillPreflightReadHooks } from "../src/skill-preflight-context.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "muad-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "SKILL.md");
  writeFileSync(filePath, "Required: --customer-id\n", { mode: 0o600 });
  return { agentId: "alice", sessionKey: "agent:alice:wecom:direct:a", runId: "turn-1", skillName: "report", rootPath: root, filePath };
}

test("PreflightB05 requires a successful current-turn document read", (t) => {
  const input = fixture(t);
  const ledger = new SkillPreflightContext();
  assert.equal(ledger.check(input).reason, "documentation_not_read");
  assert.equal(ledger.recordRead({ ...input, error: "read failed" }).ok, false);
  assert.equal(ledger.check(input).reason, "documentation_not_read");
  assert.equal(ledger.recordRead(input).ok, true);
  assert.equal(ledger.check(input).ok, true);
  assert.equal(ledger.check({ ...input, runId: "turn-2" }).reason, "documentation_not_read");
  assert.equal(ledger.check({ ...input, agentId: "bob" }).reason, "documentation_not_read");
  assert.equal(ledger.check({ ...input, sessionKey: "other-session" }).reason, "documentation_not_read");
  assert.equal(ledger.check({ ...input, skillName: "other-skill" }).reason, "documentation_not_read");
});

test("PreflightB05 invalidates changed documents until read again", (t) => {
  const input = fixture(t);
  const ledger = new SkillPreflightContext();
  ledger.recordRead(input);
  writeFileSync(input.filePath, "Required: --customer-id --quarter\n");
  assert.equal(ledger.check(input).reason, "documentation_changed");
  assert.equal(ledger.check(input).reason, "documentation_not_read");
  ledger.recordRead(input);
  assert.equal(ledger.check(input).ok, true);
  ledger.clearTurn(input);
  assert.equal(ledger.check(input).reason, "documentation_not_read");
});

test("PreflightB05 rejects scripts, missing documents and symlink escapes", (t) => {
  const input = fixture(t);
  const ledger = new SkillPreflightContext();
  mkdirSync(path.join(input.rootPath, "scripts"));
  const script = path.join(input.rootPath, "scripts", "run.py");
  writeFileSync(script, "print('do not execute')\n");
  assert.equal(ledger.recordRead({ ...input, filePath: script }).ok, false);
  rmSync(input.filePath);
  assert.equal(ledger.recordRead(input).ok, false);
  const other = fixture(t);
  symlinkSync(other.filePath, input.filePath);
  assert.equal(ledger.recordRead(input).ok, false);
  assert.equal(ledger.check(input).reason, "documentation_not_read");
});

test("PreflightB05 expires and bounds isolated read records", (t) => {
  const input = fixture(t);
  let now = 0;
  const ledger = new SkillPreflightContext({ now: () => now, ttlMs: 100, maxRecords: 2 });
  ledger.recordRead(input);
  ledger.recordRead({ ...input, runId: "turn-2" });
  ledger.recordRead({ ...input, runId: "turn-3" });
  assert.equal(ledger.check(input).reason, "documentation_not_read");
  assert.equal(ledger.check({ ...input, runId: "turn-2" }).ok, true);
  now = 101;
  assert.equal(ledger.check({ ...input, runId: "turn-3" }).reason, "documentation_not_read");
});

test("PreflightB05 actual after-read hook records only successful authorized documents", (t) => {
  const input = fixture(t);
  const ledger = new SkillPreflightContext();
  const hooks = createSkillPreflightReadHooks({ ledger, getConfig: () => ({
    longTaskSkillGrants: [{ agentId: input.agentId, name: input.skillName, rootPath: input.rootPath }],
  }) });
  const event = { toolName: "read", params: { path: input.filePath } };
  assert.equal(hooks.afterToolCall({ ...event, error: "not readable" }, input), undefined);
  assert.equal(hooks.afterToolCall({ ...event, result: { isError: true } }, input), undefined);
  assert.equal(hooks.afterToolCall(event, { ...input, agentId: "bob" }), undefined);
  assert.equal(ledger.check(input).reason, "documentation_not_read");
  assert.equal(hooks.afterToolCall(event, input).ok, true);
  assert.equal(ledger.check(input).ok, true);
  assert.equal(ledger.check({ ...input, runId: "turn-2" }).reason, "documentation_not_read");
});

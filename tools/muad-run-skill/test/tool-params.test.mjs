import assert from "node:assert/strict";
import test from "node:test";

import { readToolParams } from "../src/tool-params.mjs";

test("Tool parameters expose only Skill name, input, and data args", () => {
  assert.deepEqual(readToolParams({ skill_name: "xdr-query", input: "query", args: { limit: 10 } }), {
    mode: "managed", skillName: "xdr-query", input: "query", args: { limit: 10 },
  });
  assert.deepEqual(readToolParams({
    skill_name: "report", script_path: "scripts/export.py", args: ["--customer", "test"],
  }), {
    mode: "traditional", skillName: "report", input: "",
    scriptPath: "scripts/export.py", args: ["--customer", "test"],
  });
  for (const forged of [
    { skill_name: "xdr-query", agentId: "bob" },
    { skill_name: "xdr-query", command: ["sh", "run.sh"] },
    { skill_name: "xdr-query", path: "/tmp/run.sh" },
    { skill_name: "report", script_path: "scripts/run.sh", args: "--unsafe value" },
    { skill_name: "report", script_path: "../run.sh", args: [] },
  ]) {
    assert.throws(() => readToolParams(forged), /invalid muad_run_skill parameters/u);
  }
});

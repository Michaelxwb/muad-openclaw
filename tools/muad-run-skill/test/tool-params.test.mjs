import assert from "node:assert/strict";
import test from "node:test";

import { readToolParams } from "../src/tool-params.mjs";

test("Tool parameters expose only Skill name, input, and data args", () => {
  assert.deepEqual(readToolParams({ skill_name: "xdr-query", input: "query", args: { limit: 10 } }), {
    skillName: "xdr-query", input: "query", args: { limit: 10 },
  });
  for (const forged of [
    { skill_name: "xdr-query", agentId: "bob" },
    { skill_name: "xdr-query", command: ["sh", "run.sh"] },
    { skill_name: "xdr-query", path: "/tmp/run.sh" },
  ]) {
    assert.throws(() => readToolParams(forged), /invalid muad_run_skill parameters/u);
  }
});

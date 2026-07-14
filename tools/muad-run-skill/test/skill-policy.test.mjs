import assert from "node:assert/strict";
import test from "node:test";

import {
  manifestSourceForGrant,
  normalizeSkillPolicies,
  resolveSkillGrant,
} from "../src/skill-policy.mjs";

test("normalizes and resolves per-agent Skill grants", () => {
  const policies = normalizeSkillPolicies([
    {
      agentId: "alice",
      allowed: [
        { name: "xdr-query", source: "public", skillId: "skill-public-xdr" },
        { name: "sdsp-report", source: "private", skillId: "skill-private-sdsp" },
        { name: "bad", source: "unknown", skillId: "bad" },
      ],
    },
  ]);

  assert.deepEqual(resolveSkillGrant(policies, "alice", "sdsp-report"), {
    name: "sdsp-report",
    source: "private",
    skillId: "skill-private-sdsp",
  });
  assert.equal(manifestSourceForGrant("private"), "private");
  assert.equal(manifestSourceForGrant("public"), "public");
  assert.equal(manifestSourceForGrant("system"), "public");
  assert.throws(() => resolveSkillGrant(policies, "alice", "bad"), /not enabled/u);
  assert.throws(() => resolveSkillGrant(policies, "bob", "xdr-query"), /not enabled/u);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { runSmokeSessionFlow } from "../scripts/smoke-session-flow.mjs";

test("fake business platform smoke flow refreshes, caches, and feeds a Skill", async (t) => {
  const python = process.env.PYTHON || "python3";
  if (spawnSync(python, ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip(`${python} is required for fake business platform smoke flow`);
    return;
  }

  const result = await runSmokeSessionFlow({ python });

  assert.equal(result.status, "SMOKE_OK");
  assert.equal(result.resolveCalls, 2);
  assert.deepEqual(result.first, {
    source: "refresh",
    skillName: "smoke-platform",
    platform: "smoke_platform",
    platformSource: "refresh",
  });
  assert.deepEqual(result.second, {
    source: "cache",
    skillName: "smoke-platform",
    platform: "smoke_platform",
    platformSource: "cache",
  });
  assert.deepEqual(result.firstSkill, {
    status: "SMOKE_OK",
    platform: "smoke_platform",
    source: "refresh",
    user: "demo",
    authenticated: true,
  });
  assert.deepEqual(result.secondSkill, {
    status: "SMOKE_OK",
    platform: "smoke_platform",
    source: "cache",
    user: "demo",
    authenticated: true,
  });
});

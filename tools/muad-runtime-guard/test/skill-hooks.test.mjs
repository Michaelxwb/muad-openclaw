import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillLeaseHooks,
  explicitSkillName,
  skillRunKey,
} from "../src/skill-hooks.mjs";
import { SkillLeaseManager } from "../src/skill-lease.mjs";

const config = {
  valid: true,
  mainAgentId: "main",
  agentProfiles: [{ agentId: "alice", profile: "profile-alice" }],
};

test("skill hooks acquire only for explicit Skill commands and release on agent end", async () => {
  const manager = leases();
  const hooks = createSkillLeaseHooks({ config, leaseManager: manager });

  assert.deepEqual(await hooks.before({ prompt: "normal chat" }, context("run-chat")), {
    outcome: "pass",
  });
  assert.deepEqual(manager.snapshot(), { active: 0, queued: 0, limit: 1 });

  assert.deepEqual(await hooks.before(skillEvent("run-1", "/skill:xdr-query now"), context("run-1")), {
    outcome: "pass",
  });
  assert.deepEqual(manager.snapshot(), { active: 1, queued: 0, limit: 1 });

  const busy = await hooks.before(skillEvent("run-2", "/skill:mssw-query now"), context("run-2"));
  assert.equal(busy.outcome, "block");
  assert.equal(busy.category, "skill_concurrency");

  await hooks.end({ runId: "run-1" }, context("run-1"));
  assert.deepEqual(manager.snapshot(), { active: 0, queued: 0, limit: 1 });
  manager.close();
});

test("skill hooks recognize expanded native Skill prompts and stable run keys", () => {
  assert.equal(explicitSkillName('/skill:xdr-query {"target":"host"}'), "xdr-query");
  assert.equal(explicitSkillName('<skill name="mssw-query" location="/skills/mssw-query/SKILL.md">'), "mssw-query");
  assert.equal(explicitSkillName("/skill:Bad"), "");
  assert.equal(skillRunKey({ runId: "run-a" }, context("run-b")), JSON.stringify([
    "alice", "run-a", "agent:alice:wecom:direct:user",
  ]));
});

test("skill hooks log acquire/block/release through the injected log", async () => {
  const logs = [];
  const manager = leases();
  const hooks = createSkillLeaseHooks({
    config,
    leaseManager: manager,
    log: (message) => logs.push(message),
  });

  await hooks.before(skillEvent("run-1", "/skill:xdr-query now"), context("run-1"));
  assert.equal(logs.some((msg) => msg.includes("[skill-lease] acquired") && msg.includes("skill=xdr-query")), true);

  const busy = await hooks.before(skillEvent("run-2", "/skill:mssw-query now"), context("run-2"));
  assert.equal(busy.outcome, "block");
  assert.equal(logs.some((msg) => msg.includes("[skill-lease] blocked") && msg.includes("skill_busy")), true);

  await hooks.end({ runId: "run-1" }, context("run-1"));
  assert.equal(logs.some((msg) => msg.includes("[skill-lease] released")), true);
  manager.close();
});

function leases() {
  return new SkillLeaseManager({ limit: 1, waitTimeoutMs: 1, autoStart: false });
}

function skillEvent(runId, prompt) {
  return { runId, prompt };
}

function context(runId) {
  return {
    agentId: "alice",
    sessionKey: "agent:alice:wecom:direct:user",
    runId,
  };
}

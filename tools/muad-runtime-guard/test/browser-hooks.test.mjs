import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserLeaseHooks } from "../src/browser-hooks.mjs";
import { BrowserLeaseManager } from "../src/browser-lease.mjs";

const config = {
  valid: true,
  mainAgentId: "main",
  agentProfiles: [{ agentId: "alice", profile: "profile-alice" }],
};

test("browser hooks acquire by trusted call identity and release after failures or success", async () => {
  const manager = leases();
  const hooks = createBrowserLeaseHooks({ config, leaseManager: manager });
  const event = browserEvent("call-1");
  const ctx = context("call-1");

  assert.equal(await hooks.before(event, ctx), undefined);
  assert.deepEqual(manager.snapshot(), { active: 1, queued: 0, limit: 1 });
  hooks.after({ ...event, error: "browser failed" }, ctx);
  assert.deepEqual(manager.snapshot(), { active: 0, queued: 0, limit: 1 });
  manager.close();
});

test("browser hooks fail closed for forged profile and missing tool-call id", async () => {
  const manager = leases();
  const hooks = createBrowserLeaseHooks({ config, leaseManager: manager });
  const forged = await hooks.before({ ...browserEvent("call-1"),
    params: { action: "open", profile: "profile-bob" },
  }, context("call-1"));
  assert.equal(forged.block, true);

  const missing = await hooks.before(browserEvent(undefined), context(undefined));
  assert.equal(missing.block, true);
  assert.deepEqual(manager.snapshot(), { active: 0, queued: 0, limit: 1 });
  manager.close();
});

function leases() {
  return new BrowserLeaseManager({ limit: 1, autoStart: false });
}

function browserEvent(toolCallId) {
  return { toolName: "browser", toolCallId, runId: "run-1",
    params: { action: "open", profile: "profile-alice" } };
}

function context(toolCallId) {
  return { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user",
    runId: "run-1", toolCallId, toolName: "browser" };
}

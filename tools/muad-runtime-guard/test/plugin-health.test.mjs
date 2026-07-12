import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import plugin from "../src/index.mjs";
import { parseGuardConfig } from "../src/config.mjs";
import { runtimeHealth } from "../src/health.mjs";

test("plugin registers unauthenticated /bind and operator-scoped runtime health", async (t) => {
  installHealthMarkers(t);
  const registration = registerPlugin(t, validConfig());
  assert.equal(registration.command.name, "bind");
  assert.equal(registration.command.acceptsArgs, true);
  assert.equal(registration.command.requireAuth, false);
  assert.equal(registration.method, "muad.runtime.health");
  assert.deepEqual(registration.gatewayOptions, { scope: "operator.read" });
  assert.deepEqual(registration.policies.map((policy) => policy.id), [
    "muad-browser-profile", "muad-main-deny", "muad-agent-files",
  ]);
  assert.deepEqual(registration.hooks.map((hook) => hook.name), [
    "before_agent_reply", "before_dispatch", "before_tool_call", "after_tool_call",
  ]);
  assert.deepEqual(registration.hooks[0].options, { priority: -1000, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[1].options, { priority: -1000, timeoutMs: 1_000 });
  assert.equal(registration.hooks[0].handler({}, { agentId: "main" }).handled, true);
  assert.equal(registration.hooks[0].handler({}, { agentId: "alice" }), undefined);
  assert.equal(registration.hooks[1].handler({}, { agentId: "alice" }), undefined);

  const health = await registration.healthHandler({ params: {} });
  assert.deepEqual(health, {
    ok: true,
    version: 1,
    generation: 7,
    mappings: 2,
    sessionManager: { loaded: true, version: 1 },
    skill: { active: 1, queued: 2, limit: 4 },
    browser: { active: 0, queued: 0, limit: 2 },
  });
  assert.equal(JSON.stringify(health).includes("pod-service-token"), false);
});

test("health fails closed for incomplete mappings, quarantine reuse, or missing dependencies", (t) => {
  installHealthMarkers(t);
  const incomplete = validConfig();
  incomplete.sessionAgentIds = ["alice"];
  assert.equal(runtimeHealth(parseGuardConfig(incomplete)).ok, false);

  const profileConflict = validConfig();
  profileConflict.agentProfiles[0].profile = "quarantine";
  assert.equal(runtimeHealth(parseGuardConfig(profileConflict)).ok, false);

  delete globalThis[Symbol.for("muad.browser.lease")];
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).ok, false);
  globalThis[Symbol.for("muad.browser.lease")] = {
    snapshot: () => ({ active: 0, queued: 0, limit: 2 }),
  };
  delete globalThis[Symbol.for("muad.session-manager.health")];
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).ok, false);
});

test("manifest declares all trusted policies and package entry", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.trustedToolPolicies, [
    "muad-browser-profile", "muad-main-deny", "muad-agent-files",
  ]);
  assert.deepEqual(pkg.openclaw.extensions, ["./src/index.mjs"]);
});

function registerPlugin(t, config) {
  const registration = { policies: [], hooks: [] };
  plugin.register({
    pluginConfig: config,
    config: openClawConfig(),
    logger: { warn: () => {} },
    runtime: { agent: {
      resolveAgentWorkspaceDir: (_config, agentId) => `/state/workspace-${agentId}`,
      resolveAgentDir: (_config, agentId) => `/state/agents/${agentId}/agent`,
    } },
    registerCommand: (command) => { registration.command = command; },
    registerTrustedToolPolicy: (policy) => { registration.policies.push(policy); },
    on: (name, handler, options) => { registration.hooks.push({ name, handler, options }); },
    registerGatewayMethod: (method, handler, options) => {
      registration.method = method;
      registration.healthHandler = handler;
      registration.gatewayOptions = options;
    },
  });
  t.after(() => globalThis[Symbol.for("muad.browser.lease")]?.close?.());
  return registration;
}

function openClawConfig() {
  return {
    agents: { list: [
      { id: "main", workspace: "/state/workspace", agentDir: "/state/agents/main/agent" },
      {
        id: "alice",
        workspace: "/state/workspace-alice",
        agentDir: "/state/agents/alice/agent",
        model: { primary: "pod-default/deepseek-chat" },
      },
      {
        id: "bob",
        workspace: "/state/workspace-bob",
        agentDir: "/state/agents/bob/agent",
        model: { primary: "pod-default/deepseek-chat" },
      },
    ] },
    models: {
      providers: {
        "pod-default": {
          models: [{ id: "deepseek-chat", name: "deepseek-chat" }],
        },
      },
    },
  };
}

function validConfig() {
  return {
    generation: 7,
    mainAgentId: "main",
    quarantineProfile: "quarantine",
    agentProfiles: [
      { agentId: "alice", profile: "alice" },
      { agentId: "bob", profile: "bob" },
    ],
    sessionAgentIds: ["alice", "bob"],
    maxBrowserConcurrency: 2,
    maxSkillConcurrency: 4,
    consoleInternalURL: "http://console.internal:8080/internal/v1",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
  };
}

function installHealthMarkers(t) {
  const sessionSymbol = Symbol.for("muad.session-manager.health");
  const skillSymbol = Symbol.for("muad.run-skill.queue");
  const browserSymbol = Symbol.for("muad.browser.lease");
  globalThis[sessionSymbol] = { loaded: true, version: 1 };
  globalThis[skillSymbol] = { snapshot: () => ({ active: 1, queued: 2, limit: 4 }) };
  globalThis[browserSymbol] = { snapshot: () => ({ active: 0, queued: 0, limit: 2 }) };
  t.after(() => {
    delete globalThis[sessionSymbol];
    delete globalThis[skillSymbol];
    delete globalThis[browserSymbol];
  });
}

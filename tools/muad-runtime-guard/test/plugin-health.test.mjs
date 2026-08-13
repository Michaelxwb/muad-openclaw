import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import plugin from "../src/index.mjs";
import { parseGuardConfig } from "../src/config.mjs";
import { createHealthHandler, runtimeHealth } from "../src/health.mjs";

test("plugin registers unauthenticated /bind and operator-scoped runtime health", async (t) => {
  installHealthMarkers(t);
  const registration = registerPlugin(t, validConfig());
  assert.equal(registration.command.name, "bind");
  assert.equal(registration.command.acceptsArgs, true);
  assert.equal(registration.command.requireAuth, false);
  assert.deepEqual(registration.methods.map((entry) => entry.method), [
    "muad.runtime.health", "muad.runtime.verify-routes",
  ]);
  assert.deepEqual(registration.methods.map((entry) => entry.options), [
    { scope: "operator.read" }, { scope: "operator.read" },
  ]);
  assert.deepEqual(registration.reloadPolicy, {
    noopPrefixes: ["plugins.entries.muad-runtime-guard.config.generation"],
  });
  assert.deepEqual(registration.policies.map((policy) => policy.id), [
    "muad-browser-profile", "muad-main-deny", "muad-agent-files",
  ]);
  assert.deepEqual(registration.hooks.map((hook) => hook.name), [
    "before_agent_reply", "before_dispatch", "before_tool_call", "after_tool_call",
    "before_agent_run", "agent_end", "before_dispatch", "before_agent_run",
    "before_tool_call", "before_agent_finalize", "reply_payload_sending", "agent_end",
    "resolve_exec_env", "before_tool_call", "reply_payload_sending",
    "before_dispatch", "before_agent_run", "before_tool_call", "after_tool_call",
  ]);
  assert.deepEqual(registration.hooks[15].options, { priority: -100, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[16].options, { priority: -100, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[17].options, { priority: -100, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[0].options, { priority: -1000, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[1].options, { priority: -1000, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[4].options, { priority: -1000, timeoutMs: 35_000 });
  assert.deepEqual(registration.hooks[5].options, { priority: 1000, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[6].options, { priority: -1100, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[7].options, { priority: -900, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[8].options, { priority: -900, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[9].options, { priority: -900, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[10].options, { priority: -900, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[11].options, { priority: 900, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[12].options, { priority: -800, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[13].options, { priority: -950, timeoutMs: 1_000 });
  assert.deepEqual(registration.hooks[14].options, { priority: -850, timeoutMs: 1_000 });
  assert.equal(registration.hooks[0].handler({}, { agentId: "main" }).handled, true);
  assert.equal(registration.hooks[0].handler({}, { agentId: "alice" }), undefined);
  assert.equal(registration.hooks[1].handler({}, { agentId: "alice" }), undefined);

  const health = await registration.methods[0].handler({ params: {} });
  assert.deepEqual(health, {
    ok: true,
    version: 2,
    generation: 7,
    mappings: 2,
    sessionManager: { loaded: true, version: 1 },
    browser: { active: 0, queued: 0, limit: 2 },
    skill: { active: 0, queued: 0, limit: 4 },
    longTask: { active: 0, queued: 0, limit: 2 },
  });
  assert.equal(JSON.stringify(health).includes("pod-service-token"), false);
});

test("health handler observes the latest guard config without plugin reload", async (t) => {
  installHealthMarkers(t);
  const current = openClawConfig();
  current.plugins = {
    entries: {
      "muad-runtime-guard": { config: { ...validConfig(), generation: 8 } },
    },
  };
  const handler = createHealthHandler(parseGuardConfig(validConfig()), globalThis, {
    readConfig: () => current,
  });

  const health = await handler();
  assert.equal(health.ok, true);
  assert.equal(health.generation, 8);
});

test("guard config parses locale with zh default and rejects unsupported values", () => {
  const base = validConfig();
  assert.equal(parseGuardConfig(base).locale, "zh");
  assert.equal(parseGuardConfig({ ...base, locale: "" }).locale, "zh");
  assert.equal(parseGuardConfig({ ...base, locale: "zh" }).locale, "zh");
  assert.equal(parseGuardConfig({ ...base, locale: "en" }).locale, "en");
  assert.equal(parseGuardConfig({ ...base, locale: "fr" }).valid, false);
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
  delete globalThis[Symbol.for("muad.skill.lease")];
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).ok, false);
  globalThis[Symbol.for("muad.skill.lease")] = {
    snapshot: () => ({ active: 0, queued: 0, limit: 4 }),
  };
  delete globalThis[Symbol.for("muad.longtask.manager")];
  assert.equal(runtimeHealth(parseGuardConfig(validConfig())).ok, false);
  globalThis[Symbol.for("muad.longtask.manager")] = {
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
  const registration = { policies: [], hooks: [], methods: [] };
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
      registration.methods.push({ method, handler, options });
    },
    registerReload: (policy) => { registration.reloadPolicy = policy; },
  });
  t.after(() => {
    globalThis[Symbol.for("muad.browser.lease")]?.close?.();
    globalThis[Symbol.for("muad.skill.lease")]?.close?.();
    globalThis[Symbol.for("muad.longtask.manager")]?.close?.();
    delete globalThis[Symbol.for("muad.longtask.manager")];
  });
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
    skillReadRoots: [
      { agentId: "alice", roots: ["/opt/openclaw-skills/web-tools-guide"] },
      { agentId: "bob", roots: [] },
    ],
    skillAuditGrants: [
      { agentId: "alice", name: "web-tools-guide", rootPath: "/opt/openclaw-skills/web-tools-guide", source: "system" },
    ],
    sessionAgentIds: ["alice", "bob"],
    maxBrowserConcurrency: 2,
    maxSkillConcurrency: 4,
    maxLongTaskConcurrency: 2,
    longTaskSkillGrants: [
      { agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query" },
    ],
    consoleInternalURL: "http://console.internal:8080/internal/v1",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
  };
}

function installHealthMarkers(t) {
  const sessionSymbol = Symbol.for("muad.session-manager.health");
  const browserSymbol = Symbol.for("muad.browser.lease");
  const skillSymbol = Symbol.for("muad.skill.lease");
  const longTaskSymbol = Symbol.for("muad.longtask.manager");
  globalThis[sessionSymbol] = { loaded: true, version: 1 };
  globalThis[browserSymbol] = { snapshot: () => ({ active: 0, queued: 0, limit: 2 }) };
  globalThis[skillSymbol] = { snapshot: () => ({ active: 0, queued: 0, limit: 4 }) };
  globalThis[longTaskSymbol] = { snapshot: () => ({ active: 0, queued: 0, limit: 2 }) };
  t.after(() => {
    delete globalThis[sessionSymbol];
    delete globalThis[browserSymbol];
    delete globalThis[skillSymbol];
    delete globalThis[longTaskSymbol];
  });
}

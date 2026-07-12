import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyRuntimeConfig } from "../inject-multi-user-config.mjs";
import { canonicalHash, renderOpenClawConfig } from "../openclaw-config-renderer.mjs";
import { parseRuntimeConfig, readRuntimeConfig } from "../runtime-config-schema.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");

test("Runtime DTO env and stdin inputs are equivalent and strict", () => {
  const fromEnv = readRuntimeConfig({ env: { MUAD_RUNTIME_CONFIG: fixtureText }, stdinText: "" });
  const fromStdin = readRuntimeConfig({ env: {}, stdinText: fixtureText });
  assert.deepEqual(fromEnv, fromStdin);

  const unknown = structuredClone(fromEnv);
  unknown.routes[0].unexpected = true;
  assert.throws(() => parseRuntimeConfig(unknown), /unknown field/);
  assert.throws(() => parseRuntimeConfig({ ...fromEnv, version: 2 }), /unsupported runtime version/);
});

test("renderer produces strict routes, isolated profiles, providers and plugin entries", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const baseline = {
    _comment: "must be removed",
    gateway: { mode: "local" },
    agents: { defaults: { systemPrompt: "removed", contextTokens: 32000 } },
    browser: { headless: true, extraArgs: ["--disable-dev-shm-usage"] },
    plugins: {
      allow: ["wecom-openclaw-plugin"],
      load: { paths: ["/opt/muad/channel"] },
    },
  };
  const output = renderOpenClawConfig(runtime, baseline);

  assert.equal(output._comment, undefined);
  assert.equal(output.channels.wecom.botId, "test-bot");
  assert.equal(output.channels["openclaw-weixin"].enabled, true);
  assert.equal(output.agents.defaults.systemPrompt, undefined);
  assert.equal(output.agents.list[0].id, "main");
  assert.equal(output.agents.list[0].default, true);
  assert.equal(output.agents.list[1].tools.fs.workspaceOnly, true);
  assert.deepEqual(output.agents.list[1].tools.deny, ["exec", "shell"]);
  assert.equal(output.bindings[0].match.channel, "openclaw-weixin");
  assert.deepEqual(output.bindings[0].match.peer, { kind: "direct", id: "wx-alice" });
  assert.deepEqual(output.session.identityLinks.alice, ["openclaw-weixin:wx-alice", "wecom:XuWenBin"]);
  assert.equal(output.browser.defaultProfile, "quarantine");
  assert.equal(output.browser.profiles.alice.cdpPort, 18802);
  assert.match(output.browser.profiles.alice.color, /^#[0-9A-F]{6}$/u);
  assert.equal(output.browser.profiles.quarantine.color, "#6B7280");
  assert.notEqual(output.browser.profiles.alice.color, output.browser.profiles.quarantine.color);
  assert.equal(output.models.providers["user-alice-deepseek"].apiKey, "alice-key");
  assert.equal(output.plugins.entries["session-manager"].enabled, true);
  assert.equal(output.plugins.entries["session-manager"].config.consoleInternalURL, runtime.consoleInternalUrl);
  assert.equal(output.plugins.entries["muad-run-skill"].config.maxConcurrency, runtime.concurrency.maxSkills);
  assert.equal(output.plugins.bundledDiscovery, "allowlist");
  assert.equal(output.plugins.entries["muad-runtime-guard"].config.generation, 7);
  assert.deepEqual(output.plugins.entries["muad-runtime-guard"].hooks, {
    allowConversationAccess: true,
  });
  assert.equal(
    output.plugins.entries["muad-runtime-guard"].config.serviceTokenFile,
    runtime.serviceTokenFile,
  );
  assert.deepEqual(
    output.plugins.entries["muad-runtime-guard"].config.sessionAgentIds,
    runtime.sessionManager.agents.map((agent) => agent.agentId),
  );
  assert.deepEqual(
    output.plugins.allow.filter((id) => id.startsWith("muad") || id === "session-manager"),
    ["muad-run-skill", "muad-runtime-guard", "session-manager"],
  );
});

test("stable rendering and atomic apply create the expected workspace guidance", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const first = renderOpenClawConfig(runtime, { gateway: { port: 18789, mode: "local" } });
  const second = renderOpenClawConfig(runtime, { gateway: { mode: "local", port: 18789 } });
  assert.equal(canonicalHash(first), canonicalHash(second));

  const root = mkdtempSync(join(tmpdir(), "muad-runtime-render-"));
  const appliedRuntime = structuredClone(runtime);
  appliedRuntime.skills.privateRoot = root;
  for (const agent of appliedRuntime.agents) {
    agent.workspace = join(root, `workspace-${agent.id}`);
    agent.agentDir = join(root, "agents", agent.id, "agent");
  }
  appliedRuntime.sessionManager.agents[0].workspace = appliedRuntime.agents[1].workspace;
  appliedRuntime.sessionManager.agents[0].storeDirectory = join(root, "agents", "alice", "session-store");
  const configPath = join(root, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({ _comment: "seed", gateway: { mode: "local" } }));

  const result = applyRuntimeConfig({ runtime: appliedRuntime, configPath });
  const stored = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(stored._comment, undefined);
  assert.equal(result.hash, canonicalHash(stored));
  assert.match(readFileSync(join(appliedRuntime.agents[1].workspace, "AGENTS.md"), "utf8"), /shared memory boundary/i);
});

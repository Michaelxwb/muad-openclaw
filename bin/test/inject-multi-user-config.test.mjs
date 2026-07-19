import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("Runtime DTO accepts older agent payloads without skill filters", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  for (const agent of runtime.agents) delete agent.skills;

  const parsed = parseRuntimeConfig(runtime);
  const output = renderOpenClawConfig(parsed, {});
  assert.deepEqual(
    output.agents.list.map((agent) => agent.skills),
    parsed.agents.map(() => []),
  );
});

test("renderer adds native Skill read access to older business agent policies", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  runtime.agents[1].tools.allow = runtime.agents[1].tools.allow.filter((tool) => tool !== "read");

  const output = renderOpenClawConfig(runtime, {});

  assert.equal(output.agents.list[0].tools.deny.includes("read"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("read"), true);
  assert.equal(output.agents.list[1].tools.fs.workspaceOnly, true);
});

test("Runtime DTO accepts traditional Skill grants without version metadata", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const grant = runtime.skills.agents[0].allowed[0];
  grant.entryType = "traditional-prompt";
  grant.version = "";
  grant.scriptFiles = [];

  const parsed = parseRuntimeConfig(runtime);

  assert.equal(parsed.skills.agents[0].allowed[0].version, "");
});

test("renderer produces strict routes, isolated profiles, providers and plugin entries", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const baseline = {
    _comment: "must be removed",
    gateway: { mode: "local" },
    agents: { defaults: { systemPrompt: "removed", contextTokens: 32000 } },
    browser: { headless: true, extraArgs: ["--disable-dev-shm-usage"] },
    tools: { profile: "coding", alsoAllow: ["browser", "muad_run_skill"] },
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
  assert.deepEqual(output.agents.list[0].skills, []);
  assert.deepEqual(output.agents.list[1].skills, ["web-tools-guide", "xdr-query"]);
  assert.equal(output.agents.list[1].tools.fs.workspaceOnly, true);
  assert.deepEqual(output.agents.list[1].tools.deny, ["exec", "shell"]);
  assert.equal(output.agents.list[0].tools.deny.includes("muad_use_skill"), true);
  assert.equal(output.agents.list[0].tools.deny.includes("read"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("read"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("muad_use_skill"), true);
  assert.equal(output.bindings[0].match.channel, "openclaw-weixin");
  assert.deepEqual(output.bindings[0].match.peer, { kind: "direct", id: "wx-alice" });
  assert.deepEqual(output.session.identityLinks.alice, ["openclaw-weixin:wx-alice", "wecom:XuWenBin"]);
  assert.equal(output.browser.defaultProfile, "quarantine");
  assert.equal(output.browser.profiles.alice.cdpPort, 18802);
  assert.match(output.browser.profiles.alice.color, /^#[0-9A-F]{6}$/u);
  assert.equal(output.browser.profiles.quarantine.color, "#6B7280");
  assert.notEqual(output.browser.profiles.alice.color, output.browser.profiles.quarantine.color);
  assert.equal(output.models.providers["user-alice-deepseek"].apiKey, "alice-key");
  assert.deepEqual(output.tools.alsoAllow, [
    "browser",
    "muad_run_skill",
    "muad_use_skill",
    "session_get_state",
  ]);
  assert.equal(output.plugins.entries["session-manager"].enabled, true);
  assert.equal(output.plugins.entries["session-manager"].config.consoleInternalURL, runtime.consoleInternalUrl);
  assert.equal(output.plugins.entries["muad-run-skill"].config.maxConcurrency, runtime.concurrency.maxSkills);
  assert.deepEqual(output.plugins.entries["muad-run-skill"].hooks, {
    allowConversationAccess: true,
  });
  assert.deepEqual(output.plugins.entries["muad-run-skill"].config.skillPolicies, runtime.skills.agents);
  assert.deepEqual(output.plugins.entries["muad-run-skill"].config.activation, {
    toolName: "muad_use_skill",
    requireBeforeExecution: true,
    detectSkillFileReads: true,
    contextTimeoutMs: 6 * 60 * 60 * 1_000,
    cleanupIntervalMs: 60_000,
  });
  assert.equal(
    output.plugins.entries["muad-run-skill"].config.telemetry.consoleInternalURL,
    runtime.consoleInternalUrl,
  );
  assert.equal(
    output.plugins.entries["muad-run-skill"].config.telemetry.outboxPath,
    `${runtime.skills.privateRoot}/muad/skill-execution-outbox.ndjson`,
  );
  assert.equal(output.skills.entries["__muad-runtime-skill-state"].enabled, true);
  assert.equal(
    output.skills.entries["__muad-runtime-skill-state"].config.generation,
    runtime.generation,
  );
  assert.equal(output.plugins.bundledDiscovery, "allowlist");
  assert.equal(output.plugins.entries["muad-runtime-guard"].config.generation, 7);
  assert.deepEqual(output.plugins.entries["muad-runtime-guard"].config.skillReadRoots, [
    { agentId: "alice", roots: ["/opt/openclaw-skills/xdr-query"] },
  ]);
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
  const userGuidancePath = join(appliedRuntime.agents[1].workspace, "AGENTS.md");
  mkdirSync(appliedRuntime.agents[1].workspace, { recursive: true });
  writeFileSync(userGuidancePath, `# Existing workspace guidance

Keep this custom rule.
- Before using any Skill instructions, scripts, or referenced files, call muad_use_skill with the exact Skill name.
- A successful muad_use_skill result is authoritative: continue the task and never claim that Skill is not enabled.
- For traditional-script Skills, call muad_run_skill only with a script path returned by muad_use_skill; for traditional-prompt Skills, follow the returned instructions with allowed native tools.
- Report a Skill as unavailable only when muad_use_skill rejects the activation.
`);

  const result = applyRuntimeConfig({ runtime: appliedRuntime, configPath });
  const firstGuidance = readFileSync(userGuidancePath, "utf8");
  applyRuntimeConfig({ runtime: appliedRuntime, configPath });
  const secondGuidance = readFileSync(userGuidancePath, "utf8");
  const stored = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(stored._comment, undefined);
  assert.equal(result.hash, canonicalHash(stored));
  assert.match(firstGuidance, /Keep this custom rule/u);
  assert.match(firstGuidance, /muad_use_skill/u);
  assert.match(firstGuidance, /read the exact .*SKILL\.md/iu);
  assert.match(firstGuidance, /every user turn/iu);
  assert.match(firstGuidance, /successful muad_use_skill result is authoritative/u);
  assert.equal(firstGuidance, secondGuidance);
  assert.equal((firstGuidance.match(/muad:skill-activation:start/gu) ?? []).length, 1);
  assert.equal((firstGuidance.match(/Before using any Skill instructions/gu) ?? []).length, 1);
});

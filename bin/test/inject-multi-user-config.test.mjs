import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyRuntimeConfig } from "../inject-multi-user-config.mjs";
import {
  IMAGE_CHANNEL_PLUGIN_SPECS,
  MUAD_RUNTIME_PLUGIN_SPECS,
  pluginRoots,
} from "../image-plugin-paths.mjs";
import { canonicalHash, renderOpenClawConfig } from "../openclaw-config-renderer.mjs";
import {
  parseRuntimeConfig,
  readRuntimeConfig,
  takeRuntimeWarnings,
} from "../runtime-config-schema.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");
const guardManifestPath = fileURLToPath(
  new URL("../../tools/muad-runtime-guard/openclaw.plugin.json", import.meta.url),
);
const guardManifest = JSON.parse(readFileSync(guardManifestPath, "utf8"));

test("Runtime DTO env and stdin inputs are equivalent and strict", () => {
  const fromEnv = readRuntimeConfig({ env: { MUAD_RUNTIME_CONFIG: fixtureText }, stdinText: "" });
  const fromStdin = readRuntimeConfig({ env: {}, stdinText: fixtureText });
  assert.deepEqual(fromEnv, fromStdin);

  const unknown = structuredClone(fromEnv);
  unknown.routes[0].unexpected = true;
  assert.throws(() => parseRuntimeConfig(unknown), /unknown field/);
  assert.throws(() => parseRuntimeConfig({ ...fromEnv, version: 2 }), /unsupported runtime version/);
});

test("Runtime DTO tolerates unknown top-level fields for forward compatibility", () => {
  takeRuntimeWarnings(); // drain any warnings left by earlier tests in this process
  const fromEnv = parseRuntimeConfig(fixtureText);

  // 更新的 console 可能下发本 schema 不认识的新顶层键：必须 warn+ignore 而非抛错，
  // 否则旧镜像 + 新控制面会 inject-env exit 1 → CrashLoopBackOff。
  const newer = { ...structuredClone(fromEnv), futureTopLevel: { anything: true } };
  const parsed = parseRuntimeConfig(newer);
  assert.equal(parsed.podId, fromEnv.podId, "unknown top-level field must not break parsing");
  const warnings = takeRuntimeWarnings();
  assert.equal(warnings.length, 1, `expected 1 forward-compat warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /runtime contains unknown field: futureTopLevel/);

  // required-missing 与值类型校验仍然严格（前向兼容只放行未知字段）。
  assert.throws(() => parseRuntimeConfig({ ...fromEnv, version: 2 }), /unsupported runtime version/);
  assert.throws(() => parseRuntimeConfig({ ...fromEnv, generation: undefined }), /runtime\.generation/);
  // 嵌套对象里的未知字段仍视为契约违约（内层不做前向兼容）。
  const nested = structuredClone(fromEnv);
  nested.routes[0].unexpected = true;
  assert.throws(() => parseRuntimeConfig(nested), /unknown field/);
});

test("Runtime DTO accepts older agent payloads without skill filters", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  for (const agent of runtime.agents) delete agent.skills;

  const parsed = parseRuntimeConfig(runtime);
  const output = renderOpenClawConfig(parsed, {});
  // No per-agent skills allowlist is rendered (openclaw unrestricted semantics).
  for (const agent of output.agents.list) {
    assert.equal(Object.hasOwn(agent, "skills"), false, "agents.list[].skills must be absent");
  }
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
      installs: {
        mattermost: {
          source: "npm",
          installPath: "/home/node/.openclaw/npm/projects/mattermost/node_modules/@openclaw/mattermost",
        },
      },
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
  assert.equal(Object.hasOwn(output.agents.list[0], "skills"), false, "no skills allowlist for agent 0");
  assert.equal(Object.hasOwn(output.agents.list[1], "skills"), false, "no skills allowlist for agent 1");
  assert.equal(output.agents.list[1].tools.fs.workspaceOnly, true);
  assert.equal(output.agents.list[1].tools.deny, undefined);
  assert.equal(output.agents.list[0].tools.deny.includes("muad_use_skill"), false);
  assert.equal(output.agents.list[0].tools.deny.includes("muad_run_skill"), false);
  assert.equal(output.agents.list[0].tools.deny.includes("read"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("read"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("write"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("exec"), true);
  assert.equal(output.agents.list[1].tools.allow.includes("muad_use_skill"), false);
  assert.equal(output.agents.list[1].tools.allow.includes("muad_run_skill"), false);
  assert.equal(output.bindings[0].match.channel, "openclaw-weixin");
  assert.deepEqual(output.bindings[0].match.peer, { kind: "direct", id: "wx-alice" });
  assert.deepEqual(output.session.identityLinks.alice, ["openclaw-weixin:wx-alice", "wecom:XuWenBin"]);
  assert.equal(output.browser.defaultProfile, "quarantine");
  assert.equal(output.browser.profiles.alice.cdpPort, 18802);
  assert.match(output.browser.profiles.alice.color, /^#[0-9A-F]{6}$/u);
  assert.equal(output.browser.profiles.quarantine.color, "#6B7280");
  assert.notEqual(output.browser.profiles.alice.color, output.browser.profiles.quarantine.color);
  assert.equal(output.models.providers["user-alice-deepseek"].apiKey, "alice-key");
  assert.deepEqual(output.tools.alsoAllow, ["browser", "session_get_state"]);
  assert.deepEqual(output.skills.load.extraDirs, [
    "/opt/openclaw-skills",
  ]);
  assert.equal(output.plugins.entries["session-manager"].enabled, true);
  assert.equal(output.plugins.installs, undefined);
  assert.equal(output.plugins.entries["session-manager"].config.consoleInternalURL, runtime.consoleInternalUrl);
  assert.deepEqual(
    output.plugins.entries["session-manager"].config.agentProfiles,
    runtime.guard.agentProfiles,
  );
  assert.equal(output.plugins.entries["muad-run-skill"], undefined);
  assert.equal(output.skills.entries?.["__muad-runtime-skill-state"], undefined);
  assert.equal(output.plugins.bundledDiscovery, "allowlist");
  assert.equal(output.plugins.entries["muad-runtime-guard"].config.generation, 7);
  assert.equal(output.plugins.entries["muad-runtime-guard"].config.maxLongTaskConcurrency, 2);
  assert.deepEqual(output.plugins.entries["muad-runtime-guard"].config.skillReadRoots, [
    { agentId: "alice", roots: ["/opt/openclaw-skills", "/tmp/muad-runtime/workspace-alice/skills"] },
  ]);
  // Public/private 目录级 grant（dir:true）无条件发出 → Skill 增删不改字节；
  // 只有 system Skill 保持 per-Skill。占位 name 经 sanitize 保持 schema-valid。
  assert.deepEqual(output.plugins.entries["muad-runtime-guard"].config.skillAuditGrants, [
    { agentId: "alice", name: "openclaw-skills", rootPath: "/opt/openclaw-skills", source: "public", dir: true },
    { agentId: "alice", name: "skills", rootPath: "/tmp/muad-runtime/workspace-alice/skills", source: "private", dir: true },
  ]);
  assert.deepEqual(output.plugins.entries["muad-runtime-guard"].config.longTaskSkillGrants, [
    { agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query" },
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
    ["muad-runtime-guard", "session-manager"],
  );
  assert.deepEqual(
    output.plugins.load.paths,
    [
      "/opt/muad/channel",
      ...pluginRoots(MUAD_RUNTIME_PLUGIN_SPECS),
      ...pluginRoots(IMAGE_CHANNEL_PLUGIN_SPECS),
    ].sort(),
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
  assert.match(firstGuidance, /Memory persistence/u);
  assert.match(firstGuidance, /before saying it is remembered/u);
  assert.match(firstGuidance, /Never say a fact has been saved/u);
  assert.match(firstGuidance, /read the exact .*SKILL\.md/iu);
  assert.match(firstGuidance, /every user turn/iu);
  assert.doesNotMatch(firstGuidance, /muad_use_skill/u);
  assert.doesNotMatch(firstGuidance, /muad_run_skill/u);
  assert.equal(firstGuidance, secondGuidance);
  assert.equal((firstGuidance.match(/muad:skill-activation:start/gu) ?? []).length, 1);
  assert.equal((firstGuidance.match(/Before using any Skill instructions/gu) ?? []).length, 0);
});

test("Runtime DTO locale is optional, accepts zh/en, and rejects other values", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  assert.equal(runtime.locale, undefined, "fixture carries no locale (optional)");
  assert.equal(parseRuntimeConfig({ ...runtime, locale: "zh" }).locale, "zh");
  assert.equal(parseRuntimeConfig({ ...runtime, locale: "en" }).locale, "en");
  assert.throws(() => parseRuntimeConfig({ ...runtime, locale: "fr" }), /locale/);
});

test("renderer passes runtime.locale through to the guard config", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const zh = renderOpenClawConfig(runtime, {});
  assert.equal(zh.plugins.entries["muad-runtime-guard"].config.locale, "zh");

  const english = renderOpenClawConfig({ ...runtime, locale: "en" }, {});
  assert.equal(english.plugins.entries["muad-runtime-guard"].config.locale, "en");
});

test("rendered guard config always satisfies the plugin manifest configSchema", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  for (const locale of ["zh", "en"]) {
    const output = renderOpenClawConfig({ ...runtime, locale }, {});
    const guardConfig = output.plugins.entries["muad-runtime-guard"].config;
    const schema = guardManifest.configSchema;
    const extra = Object.keys(guardConfig).filter((key) => !(key in schema.properties));
    const missing = (schema.required ?? []).filter((key) => !(key in guardConfig));
    assert.deepEqual(extra, [], `locale=${locale} guard config has keys absent from configSchema`);
    assert.deepEqual(missing, [], `locale=${locale} guard config misses configSchema required keys`);
    for (const [key, value] of Object.entries(guardConfig)) {
      if (schema.properties[key]?.enum) {
        assert.ok(
          schema.properties[key].enum.includes(value),
          `locale=${locale} guard config ${key}=${JSON.stringify(value)} not in enum`,
        );
      }
    }
    // 嵌套 grant 字段同样要落在 additionalProperties:false 的 item schema 内，
    // 否则 OpenClaw 加载插件配置时会整段拒绝（dir 是目录级 grant 的新增字段）。
    for (const grant of guardConfig.skillAuditGrants) {
      const grantSchema = schema.properties.skillAuditGrants.items;
      const grantExtra = Object.keys(grant).filter((key) => !(key in grantSchema.properties));
      const grantMissing = (grantSchema.required ?? []).filter((key) => !(key in grant));
      assert.deepEqual(grantExtra, [], `locale=${locale} grant has keys absent from item schema`);
      assert.deepEqual(grantMissing, [], `locale=${locale} grant misses item schema required keys`);
    }
  }
});

test("renderer maps supportsTools:false to OpenClaw compat.supportsTools", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const target = runtime.providers.find((p) => p.id === "user-alice-deepseek");
  target.supportsTools = false;
  const output = renderOpenClawConfig(runtime, {});
  const provider = output.models.providers["user-alice-deepseek"];
  assert.equal(provider.models[0].compat.supportsTools, false);
});

test("renderer omits compat when supportsTools is true or absent", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const output = renderOpenClawConfig(runtime, {});
  const provider = output.models.providers["user-alice-deepseek"];
  assert.equal(provider.models[0].compat, undefined);
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { injectStartupConfig } from "../inject-env.mjs";
import { applyStartupContext, collectStartupContext } from "../startup-context.mjs";

const scriptPath = fileURLToPath(new URL("../inject-env.mjs", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url));

test("startup context replaces channel credentials and unloads disabled channel plugins", () => {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  const env = {
    CHANNELS: "wechat",
    CHANNEL_CONFIGS: JSON.stringify({ wechat: { botId: "wx-bot", secret: "wx-secret" } }),
    OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
  };
  const baseline = {
    channels: { wecom: { botId: "old", secret: "old" }, "openclaw-weixin": {} },
    plugins: { allow: ["browser", "wecom-openclaw-plugin", "muad-run-skill"] },
  };

  const output = applyStartupContext(baseline, collectStartupContext({ env, runtime }));
  assert.deepEqual(output.gateway.auth, { mode: "token", token: "gateway-test-token" });
  assert.deepEqual(output.channels.wecom, { enabled: false });
  assert.equal(output.channels["openclaw-weixin"].botId, "wx-bot");
  assert.equal(output.channels["openclaw-weixin"].enabled, true);
  assert.deepEqual(output.plugins.allow, ["browser", "muad-run-skill", "openclaw-weixin"]);
});

test("compatibility entry renders equivalent config from env and stdin", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-inject-entry-"));
  const runtime = runtimeForRoot(root);
  const envConfig = join(root, "from-env.json");
  const stdinConfig = join(root, "from-stdin.json");
  writeSeed(envConfig);
  writeSeed(stdinConfig);
  const common = {
    ...process.env,
    CHANNELS: "wecom,wechat",
    CHANNEL_CONFIGS: JSON.stringify({ wecom: { botId: "bot", secret: "test-secret" } }),
    OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
  };

  const fromEnv = runEntry({ ...common, OPENCLAW_CONFIG_PATH: envConfig, MUAD_RUNTIME_CONFIG: JSON.stringify(runtime) });
  const fromStdin = runEntry({ ...common, OPENCLAW_CONFIG_PATH: stdinConfig }, JSON.stringify(runtime));
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.deepEqual(JSON.parse(readFileSync(envConfig, "utf8")), JSON.parse(readFileSync(stdinConfig, "utf8")));
});

test("invalid startup input exits nonzero without replacing the current config", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-inject-invalid-"));
  const configPath = join(root, "openclaw.json");
  const seed = '{"gateway":{"mode":"local"}}\n';
  writeFileSync(configPath, seed);
  const result = runEntry({
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    MUAD_RUNTIME_CONFIG: "{invalid",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid Runtime DTO JSON/);
  assert.equal(readFileSync(configPath, "utf8"), seed);
});

test("compatibility function rejects malformed channel config before applying", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-inject-channel-error-"));
  const runtime = runtimeForRoot(root);
  const configPath = join(root, "openclaw.json");
  writeSeed(configPath);
  assert.throws(
    () => injectStartupConfig({
      env: { MUAD_RUNTIME_CONFIG: JSON.stringify(runtime), CHANNEL_CONFIGS: "[]" },
      configPath,
      writeGuidance: false,
    }),
    /CHANNEL_CONFIGS must be an object/,
  );
});

test("startup preserves a newer persisted runtime generation", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-inject-stale-"));
  const configPath = join(root, "openclaw.json");
  const newerRuntime = runtimeForRoot(root);
  newerRuntime.generation = 8;
  injectStartupConfig({
    env: startupEnv(newerRuntime, "current-bot", "current-token"),
    configPath,
    writeGuidance: false,
  });
  const persistedConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const persistedBotId = persistedConfig.channels.wecom.botId;
  delete persistedConfig.plugins.entries["muad-runtime-guard"].hooks;
  writeFileSync(configPath, `${JSON.stringify(persistedConfig, null, 2)}\n`);

  const staleRuntime = structuredClone(newerRuntime);
  staleRuntime.generation = 7;
  staleRuntime.channels.configs.wecom.botId = "stale-runtime-bot";
  const result = injectStartupConfig({
    env: startupEnv(staleRuntime, "stale-env-bot", "stale-token"),
    configPath,
    writeGuidance: false,
  });

  assert.equal(result.skippedStaleRuntime, true);
  assert.equal(result.preservedGeneration, 8);
  assert.equal(result.runtime.generation, 7);
  const migrated = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(migrated.plugins.entries["muad-runtime-guard"].config.generation, 8);
  assert.equal(migrated.plugins.entries["muad-runtime-guard"].hooks.allowConversationAccess, true);
  assert.equal(migrated.channels.wecom.botId, persistedBotId);
  assert.notEqual(migrated.channels.wecom.botId, "stale-runtime-bot");
});

function runtimeForRoot(root) {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  runtime.skills.privateRoot = root;
  for (const agent of runtime.agents) {
    agent.workspace = join(root, `workspace-${agent.id}`);
    agent.agentDir = join(root, "agents", agent.id, "agent");
  }
  runtime.sessionManager.agents[0].workspace = runtime.agents[1].workspace;
  runtime.sessionManager.agents[0].storeDirectory = join(root, "agents", "alice", "session-store");
  return runtime;
}

function runEntry(env, input) {
  return spawnSync(process.execPath, [scriptPath], { env, input, encoding: "utf8" });
}

function startupEnv(runtime, botId, gatewayToken) {
  return {
    MUAD_RUNTIME_CONFIG: JSON.stringify(runtime),
    CHANNELS: "wecom,wechat",
    CHANNEL_CONFIGS: JSON.stringify({ wecom: { botId, secret: `${botId}-secret` }, wechat: {} }),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };
}

function writeSeed(path) {
  writeFileSync(path, JSON.stringify({
    _comment: "seed",
    gateway: { mode: "local" },
    channels: { wecom: { connectionMode: "websocket" }, "openclaw-weixin": {} },
    plugins: { allow: ["browser", "wecom-openclaw-plugin", "openclaw-weixin"] },
  }));
}

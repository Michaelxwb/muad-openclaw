import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IMAGE_PLUGIN_SPECS,
  NPM_TRUSTED_CHANNEL_PLUGIN_IDS,
  pluginRoots,
} from "../image-plugin-paths.mjs";
import { injectStartupConfig } from "../inject-env.mjs";
import { prepareTransaction, commitTransaction } from "../runtime-config-transaction.mjs";
import {
  applyStartupContext,
  collectStartupContext,
} from "../startup-context.mjs";

const scriptPath = fileURLToPath(new URL("../inject-env.mjs", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/runtime-v1.json", import.meta.url),
);

test("S-17 retained high generation converges through stdin transaction and restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "muad-adopt-converge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "openclaw.json"), runtimeFile = join(root, "runtime.json");
  const old = runtimeForRoot(root); old.generation = 42;
  injectStartupConfig({ env: startupEnv(old, "old-bot", "old-token"), configPath, writeGuidance: false });
  const next = runtimeForRoot(root); next.generation = 1;
  next.channels.configs.wecom.botId = "new-bot";
  writeFileSync(runtimeFile, JSON.stringify(next));
  const env = { ...startupEnv(next, "new-bot", "new-token"), MUAD_RUNTIME_CONFIG_FILE: runtimeFile };
  const adopted = injectStartupConfig({ env, configPath, writeGuidance: false });
  assert.equal(adopted.preservedGeneration, 42);
  assert.equal(adopted.config.gateway.auth.token, "new-token");
  const prepared = prepareTransaction({ runtime: next, configPath });
  assert.equal(prepared.generation, 1);
  commitTransaction({ runtime: next, configPath });
  const restarted = injectStartupConfig({ env, configPath, writeGuidance: false });
  assert.equal(restarted.skippedStaleRuntime, false);
  assert.equal(restarted.config.plugins.entries["muad-runtime-guard"].config.generation, 1);
  assert.equal(restarted.config.channels.wecom.botId, "new-bot");
  assert.equal(restarted.config.gateway.auth.token, "new-token");
  const stale = structuredClone(next); stale.generation = 1;
  const current = structuredClone(next); current.generation = 2;
  writeFileSync(runtimeFile, JSON.stringify(current));
  injectStartupConfig({ env, configPath, writeGuidance: false });
  writeFileSync(runtimeFile, JSON.stringify(stale));
  assert.equal(injectStartupConfig({ env, configPath, writeGuidance: false }).preservedGeneration, 2);
});

test("S-05 startup selects file without waiting for an open stdin pipe", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "muad-startup-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = runtimeForRoot(root), file = join(root, "runtime.json");
  const target = join(root, "openclaw.json");
  writeFileSync(file, JSON.stringify(runtime));
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, MUAD_RUNTIME_CONFIG_FILE: file, MUAD_RUNTIME_CONFIG: "", OPENCLAW_CONFIG_PATH: target },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("file startup blocked on stdin")); }, 2000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).plugins.entries["muad-runtime-guard"].config.generation, runtime.generation);
});

test("S-05 startup preserves file then env then stdin priority", (t) => {
  const root = mkdtempSync(join(tmpdir(), "muad-startup-priority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fileRuntime = runtimeForRoot(root), envRuntime = { ...fileRuntime, generation: 8 };
  const stdinRuntime = { ...fileRuntime, generation: 9 }, file = join(root, "runtime.json");
  writeFileSync(file, JSON.stringify(fileRuntime));
  for (const [index, env, expected] of [
    [0, { MUAD_RUNTIME_CONFIG_FILE: file, MUAD_RUNTIME_CONFIG: JSON.stringify(envRuntime) }, fileRuntime.generation],
    [1, { MUAD_RUNTIME_CONFIG: JSON.stringify(envRuntime) }, 8], [2, {}, 9],
  ]) {
    const target = join(root, `openclaw-${index}.json`);
    const result = runEntry({ ...process.env, MUAD_RUNTIME_CONFIG_FILE: "", MUAD_RUNTIME_CONFIG: "", ...env, OPENCLAW_CONFIG_PATH: target }, JSON.stringify(stdinRuntime));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).plugins.entries["muad-runtime-guard"].config.generation, expected);
  }
});

test("startup context replaces channel credentials and unloads disabled channel plugins", () => {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  const env = {
    CHANNELS: "wechat",
    CHANNEL_CONFIGS: JSON.stringify({
      wechat: { botId: "wx-bot", secret: "wx-secret" },
    }),
    OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
  };
  const baseline = {
    channels: { wecom: { botId: "old", secret: "old" }, "openclaw-weixin": {} },
    plugins: { allow: ["browser", "wecom-openclaw-plugin", "session-manager"] },
  };

  const output = applyStartupContext(
    baseline,
    collectStartupContext({ env, runtime }),
  );
  assert.deepEqual(output.gateway.auth, {
    mode: "token",
    token: "gateway-test-token",
  });
  assert.deepEqual(output.channels.wecom, { enabled: false });
  assert.equal(output.channels["openclaw-weixin"].botId, "wx-bot");
  assert.equal(output.channels["openclaw-weixin"].enabled, true);
  assert.deepEqual(output.plugins.allow, [
    "browser",
    "openclaw-weixin",
    "session-manager",
  ]);
  // 9.8 信任模型：mattermost 必须走 npm 可信安装（entrypoint 负责），不得以镜像路径加载
  assert.deepEqual(
    output.plugins.load.paths,
    [
      "/opt/openclaw-plugins/openclaw-weixin",
      "/opt/openclaw-plugins/wecom-openclaw-plugin",
    ],
  );
});

test("startup context renders Mattermost for Muad binding guard DMs", () => {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  const env = {
    CHANNELS: "mattermost",
    CHANNEL_CONFIGS: JSON.stringify({
      mattermost: {
        baseUrl: "https://mattermost.internal",
        botToken: "mm-token",
        allowPrivateNetwork: "true",
      },
    }),
  };
  const baseline = {
    channels: {
      mattermost: {
        baseUrl: "old-url",
        botToken: "old-token",
        allowPrivateNetwork: "false",
        network: { dangerouslyAllowPrivateNetwork: false },
      },
    },
    plugins: {
      allow: [
        "browser",
        "wecom-openclaw-plugin",
        "openclaw-weixin",
        "session-manager",
      ],
    },
  };

  const output = applyStartupContext(
    baseline,
    collectStartupContext({ env, runtime }),
  );

  assert.deepEqual(output.channels.mattermost, {
    baseUrl: "https://mattermost.internal",
    botToken: "mm-token",
    dmPolicy: "open",
    groupPolicy: "disabled",
    allowFrom: ["*"],
    streaming: { mode: "off" },
    network: { dangerouslyAllowPrivateNetwork: true },
    enabled: true,
  });
  assert.deepEqual(output.plugins.allow, [
    "browser",
    "mattermost",
    "session-manager",
  ]);
  assert.equal(
    output.plugins.load.paths.includes("/opt/openclaw-plugins/mattermost"),
    false,
  );
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
    CHANNEL_CONFIGS: JSON.stringify({
      wecom: { botId: "bot", secret: "test-secret" },
    }),
    OPENCLAW_GATEWAY_TOKEN: "gateway-test-token",
  };

  const fromEnv = runEntry({
    ...common,
    OPENCLAW_CONFIG_PATH: envConfig,
    MUAD_RUNTIME_CONFIG: JSON.stringify(runtime),
  });
  const fromStdin = runEntry(
    { ...common, OPENCLAW_CONFIG_PATH: stdinConfig },
    JSON.stringify(runtime),
  );
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(envConfig, "utf8")),
    JSON.parse(readFileSync(stdinConfig, "utf8")),
  );
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
    () =>
      injectStartupConfig({
        env: {
          MUAD_RUNTIME_CONFIG: JSON.stringify(runtime),
          CHANNEL_CONFIGS: "[]",
        },
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
  persistedConfig.channels.mattermost = {
    baseUrl: "https://mattermost.internal",
    botToken: "mm-token",
    dmPolicy: "open",
    groupPolicy: "disabled",
    allowFrom: ["*"],
    enabled: true,
  };
  persistedConfig.tools = {
    profile: "coding",
    alsoAllow: ["browser", "muad_run_skill"],
  };
  persistedConfig.plugins.allow.push("muad-run-skill");
  persistedConfig.plugins.load = {
    paths: ["/legacy/plugin-path", "/opt/muad/muad-run-skill"],
  };
  persistedConfig.plugins.installs = {
    mattermost: {
      source: "npm",
      installPath: "/home/node/.openclaw/npm/projects/mattermost/node_modules/@openclaw/mattermost",
    },
  };
  delete persistedConfig.plugins.entries["muad-runtime-guard"].hooks;
  persistedConfig.plugins.entries["muad-run-skill"] = {
    enabled: true,
    hooks: { allowConversationAccess: false },
    config: { maxConcurrency: 4 },
  };
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
  assert.deepEqual(result.channels, [
    "mattermost",
    "openclaw-weixin",
    "wecom",
  ]);
  const migrated = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(
    migrated.plugins.entries["muad-runtime-guard"].config.generation,
    8,
  );
  assert.equal(
    migrated.plugins.entries["muad-runtime-guard"].hooks
      .allowConversationAccess,
    true,
  );
  assert.equal(migrated.plugins.entries["muad-run-skill"], undefined);
  assert.equal(migrated.plugins.installs, undefined);
  assert.equal(migrated.plugins.allow.includes("muad-run-skill"), false);
  assert.equal(migrated.plugins.load.paths.includes("/opt/muad/muad-run-skill"), false);
  assert.deepEqual(migrated.tools.alsoAllow, ["browser", "session_get_state"]);
  assert.equal(migrated.channels.wecom.botId, persistedBotId);
  assert.notEqual(migrated.channels.wecom.botId, "stale-runtime-bot");
  assert.deepEqual(
    migrated.plugins.load.paths,
    [
      "/legacy/plugin-path",
      ...pluginRoots(
        IMAGE_PLUGIN_SPECS.filter(
          (spec) => !NPM_TRUSTED_CHANNEL_PLUGIN_IDS.includes(spec.id),
        ),
      ),
    ].sort(),
  );
  // 即使整体保留旧配置，gateway token 也必须刷新为 env 的当前派生 token
  // （删除→重建接管旧 PVC 时旧 token 已随旧 pod 销毁，不刷新则 apply 探测 token_mismatch）。
  assert.equal(migrated.gateway.auth.token, "stale-token");
});

test("adopting a retained PVC refreshes the gateway token while preserving the old config", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-inject-adopt-"));
  const configPath = join(root, "openclaw.json");
  // 旧 pod 留下的配置：generation 高于新 runtime、携带旧 token。
  const oldConfig = {
    gateway: { auth: { mode: "token", token: "old-gateway-token" }, mode: "local" },
    channels: { mattermost: { enabled: true, baseUrl: "https://mm.internal", botToken: "mm-bot" } },
    plugins: {
      allow: ["browser", "mattermost", "session-manager"],
      entries: {
        "muad-runtime-guard": {
          enabled: true,
          config: { generation: 42, mainAgentId: "main", agentProfiles: [], sessionAgentIds: [] },
          hooks: { allowConversationAccess: true },
        },
      },
    },
    tools: { profile: "coding", alsoAllow: ["browser", "session_get_state"] },
  };
  writeFileSync(configPath, `${JSON.stringify(oldConfig, null, 2)}\n`);

  const runtime = runtimeForRoot(root);
  runtime.generation = 1; // 新 pod 的 generation 从 1 重新计数
  const result = injectStartupConfig({
    env: {
      MUAD_RUNTIME_CONFIG: JSON.stringify(runtime),
      CHANNELS: "mattermost",
      CHANNEL_CONFIGS: JSON.stringify({
        mattermost: { baseUrl: "https://mm.internal", botToken: "mm-bot" },
      }),
      OPENCLAW_GATEWAY_TOKEN: "new-derived-token",
    },
    configPath,
    writeGuidance: false,
  });

  assert.equal(result.skippedStaleRuntime, true);
  const migrated = JSON.parse(readFileSync(configPath, "utf8"));
  // 旧配置保留：generation、通道凭证、plugin 结构不变
  assert.equal(migrated.plugins.entries["muad-runtime-guard"].config.generation, 42);
  assert.equal(migrated.channels.mattermost.botToken, "mm-bot");
  assert.equal(migrated.plugins.allow.includes("browser"), true);
  // gateway token 刷新为 env 的新派生 token
  assert.equal(migrated.gateway.auth.token, "new-derived-token");
  assert.equal(migrated.gateway.auth.mode, "token");
});

function runtimeForRoot(root) {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  runtime.skills.privateRoot = root;
  for (const agent of runtime.agents) {
    agent.workspace = join(root, `workspace-${agent.id}`);
    agent.agentDir = join(root, "agents", agent.id, "agent");
  }
  runtime.sessionManager.agents[0].workspace = runtime.agents[1].workspace;
  runtime.sessionManager.agents[0].storeDirectory = join(
    root,
    "agents",
    "alice",
    "session-store",
  );
  return runtime;
}

function runEntry(env, input) {
  return spawnSync(process.execPath, [scriptPath], {
    env,
    input,
    encoding: "utf8",
  });
}

function startupEnv(runtime, botId, gatewayToken) {
  return {
    MUAD_RUNTIME_CONFIG: JSON.stringify(runtime),
    CHANNELS: "wecom,wechat",
    CHANNEL_CONFIGS: JSON.stringify({
      wecom: { botId, secret: `${botId}-secret` },
      wechat: {},
    }),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };
}

function writeSeed(path) {
  writeFileSync(
    path,
    JSON.stringify({
      _comment: "seed",
      gateway: { mode: "local" },
      channels: {
        wecom: { connectionMode: "websocket" },
        "openclaw-weixin": {},
      },
      plugins: {
        allow: ["browser", "wecom-openclaw-plugin", "openclaw-weixin"],
      },
    }),
  );
}

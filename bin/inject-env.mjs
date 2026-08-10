#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  IMAGE_PLUGIN_SPECS,
  ensurePluginLoadPaths,
} from "./image-plugin-paths.mjs";
import { applyRuntimeConfig, defaultConfigPath, loadRuntimeInput } from "./inject-multi-user-config.mjs";
import { canonicalHash, canonicalStringify } from "./openclaw-config-renderer.mjs";
import { takeRuntimeWarnings } from "./runtime-config-schema.mjs";
import { applyStartupContext, collectStartupContext } from "./startup-context.mjs";

const REQUIRED_PROFILE_TOOLS = ["browser", "session_get_state"];
const DEPRECATED_RUNTIME_PLUGINS = new Set(["muad-run-skill"]);
const DEPRECATED_RUNTIME_PLUGIN_ROOTS = new Set(["/opt/muad/muad-run-skill"]);
const DEPRECATED_PROFILE_TOOLS = new Set(["muad_run_skill", "muad_use_skill"]);

export function injectStartupConfig({ env = process.env, stdinText, configPath, writeGuidance = true } = {}) {
  const runtime = loadRuntimeInput({ env, stdinText: stdinText ?? readOptionalStdin(env) });
  const target = configPath ?? defaultConfigPath(env);
  const baseline = readBaseline(target);
  const persistedGeneration = readPersistedGeneration(baseline);
  if (persistedGeneration > runtime.generation) {
    const persisted = applyPersistedRuntimeContract(
      target,
      baseline,
      String(env.OPENCLAW_GATEWAY_TOKEN ?? "").trim(),
    );
    return {
      config: persisted,
      hash: canonicalHash(persisted),
      runtime,
      channels: enabledChannels(persisted),
      preservedGeneration: persistedGeneration,
      skippedStaleRuntime: true,
    };
  }
  const startup = collectStartupContext({ env, runtime });
  const input = applyStartupContext(baseline, startup);
  const result = applyRuntimeConfig({ runtime, configPath: target, baseline: input, writeGuidance });
  return { ...result, runtime, channels: startup.channels, skippedStaleRuntime: false };
}

export function applyPersistedRuntimeContract(configPath, config, gatewayToken = "") {
  const guard = config?.plugins?.entries?.["muad-runtime-guard"];
  let changed = removeDeprecatedRuntimeEntries(config);
  changed = removeManagedPluginInstallRecords(config) || changed;
  changed = ensurePluginLoadPaths(config, IMAGE_PLUGIN_SPECS) || changed;
  changed = ensureConversationHookAccess(guard) || changed;
  changed = ensureProfileTools(config) || changed;
  // gateway token 是控制面从当前 service token 派生的网关凭证，即使整体保留
  // 磁盘上的旧配置也必须刷新——否则删除→重建接管旧 PVC 时（旧 token 已随旧
  // pod 销毁）新 token 无法通过网关鉴权，apply 探测一直 token_mismatch。
  changed = refreshGatewayToken(config, gatewayToken) || changed;
  if (!changed) return config;
  const temporary = `${configPath}.muad.tmp`;
  writeFileSync(temporary, `${canonicalStringify(config, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  return config;
}

function refreshGatewayToken(config, token) {
  if (!token) return false;
  const gateway = isRecord(config.gateway) ? config.gateway : {};
  const auth = isRecord(gateway.auth) ? gateway.auth : {};
  if (auth.mode === "token" && auth.token === token) return false;
  config.gateway = { ...gateway, auth: { mode: "token", token } };
  return true;
}

function ensureProfileTools(config) {
  if (!isRecord(config)) return false;
  const tools = isRecord(config.tools) ? config.tools : {};
  const current = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  const alsoAllow = [...new Set([
    ...current.filter((tool) => !DEPRECATED_PROFILE_TOOLS.has(tool)),
    ...REQUIRED_PROFILE_TOOLS,
  ])].sort();
  if (JSON.stringify(current) === JSON.stringify(alsoAllow)) return false;
  config.tools = { ...tools, alsoAllow };
  return true;
}

function ensureConversationHookAccess(plugin) {
  if (!isRecord(plugin) || plugin.hooks?.allowConversationAccess === true) return false;
  plugin.hooks = { ...(isRecord(plugin.hooks) ? plugin.hooks : {}), allowConversationAccess: true };
  return true;
}

function removeDeprecatedRuntimeEntries(config) {
  let changed = false;
  const plugins = isRecord(config?.plugins) ? config.plugins : undefined;
  if (!plugins) return false;
  if (Array.isArray(plugins.allow)) {
    const nextAllow = plugins.allow.filter((id) => !DEPRECATED_RUNTIME_PLUGINS.has(id));
    changed = nextAllow.length !== plugins.allow.length;
    plugins.allow = nextAllow;
  }
  if (isRecord(plugins.entries)) {
    for (const pluginId of DEPRECATED_RUNTIME_PLUGINS) {
      if (plugins.entries[pluginId] !== undefined) {
        delete plugins.entries[pluginId];
        changed = true;
      }
    }
  }
  if (Array.isArray(plugins.load?.paths)) {
    const nextPaths = plugins.load.paths.filter((root) => !DEPRECATED_RUNTIME_PLUGIN_ROOTS.has(root));
    if (nextPaths.length !== plugins.load.paths.length) {
      plugins.load.paths = nextPaths;
      changed = true;
    }
  }
  return changed;
}

function removeManagedPluginInstallRecords(config) {
  const plugins = isRecord(config?.plugins) ? config.plugins : undefined;
  if (!plugins || plugins.installs === undefined) return false;
  delete plugins.installs;
  return true;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPersistedGeneration(config) {
  const generation = config?.plugins?.entries?.["muad-runtime-guard"]?.config?.generation;
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function enabledChannels(config) {
  const channels = isRecord(config?.channels) ? config.channels : {};
  return Object.keys(channels).filter((id) => channels[id]?.enabled === true).sort();
}

function readOptionalStdin(env) {
  if (String(env.MUAD_RUNTIME_CONFIG ?? "").trim() || process.stdin.isTTY) return "";
  return readFileSync(0, "utf8");
}

function readBaseline(configPath) {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

function main() {
  try {
    const result = injectStartupConfig();
    const generation = result.preservedGeneration ?? result.runtime.generation;
    const source = result.skippedStaleRuntime ? "persisted" : "startup";
    console.log(
      `[inject-env] pod=${result.runtime.podId} generation=${generation} source=${source} channels=[${result.channels.join(",")}] hash=${result.hash}`,
    );
    // 前向兼容：DTO 由更新的 console 渲染、本镜像不认识某些顶层字段时 warn 并继续，
    // 而不是 exit 1 把 Pod 打成 CrashLoopBackOff（老镜像 + 新控制面）。
    for (const warning of takeRuntimeWarnings()) {
      console.log(`[inject-env] warning: ${warning}`);
    }
  } catch (error) {
    console.error(`[inject-env] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

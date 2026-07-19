#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { applyRuntimeConfig, defaultConfigPath, loadRuntimeInput } from "./inject-multi-user-config.mjs";
import { canonicalHash, canonicalStringify } from "./openclaw-config-renderer.mjs";
import { applyStartupContext, collectStartupContext } from "./startup-context.mjs";

const REQUIRED_PROFILE_TOOLS = ["browser", "muad_run_skill", "muad_use_skill", "session_get_state"];

export function injectStartupConfig({ env = process.env, stdinText, configPath, writeGuidance = true } = {}) {
  const runtime = loadRuntimeInput({ env, stdinText: stdinText ?? readOptionalStdin(env) });
  const target = configPath ?? defaultConfigPath(env);
  const baseline = readBaseline(target);
  const persistedGeneration = readPersistedGeneration(baseline);
  if (persistedGeneration > runtime.generation) {
    const persisted = applyPersistedRuntimeContract(target, baseline);
    return {
      config: persisted,
      hash: canonicalHash(persisted),
      runtime,
      channels: runtime.channels.enabled,
      preservedGeneration: persistedGeneration,
      skippedStaleRuntime: true,
    };
  }
  const startup = collectStartupContext({ env, runtime });
  const input = applyStartupContext(baseline, startup);
  const result = applyRuntimeConfig({ runtime, configPath: target, baseline: input, writeGuidance });
  return { ...result, runtime, channels: startup.channels, skippedStaleRuntime: false };
}

export function applyPersistedRuntimeContract(configPath, config) {
  const guard = config?.plugins?.entries?.["muad-runtime-guard"];
  const runSkill = config?.plugins?.entries?.["muad-run-skill"];
  let changed = migrateRunSkillTelemetry(config);
  changed = ensureConversationHookAccess(guard) || changed;
  changed = ensureConversationHookAccess(runSkill) || changed;
  changed = ensureProfileTools(config) || changed;
  if (!changed) return config;
  const temporary = `${configPath}.muad.tmp`;
  writeFileSync(temporary, `${canonicalStringify(config, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  return config;
}

function ensureProfileTools(config) {
  if (!isRecord(config)) return false;
  const tools = isRecord(config.tools) ? config.tools : {};
  const current = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  const alsoAllow = [...new Set([...current, ...REQUIRED_PROFILE_TOOLS])].sort();
  if (JSON.stringify(current) === JSON.stringify(alsoAllow)) return false;
  config.tools = { ...tools, alsoAllow };
  return true;
}

function ensureConversationHookAccess(plugin) {
  if (!isRecord(plugin) || plugin.hooks?.allowConversationAccess === true) return false;
  plugin.hooks = { ...(isRecord(plugin.hooks) ? plugin.hooks : {}), allowConversationAccess: true };
  return true;
}

function migrateRunSkillTelemetry(config) {
  const pluginConfig = config?.plugins?.entries?.["muad-run-skill"]?.config;
  if (!isRecord(pluginConfig)) return false;
  const legacyURL = pluginConfig.consoleInternalURL;
  const legacyTokenFile = pluginConfig.serviceTokenFile;
  if (legacyURL === undefined && legacyTokenFile === undefined) return false;
  const telemetry = isRecord(pluginConfig.telemetry) ? pluginConfig.telemetry : {};
  if (telemetry.consoleInternalURL === undefined && legacyURL !== undefined) {
    telemetry.consoleInternalURL = legacyURL;
  }
  if (telemetry.serviceTokenFile === undefined && legacyTokenFile !== undefined) {
    telemetry.serviceTokenFile = legacyTokenFile;
  }
  pluginConfig.telemetry = telemetry;
  delete pluginConfig.consoleInternalURL;
  delete pluginConfig.serviceTokenFile;
  return true;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPersistedGeneration(config) {
  const generation = config?.plugins?.entries?.["muad-runtime-guard"]?.config?.generation;
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
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
  } catch (error) {
    console.error(`[inject-env] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

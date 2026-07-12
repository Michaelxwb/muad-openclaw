#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { applyRuntimeConfig, defaultConfigPath, loadRuntimeInput } from "./inject-multi-user-config.mjs";
import { canonicalHash, canonicalStringify } from "./openclaw-config-renderer.mjs";
import { applyStartupContext, collectStartupContext } from "./startup-context.mjs";

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
  if (!guard || guard.hooks?.allowConversationAccess === true) return config;
  guard.hooks = { ...(guard.hooks ?? {}), allowConversationAccess: true };
  const temporary = `${configPath}.muad.tmp`;
  writeFileSync(temporary, `${canonicalStringify(config, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  return config;
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

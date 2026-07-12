#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { canonicalHash, canonicalStringify, renderOpenClawConfig, writeAgentGuidance } from "./openclaw-config-renderer.mjs";
import { readRuntimeConfig } from "./runtime-config-schema.mjs";

export function loadRuntimeInput({ env = process.env, stdinText } = {}) {
  const input = stdinText ?? readStdinWhenNeeded(env);
  return readRuntimeConfig({ env, stdinText: input });
}

export function applyRuntimeConfig({ runtime, configPath, baseline, writeGuidance = true }) {
  const input = baseline ?? readBaseline(configPath);
  const rendered = renderOpenClawConfig(runtime, input);
  const serialized = `${canonicalStringify(rendered, 2)}\n`;
  const temporary = `${configPath}.muad.tmp`;
  if (writeGuidance) writeAgentGuidance(runtime);
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, configPath);
  return { config: rendered, hash: canonicalHash(rendered) };
}

export function defaultConfigPath(env = process.env) {
  if (String(env.OPENCLAW_CONFIG_PATH ?? "").trim()) return String(env.OPENCLAW_CONFIG_PATH).trim();
  const state = String(env.OPENCLAW_STATE_DIR ?? "").trim() || `${homedir()}/.openclaw`;
  return `${state}/openclaw.json`;
}

function readStdinWhenNeeded(env) {
  if (String(env.MUAD_RUNTIME_CONFIG ?? "").trim()) return "";
  return readFileSync(0, "utf8");
}

function readBaseline(configPath) {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
}

function main() {
  try {
    const runtime = loadRuntimeInput();
    const result = applyRuntimeConfig({ runtime, configPath: defaultConfigPath() });
    console.log(`[inject-multi-user-config] pod=${runtime.podId} generation=${runtime.generation} hash=${result.hash}`);
  } catch (error) {
    console.error(`[inject-multi-user-config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

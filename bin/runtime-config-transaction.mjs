#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { defaultConfigPath } from "./inject-multi-user-config.mjs";
import {
  canonicalHash,
  canonicalStringify,
  renderOpenClawConfig,
  writeAgentGuidance,
} from "./openclaw-config-renderer.mjs";
import { readRuntimeConfig } from "./runtime-config-schema.mjs";

const CANDIDATE_SUFFIX = ".muad.candidate";
const PREVIOUS_SUFFIX = ".muad.previous";

export function prepareTransaction({ runtime, configPath }) {
  const current = readConfig(configPath);
  const next = renderOpenClawConfig(runtime, current);
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  writeAtomic(candidatePath, `${canonicalStringify(next, 2)}\n`);
  return {
    generation: runtime.generation,
    configHash: canonicalHash(next),
    restartMode: selectRestartMode(current, next),
  };
}

export function validateCandidate(configPath, runner = spawnSync) {
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  if (!existsSync(candidatePath)) throw new Error("runtime config candidate is missing");
  const result = runner("openclaw", ["config", "validate", "--json"], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_CONFIG_PATH: candidatePath },
  });
  if (result.error) throw new Error(`OpenClaw config validation failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`OpenClaw config validation failed: ${validationMessage(result)}`);
  return { valid: true };
}

export function commitTransaction({ runtime, configPath }) {
  const current = readConfig(configPath);
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  const candidate = readConfig(candidatePath);
  const expected = renderOpenClawConfig(runtime, current);
  if (canonicalHash(candidate) !== canonicalHash(expected)) throw new Error("runtime config candidate is stale");
  writeAgentGuidance(runtime);
  copyAtomic(configPath, `${configPath}${PREVIOUS_SUFFIX}`);
  renameSync(candidatePath, configPath);
  return { generation: runtime.generation, configHash: canonicalHash(candidate) };
}

export function rollbackTransaction(configPath) {
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  if (existsSync(candidatePath)) {
    const current = readConfig(configPath);
    abortTransaction(configPath);
    return { generation: runtimeGeneration(current), configHash: canonicalHash(current) };
  }
  const previousPath = `${configPath}${PREVIOUS_SUFFIX}`;
  const previous = readConfig(previousPath);
  copyAtomic(previousPath, configPath);
  abortTransaction(configPath);
  return { generation: runtimeGeneration(previous), configHash: canonicalHash(previous) };
}

export function abortTransaction(configPath) {
  rmSync(`${configPath}${CANDIDATE_SUFFIX}`, { force: true });
  return { aborted: true };
}

export function selectRestartMode(current, next) {
  if (canonicalHash(current) === canonicalHash(next)) return "none";
  if (canonicalHash(current.browser ?? {}) !== canonicalHash(next.browser ?? {})) return "pod";
  return "gateway";
}

function readConfig(path) {
  if (!existsSync(path)) throw new Error(`config file is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid config file ${path}: ${error.message}`);
  }
}

function writeAtomic(path, contents) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

function copyAtomic(source, target) {
  const temporary = `${target}.tmp`;
  copyFileSync(source, temporary);
  renameSync(temporary, target);
}

function runtimeGeneration(config) {
  const value = config?.plugins?.entries?.["muad-runtime-guard"]?.config?.generation;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function validationMessage(result) {
  const output = String(result.stderr || result.stdout || "validation command failed").trim();
  return output.slice(-2048);
}

function readRuntimeFromStdin() {
  return readRuntimeConfig({ env: {}, stdinText: readFileSync(0, "utf8") });
}

function executeMode(mode, configPath) {
  switch (mode) {
    case "prepare":
      return prepareTransaction({ runtime: readRuntimeFromStdin(), configPath });
    case "validate":
      return validateCandidate(configPath);
    case "commit":
      return commitTransaction({ runtime: readRuntimeFromStdin(), configPath });
    case "rollback":
      return rollbackTransaction(configPath);
    case "abort":
      return abortTransaction(configPath);
    default:
      throw new Error(`unsupported transaction mode: ${mode || "(empty)"}`);
  }
}

function main() {
  try {
    const result = executeMode(process.argv[2], defaultConfigPath());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`[runtime-config-transaction] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

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
import { dirname, join, resolve } from "node:path";
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
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/u;

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
  try {
    cleanupStaleMainSessions({ config: candidate, configPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[runtime-config-transaction] stale main session cleanup skipped: ${message}`);
  }
  return { generation: runtime.generation, configHash: canonicalHash(candidate) };
}

export function cleanupStaleMainSessions({ config, configPath }) {
  const mainAgentId = resolveMainAgentId(config);
  const keys = mainBindingSessionKeys(config, mainAgentId);
  const sessionsPath = join(dirname(configPath), "agents", mainAgentId, "sessions", "sessions.json");
  if (keys.length === 0 || !existsSync(sessionsPath)) return { removed: 0 };

  const sessions = readJSONRecord(sessionsPath);
  let removed = 0;
  for (const key of keys.flatMap((key) => [key, `session:${key}`])) {
    if (!hasMissingSessionFile(sessions[key])) continue;
    delete sessions[key];
    removed += 1;
  }
  if (removed > 0) writeAtomic(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`);
  return { removed };
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

function readJSONRecord(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid JSON record: ${path}`);
  }
  return value;
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

function resolveMainAgentId(config) {
  const value = String(config?.plugins?.entries?.["muad-runtime-guard"]?.config?.mainAgentId ?? "main").trim();
  return SAFE_AGENT_ID.test(value) ? value : "main";
}

function mainBindingSessionKeys(config, mainAgentId) {
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  return uniqueStrings(bindings.map((binding) => mainSessionKey(binding, mainAgentId)));
}

function mainSessionKey(binding, mainAgentId) {
  if (binding?.type !== "route") return "";
  if (!binding.agentId || binding.agentId === mainAgentId) return "";
  const channel = String(binding?.match?.channel ?? "").trim();
  const kind = String(binding?.match?.peer?.kind ?? "").trim();
  const peerId = String(binding?.match?.peer?.id ?? "").trim();
  if (!channel || kind !== "direct" || !peerId) return "";
  return `agent:${mainAgentId}:${channel}:direct:${peerId}`;
}

function hasMissingSessionFile(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const sessionFile = String(entry.sessionFile ?? "").trim();
  if (!sessionFile) return true;
  if (sessionFile.startsWith("sqlite:")) return false;
  return !existsSync(resolve(sessionFile));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
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

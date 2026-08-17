#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
const COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SKILL_INVENTORY_TIMEOUT_MS = 15_000;

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
  if (!existsSync(candidatePath))
    throw new Error("runtime config candidate is missing");
  validateOpenClawConfig(candidatePath, runner);
  validateCandidateSkills(candidatePath, readConfig(candidatePath));
  return { valid: true };
}

function validateOpenClawConfig(candidatePath, runner) {
  const result = runner("openclaw", ["config", "validate", "--json"], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_CONFIG_PATH: candidatePath },
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    timeout: SKILL_INVENTORY_TIMEOUT_MS,
  });
  if (result.error)
    throw new Error(
      `OpenClaw config validation failed: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `OpenClaw config validation failed: ${validationMessage(result)}`,
    );
}

export function validateCandidateSkills(candidatePath, config) {
  const stateDir = dirname(candidatePath);
  for (const agent of candidateBusinessAgents(config)) {
    const roots = skillRootsForAgent(config, agent.id, stateDir);
    const actual = agent.skills.filter(
      (skill) =>
        !isSkillDisabled(config, skill) && findSkillInRoots(skill, roots),
    );
    assertAgentSkillsMatch(agent.id, agent.skills, actual);
  }
}

function candidateBusinessAgents(config) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  return agents
    .filter((agent) => agent?.default !== true)
    .map((agent) => {
      const id = String(agent?.id ?? "").trim();
      if (!SAFE_AGENT_ID.test(id))
        throw new Error(
          `OpenClaw skill validation failed: invalid agent ID ${id}`,
        );
      return {
        id,
        skills: uniqueStrings(Array.isArray(agent.skills) ? agent.skills : []),
      };
    });
}

function skillRootsForAgent(config, agentID, stateDir) {
  const roots = [];
  const agent = (
    Array.isArray(config?.agents?.list) ? config.agents.list : []
  ).find((item) => String(item?.id ?? "").trim() === agentID);
  const workspace = String(agent?.workspace ?? "").trim();
  if (workspace) roots.push(join(resolveUserPath(workspace), "skills"));
  roots.push(join(stateDir, "skills"));
  for (const dir of config?.skills?.load?.extraDirs ?? []) {
    const root = String(dir ?? "").trim();
    if (root) roots.push(resolveUserPath(root));
  }
  return uniqueStrings(roots);
}

function isSkillDisabled(config, skill) {
  return config?.skills?.entries?.[skill]?.enabled === false;
}

function findSkillInRoots(skill, roots) {
  return roots.some((root) =>
    findSkillInRoot(skill, root, { dirs: 0, seen: new Set() }, 0),
  );
}

function findSkillInRoot(skill, root, budget, depth) {
  if (budget.dirs > 512 || depth > 6) return false;
  const dir = resolveUserPath(root);
  if (budget.seen.has(dir)) return false;
  budget.seen.add(dir);
  budget.dirs += 1;
  const meta = readOpenClawSkillMetadata(join(dir, "SKILL.md"));
  if (meta) return meta.name === skill;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules",
    )
    .map((entry) => entry.name)
    .sort()
    .slice(0, 256)
    .some((name) => findSkillInRoot(skill, join(dir, name), budget, depth + 1));
}

function readOpenClawSkillMetadata(filePath) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
  } catch {
    return null;
  }
  return parseOpenClawSkillFrontmatter(readFileSync(filePath, "utf8"));
}

function parseOpenClawSkillFrontmatter(markdown) {
  const normalized = String(markdown ?? "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const metadata = {};
  for (const line of normalized.split("\n").slice(1)) {
    const item = line.trim();
    if (item === "---") {
      return metadata.name && metadata.description ? metadata : null;
    }
    const separator = item.indexOf(":");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== "name" && key !== "description") continue;
    metadata[key] = trimFrontmatterString(item.slice(separator + 1));
  }
  return null;
}

function trimFrontmatterString(value) {
  return String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/gu, "");
}

function resolveUserPath(pathValue) {
  const value = String(pathValue ?? "").trim();
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/"))
    return join(process.env.HOME || "", value.slice(2));
  return resolve(value);
}

function assertAgentSkillsMatch(agentID, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((skill) => !actualSet.has(skill));
  const unexpected = actual.filter((skill) => !expectedSet.has(skill));
  if (missing.length === 0 && unexpected.length === 0) return;
  const parts = [];
  if (missing.length > 0)
    parts.push(`missing model-visible Skills: ${missing.join(", ")}`);
  if (unexpected.length > 0)
    parts.push(`unexpected model-visible Skills: ${unexpected.join(", ")}`);
  throw new Error(
    `OpenClaw skill validation failed for agent ${agentID}: ${parts.join("; ")}`,
  );
}

export function commitTransaction({ runtime, configPath }) {
  const current = readConfig(configPath);
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  const candidate = readConfig(candidatePath);
  const expected = renderOpenClawConfig(runtime, current);
  if (canonicalHash(candidate) !== canonicalHash(expected))
    throw new Error("runtime config candidate is stale");
  writeAgentGuidance(runtime);
  copyAtomic(configPath, `${configPath}${PREVIOUS_SUFFIX}`);
  renameSync(candidatePath, configPath);
  try {
    cleanupStaleMainSessions({ config: candidate, configPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[runtime-config-transaction] stale main session cleanup skipped: ${message}`,
    );
  }
  return {
    generation: runtime.generation,
    configHash: canonicalHash(candidate),
  };
}

export function cleanupStaleMainSessions({ config, configPath }) {
  const mainAgentId = resolveMainAgentId(config);
  const keys = mainBindingSessionKeys(config, mainAgentId);
  const sessionsPath = join(
    dirname(configPath),
    "agents",
    mainAgentId,
    "sessions",
    "sessions.json",
  );
  if (keys.length === 0 || !existsSync(sessionsPath)) return { removed: 0 };

  const sessions = readJSONRecord(sessionsPath);
  let removed = 0;
  for (const key of keys.flatMap((key) => [key, `session:${key}`])) {
    if (!hasMissingSessionFile(sessions[key])) continue;
    delete sessions[key];
    removed += 1;
  }
  if (removed > 0)
    writeAtomic(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`);
  return { removed };
}

export function rollbackTransaction(configPath) {
  const candidatePath = `${configPath}${CANDIDATE_SUFFIX}`;
  if (existsSync(candidatePath)) {
    const current = readConfig(configPath);
    abortTransaction(configPath);
    return {
      generation: runtimeGeneration(current),
      configHash: canonicalHash(current),
    };
  }
  const previousPath = `${configPath}${PREVIOUS_SUFFIX}`;
  const previous = readConfig(previousPath);
  copyAtomic(previousPath, configPath);
  abortTransaction(configPath);
  return {
    generation: runtimeGeneration(previous),
    configHash: canonicalHash(previous),
  };
}

export function abortTransaction(configPath) {
  rmSync(`${configPath}${CANDIDATE_SUFFIX}`, { force: true });
  return { aborted: true };
}

export function selectRestartMode(current, next) {
  // bindings / session.identityLinks 变化无法通过 openclaw hybrid watcher 热
  // 加载：reload 分类把 bindings 归为 noop（不触发 hot reload），而 channel
  // 插件在启动时快照配置对象，运行中不会重新读取新 bindings。因此这类变化
  // 必须真实重启 gateway，让插件重新捕获配置（否则绑定后的消息仍按旧路由
  // 落入 main agent）。其余配置变化（agents/skills/plugins 等）由 watcher
  // 分层热加载，无需重启。
  if (bindingStateChanged(current, next)) return "gateway";
  if (canonicalHash(stripRestartNoop(current)) === canonicalHash(stripRestartNoop(next))) {
    return "none";
  }
  return "none";
}

// 比较 bindings 与 session.identityLinks 两个会改变 channel 路由的配置段。
function bindingStateChanged(current, next) {
  return (
    canonicalHash(current?.bindings ?? []) !== canonicalHash(next?.bindings ?? []) ||
    canonicalHash(current?.session?.identityLinks ?? {}) !==
      canonicalHash(next?.session?.identityLinks ?? {})
  );
}

// runtime-guard declares plugins.entries.muad-runtime-guard.config.generation as
// noop (src/index.mjs noopPrefixes); a generation bump is version bookkeeping,
// not a runtime change, so exclude it from the restart-mode byte comparison.
function stripRestartNoop(config) {
  const cleaned = JSON.parse(JSON.stringify(config));
  const guard = cleaned?.plugins?.entries?.["muad-runtime-guard"]?.config;
  if (guard && typeof guard === "object") delete guard.generation;
  return cleaned;
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
  const value =
    config?.plugins?.entries?.["muad-runtime-guard"]?.config?.generation;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function resolveMainAgentId(config) {
  const value = String(
    config?.plugins?.entries?.["muad-runtime-guard"]?.config?.mainAgentId ??
      "main",
  ).trim();
  return SAFE_AGENT_ID.test(value) ? value : "main";
}

function mainBindingSessionKeys(config, mainAgentId) {
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  return uniqueStrings(
    bindings.map((binding) => mainSessionKey(binding, mainAgentId)),
  );
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
  return [
    ...new Set(
      values.map((value) => String(value ?? "").trim()).filter(Boolean),
    ),
  ];
}

function validationMessage(result) {
  const output = String(
    result.stderr || result.stdout || "validation command failed",
  ).trim();
  return output.slice(-2048);
}

function readRuntimeFromStdin() {
  return readRuntimeConfig({ env: {}, stdinText: readFileSync(0, "utf8") });
}

function executeMode(mode, configPath) {
  switch (mode) {
    case "prepare":
      return prepareTransaction({
        runtime: readRuntimeFromStdin(),
        configPath,
      });
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
    console.error(
      `[runtime-config-transaction] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();

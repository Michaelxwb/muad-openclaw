#!/usr/bin/env node
// skill-upload helper: package a user-authored staging skill and POST it to the
// console ingest endpoint so it becomes a platform-managed private Skill.
//
// Usage: node upload-skill.mjs <skillName>
//
// Env / runtime context:
//   - agent workspace: ~/.openclaw/workspace-<agentId>/skill-staging/<name>/
//   - console internal URL + pod service token are read from openclaw.json
//     (plugins.entries.muad-runtime-guard.config) so the agent does not need to
//     know them.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
const CONFIG_PATH = join(STATE_DIR, "openclaw.json");
const INSTALLER = "/opt/muad/private-skill-installer.mjs";
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/u;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function readRuntimeConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return raw.plugins?.entries?.["muad-runtime-guard"]?.config ?? {};
  } catch {
    return {};
  }
}

function findAgentWorkspace() {
  // The agent's workspace dir is workspace-<agentId> under the state dir; the
  // helper runs inside the agent session so the runtime sets OPENCLAW_AGENT_ID.
  const agentId = process.env.OPENCLAW_AGENT_ID;
  if (agentId && SKILL_NAME_RE.test(agentId)) return agentId;
  // Fallback only when there is exactly one workspace (safe). With multiple
  // workspaces an unset identity must not guess, or the Skill would be bound
  // to the wrong user; let the caller fail explicitly instead.
  const workspaces = readdirSync(STATE_DIR).filter(
    (entry) => entry.startsWith("workspace-") && entry !== "workspace",
  );
  if (workspaces.length === 1) return workspaces[0].slice("workspace-".length);
  return "";
}

async function main() {
  const skillName = process.argv[2]?.trim();
  if (!skillName || !SKILL_NAME_RE.test(skillName)) {
    fail("usage: upload-skill.mjs <skillName>");
    return;
  }
  const agentId = findAgentWorkspace();
  if (!agentId) {
    fail("cannot resolve agent workspace (OPENCLAW_AGENT_ID unset)");
    return;
  }
  const staging = join(STATE_DIR, `workspace-${agentId}`, "skill-staging", skillName);
  if (!(await exists(join(staging, "SKILL.md")))) {
    fail(`skill not found in staging: ${skillName}（请确认已在 skill-staging/${skillName}/ 写好 SKILL.md）`);
    return;
  }
  // 1) Package via the installer export command (binary tar.gz on stdout).
  const exported = spawnSync("node", [INSTALLER, "export", "--agent-id", agentId, "--skill-name", skillName], {
    encoding: null, maxBuffer: 25 * 1024 * 1024,
  });
  if (exported.status !== 0) {
    fail(`export failed: ${(exported.stderr || exported.stdout || "export error").toString().trim()}`);
    return;
  }
  // 2) Resolve console internal URL + service token.
  const config = readRuntimeConfig();
  const consoleUrl = config.consoleInternalURL || "";
  const tokenFile = config.serviceTokenFile || "";
  if (!consoleUrl || !tokenFile) {
    fail("console internal URL / service token are unavailable from runtime config");
    return;
  }
  let token;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    fail(`cannot read service token at ${tokenFile}`);
    return;
  }
  // 3) POST to the console ingest endpoint (base64 bundle in JSON body).
  const response = await fetch(`${consoleUrl.replace(/\/$/, "")}/internal/v1/skills/private/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agentId,
      bundleFormat: "tar.gz",
      bundle: exported.stdout.toString("base64"),
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`上传失败：${text}`);
    return;
  }
  process.stdout.write(`Skill「${skillName}」上传成功。\n`);
}

async function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

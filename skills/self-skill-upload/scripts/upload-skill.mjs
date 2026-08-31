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
// 安装器路径可经 MUAD_INSTALLER 覆盖（部署形态不同时无需改脚本），缺省回退硬编码路径。
const DEFAULT_INSTALLER = "/opt/muad/private-skill-installer.mjs";
const INSTALLER = process.env.MUAD_INSTALLER || DEFAULT_INSTALLER;
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
// 内部 API 是固定契约路径，不受 consoleInternalURL 前缀影响（与 long-task-state-client
// 的策略一致），避免带 /internal/v1 前缀的 baseURL 拼出双前缀 404。
const INGEST_PATH = "/internal/v1/skills/private/ingest";
const DEFAULT_INGEST_TIMEOUT_MS = 30_000;

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

const NON_USER_WORKSPACES = new Set(["main", "quarantine", "attestations"]);

function findAgentWorkspace() {
  // 1) Explicit runtime env, when the session manager sets it.
  const agentId = process.env.OPENCLAW_AGENT_ID;
  if (agentId && SKILL_NAME_RE.test(agentId)) return agentId;
  // 2) Derive from the process cwd: agent tools run inside workspace-<agentId>.
  const fromCwd = agentIdFromCwd();
  if (fromCwd) return fromCwd;
  // 3) The guard config lists session agent ids; a single session is unambiguous.
  const fromSessions = singleSessionAgent();
  if (fromSessions) return fromSessions;
  // 4) Last resort: only when there is exactly one workspace (safe). With
  // multiple workspaces an unset identity must not guess, or the Skill would be
  // bound to the wrong user; let the caller fail explicitly instead.
  const workspaces = readdirSync(STATE_DIR).filter(
    (entry) => entry.startsWith("workspace-") && !NON_USER_WORKSPACES.has(entry.slice("workspace-".length)),
  );
  if (workspaces.length === 1) return workspaces[0].slice("workspace-".length);
  return "";
}

function agentIdFromCwd() {
  const segments = process.cwd().split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].startsWith("workspace-")) {
      const id = segments[i].slice("workspace-".length);
      if (id && !NON_USER_WORKSPACES.has(id) && SKILL_NAME_RE.test(id)) return id;
    }
  }
  return "";
}

function singleSessionAgent() {
  const sessionAgents = readRuntimeConfig().sessionAgentIds;
  if (Array.isArray(sessionAgents) && sessionAgents.length === 1) {
    const id = String(sessionAgents[0]);
    if (!NON_USER_WORKSPACES.has(id) && SKILL_NAME_RE.test(id)) return id;
  }
  return "";
}

async function main() {
  let skillName = process.argv[2]?.trim();
  if (!skillName || !SKILL_NAME_RE.test(skillName)) {
    // No/invalid explicit name: auto-detect when exactly one staged Skill
    // exists, otherwise fail with an actionable message.
    const detected = detectStagedSkillName();
    if (!detected.name) {
      fail(detected.message);
      return;
    }
    skillName = detected.name;
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
  // Bundle size is validated by the console ingest endpoint (maxSkillUploadBundleSize);
  // the buffer cap here is only a loose memory guard.
  const exported = spawnSync("node", [INSTALLER, "export", "--agent-id", agentId, "--skill-name", skillName], {
    encoding: null, maxBuffer: 512 * 1024 * 1024,
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
  const posted = await postIngestBundle({
    consoleUrl,
    token,
    agentId,
    skillName,
    bundleBase64: exported.stdout.toString("base64"),
  });
  if (!posted.ok) {
    fail(`上传失败：${formatConsoleError(posted.text)}`);
    return;
  }
  // 上传后 Skill 进入 pending（待审批），保留草稿以便被拒后修改重传；审批通过
  // 生效后由后续流程清理草稿。
  process.stdout.write(`Skill「${skillName}」已提交，请联系管理员审批，审批通过后才会生效。\n`);
}

// POST bundle 到 console ingest 端点。固定契约路径（new URL() 覆盖 pathname，不受
// baseURL 前缀影响）；网络错误（含 30s 超时）一律抛出，由调用方（main）输出稳定文案。
export async function postIngestBundle({
  consoleUrl, token, agentId, skillName, bundleBase64,
  fetch: fetchLike = fetch, timeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
}) {
  const url = ingestURL(consoleUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentId,
        bundleFormat: "tar.gz",
        bundle: bundleBase64,
      }),
    });
    const text = await response.text();
    return { ok: response.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

function ingestURL(consoleUrl) {
  const url = new URL(consoleUrl);
  url.pathname = INGEST_PATH;
  url.search = "";
  url.hash = "";
  return url;
}

function stableUploadError(error) {
  if (error?.name === "AbortError") {
    return `上传失败：连接控制台超时（${DEFAULT_INGEST_TIMEOUT_MS / 1000}s），请稍后重试。`;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `上传失败：无法连接控制台（${reason}）。`;
}

export function formatConsoleError(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "控制台未返回错误详情";
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return trimmed;
  }
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  const lines = [];
  if (message) lines.push(message);
  if (detail && detail !== message) lines.push(`具体原因：${detail}`);
  if (requestId) lines.push(`requestId: ${requestId}`);
  return lines.length > 0 ? lines.join("\n") : trimmed;
}

async function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

// detectStagedSkillName returns the single staged Skill in the current agent's
// skill-staging/ directory, or a message explaining why it cannot auto-pick.
function detectStagedSkillName() {
  const agentId = findAgentWorkspace();
  if (!agentId) return { message: "cannot resolve agent workspace (OPENCLAW_AGENT_ID unset)" };
  const stagingRoot = join(STATE_DIR, `workspace-${agentId}`, "skill-staging");
  let entries;
  try {
    entries = readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return { message: `未在 skill-staging/ 找到草稿 Skill（请先写好 SKILL.md，或指定 skillName）` };
  }
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && SKILL_NAME_RE.test(entry.name),
  );
  if (candidates.length === 1) return { name: candidates[0].name };
  if (candidates.length === 0) {
    return { message: `未在 skill-staging/ 找到草稿 Skill（请先写好 SKILL.md，或指定 skillName）` };
  }
  return {
    message: `skill-staging/ 有多个草稿（${candidates.map((c) => c.name).join("、")}），请指定 skillName`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    fail(stableUploadError(error));
  });
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_ENTRIES = 2048;
const SKILL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const AGENT_ID_RE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const DEFAULT_STATE_DIR = "/home/node/.openclaw";
const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js"]);

export async function installPrivateSkill({ bundle, agentId, stateDir, expectedName, bundleFormat }) {
  validateAgentId(agentId);
  const format = normalizeBundleFormat(bundleFormat);
  const root = path.resolve(stateDir || DEFAULT_STATE_DIR);
  const workspace = path.join(root, `workspace-${agentId}`);
  const skillsRoot = path.join(workspace, "skills");
  await fs.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  await assertWithin(root, skillsRoot);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "muad-private-skill-"));
  try {
    const bundlePath = path.join(tempRoot, format === "zip" ? "bundle.zip" : "bundle.tar.gz");
    await fs.writeFile(bundlePath, bundle, { mode: 0o600 });
    const extractRoot = path.join(tempRoot, "extract");
    await fs.mkdir(extractRoot, { mode: 0o700 });
    await extractBundle(bundlePath, extractRoot, format);
    await assertNoLinks(extractRoot);
    await assertExtractedLimits(extractRoot);
    const skillDir = await findSingleSkillDir(extractRoot);
    const metadata = await readSkillMetadata(skillDir, expectedName);
    const targetDir = path.join(skillsRoot, metadata.name);
    await assertWithin(skillsRoot, targetDir);
    await replaceDirectory(skillDir, targetDir, tempRoot);
    return { ok: true, action: "install", targetDir, ...metadata };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function deletePrivateSkill({ agentId, stateDir, skillName }) {
  validateAgentId(agentId);
  validateSkillName(skillName);
  const root = path.resolve(stateDir || DEFAULT_STATE_DIR);
  const targetDir = path.join(root, `workspace-${agentId}`, "skills", skillName);
  await assertWithin(path.join(root, `workspace-${agentId}`, "skills"), targetDir);
  await fs.rm(targetDir, { recursive: true, force: true });
  return { ok: true, action: "delete", name: skillName, targetDir };
}

async function extractBundle(bundlePath, extractRoot, format) {
  if (format === "zip") {
    await validateZipBundle(bundlePath);
    runUnzip(["-q", bundlePath, "-d", extractRoot]);
    return;
  }
  await validateTarBundle(bundlePath);
  runTar(["-xzf", bundlePath, "-C", extractRoot, "--no-same-owner", "--no-same-permissions"]);
}

async function validateTarBundle(bundlePath) {
  const names = runTar(["-tzf", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  if (names.length === 0) throw new Error("bundle is empty");
  for (const name of names) assertSafeArchivePath(name);
  const verbose = runTar(["-tvzf", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  for (const line of verbose) {
    const type = line[0];
    if (type === "l" || type === "h") throw new Error("bundle must not contain links");
  }
}

async function validateZipBundle(bundlePath) {
  const names = runUnzip(["-Z1", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  if (names.length === 0) throw new Error("bundle is empty");
  for (const name of names) assertSafeArchivePath(name);
  // Reject symlink/hardlink entries before extract (tar path already does this).
  const verbose = runUnzip(["-Z", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  for (const line of verbose) {
    if (/\bs(?:ym)?l(?:ink)?\b/iu.test(line) || /\b->\b/.test(line) || line.includes(" symlink ")) {
      throw new Error("bundle must not contain links");
    }
    // Info-ZIP -Z long listing: attributes often start with 'l' for links.
    const attrs = line.trim().split(/\s+/u)[0] || "";
    if (attrs.startsWith("l") || attrs.includes("lrwx") || attrs.includes("lrwxrwxrwx")) {
      throw new Error("bundle must not contain links");
    }
  }
}

async function readSkillMetadata(skillDir, expectedName) {
  const skillMarkdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const manifestPath = path.join(skillDir, "muad.skill.json");
  const rawManifest = await readJSONIfExists(manifestPath);
  const name = firstSkillName(rawManifest?.name, frontmatterName(skillMarkdown), path.basename(skillDir));
  validateSkillName(name);
  if (expectedName && normalizeSkillName(expectedName) !== name) {
    throw new Error("expected skill name does not match bundle");
  }
  const version = typeof rawManifest?.version === "string" ? rawManifest.version.trim() : "";
  const platforms = normalizePlatforms(rawManifest?.platforms ?? rawManifest?.platform);
  const progressSupported = Boolean(rawManifest?.progress) || /muad-progress/u.test(skillMarkdown);
  const browserRequired = rawManifest?.browserRequired === true ||
    (Array.isArray(rawManifest?.capabilities) && rawManifest.capabilities.includes("browser"));
  const scriptFiles = rawManifest ? [] : await scanTraditionalScripts(skillDir);
  const entryType = rawManifest
    ? "managed"
    : scriptFiles.length > 0 ? "traditional-script" : "traditional-prompt";
  const manifestJSON = JSON.stringify({
    name, version, runtime: rawManifest?.runtime ?? "", mode: rawManifest?.mode ?? "",
    visibility: rawManifest?.visibility ?? "private", platforms, progressSupported,
    browserRequired, entryType, ...(rawManifest ? {} : { scriptFiles }),
  });
  return {
    name, version, platforms, progressSupported, browserRequired, entryType,
    manifestHash: await hashFile(path.join(skillDir, "SKILL.md")), manifestJson: manifestJSON,
  };
}

async function scanTraditionalScripts(skillDir) {
  const scripts = [];
  await scanScriptDirectory(skillDir, skillDir, scripts);
  return scripts.sort((left, right) => left.localeCompare(right));
}

async function scanScriptDirectory(root, current, scripts) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("bundle must not contain symlinks");
    if (entry.isDirectory()) {
      if (!ignoredScriptDirectory(entry.name)) await scanScriptDirectory(root, entryPath, scripts);
      continue;
    }
    if (!entry.isFile() || !SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    scripts.push(path.relative(root, entryPath).split(path.sep).join("/"));
  }
}

function ignoredScriptDirectory(name) {
  return name.startsWith(".") || name === "node_modules" || name === "__pycache__";
}

function normalizePlatforms(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const platforms = raw.map((item) => normalizePlatformName(item)).filter(Boolean);
  return [...new Set(platforms)].sort();
}

async function replaceDirectory(source, target, tempRoot) {
  const parent = path.dirname(target);
  const staging = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const backup = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.bak`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });
  await fs.cp(source, staging, { recursive: true, force: false, dereference: false });
  await assertNoLinks(staging);
  // Prefer rename-over: move live target aside, promote staging, then drop backup.
  let hadTarget = false;
  try {
    await fs.access(target, fsConstants.F_OK);
    hadTarget = true;
  } catch {
    hadTarget = false;
  }
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if (hadTarget) {
      try { await fs.rename(backup, target); } catch { /* best effort restore */ }
    }
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true });
  await fs.chmod(target, 0o700);
  await fs.writeFile(path.join(tempRoot, "installed"), target);
}

async function findSingleSkillDir(root) {
  const found = [];
  await walk(root, async (entryPath, stat) => {
    if (stat.isFile() && path.basename(entryPath) === "SKILL.md") found.push(path.dirname(entryPath));
  });
  if (found.length === 0) throw new Error("bundle must contain SKILL.md");
  found.sort((left, right) => archivePathDepth(root, left) - archivePathDepth(root, right) || left.localeCompare(right));
  return found[0];
}

async function assertNoLinks(root) {
  await walk(root, async (_entryPath, stat) => {
    if (stat.isSymbolicLink()) throw new Error("bundle must not contain symlinks");
  }, { lstat: true });
}

async function assertExtractedLimits(root) {
  let entries = 0;
  let totalBytes = 0;
  await walk(root, async (_entryPath, stat) => {
    entries++;
    if (entries > MAX_EXTRACTED_ENTRIES) throw new Error("bundle contains too many files");
    if (stat.isFile()) totalBytes += stat.size;
    if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("bundle extracted size is too large");
  }, { lstat: true });
}

async function walk(root, visit, options = {}) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const stat = options.lstat ? await fs.lstat(entryPath) : await fs.stat(entryPath);
    await visit(entryPath, stat);
    if (stat.isDirectory()) await walk(entryPath, visit, options);
  }
}

async function readJSONIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest("hex")}`;
}

function assertSafeArchivePath(name) {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error("bundle contains an absolute path");
  }
  for (const part of normalized.split("/")) {
    if (part === "..") throw new Error("bundle contains a parent path segment");
  }
}

async function assertWithin(root, candidate) {
  const realRoot = await realpathAllowMissing(root);
  const realCandidate = await realpathAllowMissing(candidate);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("target path escapes allowed root");
  }
}

async function realpathAllowMissing(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(candidate);
    return path.join(await realpathAllowMissing(parent), path.basename(candidate));
  }
}

function runTar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "tar failed").trim());
  }
  return result;
}

function runUnzip(args) {
  const result = spawnSync("unzip", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "unzip failed").trim());
  }
  return result;
}

function normalizeBundleFormat(value) {
  const format = String(value || "tar.gz").trim().toLowerCase();
  if (format === "tar.gz" || format === "zip") return format;
  throw new Error("invalid bundle format");
}

async function readStdinLimited() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error("bundle exceeds 5 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseArgs(argv) {
  const command = argv[2] ?? "";
  const options = {};
  for (let index = 3; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments");
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function validateAgentId(agentId) {
  if (!AGENT_ID_RE.test(String(agentId ?? ""))) throw new Error("invalid agent id");
}

function validateSkillName(name) {
  if (!SKILL_NAME_RE.test(String(name ?? ""))) throw new Error("invalid skill name");
}

function normalizeSkillName(value) {
  return normalizeIdentifier(value, "-");
}

function firstSkillName(...values) {
  for (const value of values) {
    const name = normalizeSkillName(value);
    if (name) return name;
  }
  return "";
}

function normalizePlatformName(value) {
  const name = normalizeIdentifier(value, "_");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(name) ? name : "";
}

function normalizeIdentifier(value, separator) {
  const normalized = String(value ?? "").trim().toLowerCase();
  let output = "";
  let lastSeparator = false;
  for (const char of normalized) {
    if (/[a-z0-9]/u.test(char)) {
      output += char;
      lastSeparator = false;
    } else if (char === "-" || char === "_" || char === "." || char === " ") {
      if (output && !lastSeparator) {
        output += separator;
        lastSeparator = true;
      }
    }
  }
  output = output.replace(new RegExp(`^${escapeRegExp(separator)}+|${escapeRegExp(separator)}+$`, "gu"), "");
  if (output.length > 64) output = output.slice(0, 64).replace(new RegExp(`${escapeRegExp(separator)}+$`, "u"), "");
  return /^[a-z]/u.test(output) ? output : "";
}

function frontmatterName(markdown) {
  const normalized = String(markdown ?? "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return "";
  for (const line of normalized.split("\n").slice(1)) {
    const item = line.trim();
    if (item === "---") return "";
    if (item.startsWith("name:")) return item.slice("name:".length).trim().replace(/^['"]|['"]$/gu, "");
  }
  return "";
}

function archivePathDepth(root, dir) {
  const relative = path.relative(root, dir);
  if (!relative || relative === ".") return 0;
  return relative.split(path.sep).filter(Boolean).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (command === "install") {
    const bundle = await readStdinLimited();
    return installPrivateSkill({
      bundle, agentId: options["agent-id"], stateDir: options["state-dir"],
      expectedName: options["expected-name"], bundleFormat: options["bundle-format"],
    });
  }
  if (command === "delete") {
    return deletePrivateSkill({
      agentId: options["agent-id"], stateDir: options["state-dir"], skillName: options["skill-name"],
    });
  }
  throw new Error("usage: private-skill-installer.mjs install|delete --agent-id <id>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

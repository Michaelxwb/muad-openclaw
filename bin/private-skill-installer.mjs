#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

// Bundle size is enforced at the console ingest endpoint (maxSkillUploadBundleSize);
// the installer only keeps a loose memory guard on archive buffers.
const MAX_BUNDLE_MEMORY_BYTES = 512 * 1024 * 1024;
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
    const skillDir = await findPrimarySkillDir(extractRoot);
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

export async function listPrivateSkills({ agentId, stateDir }) {
  validateAgentId(agentId);
  const root = path.resolve(stateDir || DEFAULT_STATE_DIR);
  const skillsRoot = path.join(root, `workspace-${agentId}`, "skills");
  await assertWithin(root, skillsRoot);
  const entries = await readDirIfExists(skillsRoot);
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    if (!await fileExists(path.join(skillDir, "SKILL.md"))) continue;
    skills.push({ name: entry.name, manifestHash: await hashSkillDirectory(skillDir) });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, action: "list", skills };
}

// export packages a user-authored skill (staging draft first, then the installed
// real skills dir) as a tar.gz archive whose root member is <skill-name>/, so the
// console skill_bundle validator can resolve SKILL.md. The raw bundle is returned
// for skill-upload to POST to the console ingest endpoint.
export async function exportPrivateSkill({ agentId, stateDir, skillName }) {
  validateAgentId(agentId);
  validateSkillName(skillName);
  const root = path.resolve(stateDir || DEFAULT_STATE_DIR);
  const workspace = path.join(root, `workspace-${agentId}`);
  await assertWithin(root, workspace);
  const stagingDir = path.join(workspace, "skill-staging", skillName);
  const realDir = path.join(workspace, "skills", skillName);
  const stagingOk = await fileExists(path.join(stagingDir, "SKILL.md"));
  const realOk = await fileExists(path.join(realDir, "SKILL.md"));
  if (!stagingOk && !realOk) throw new Error(`skill not found: ${skillName}`);
  const sourceDir = stagingOk ? stagingDir : realDir;
  await assertNoLinks(sourceDir);
  const parentDir = path.dirname(sourceDir);
  const bundle = runTarRaw(["-czf", "-", "-C", parentDir, skillName], MAX_BUNDLE_MEMORY_BYTES);
  return { ok: true, action: "export", name: skillName, bundle, bundleHash: hashBytes(bundle) };
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
  await validateTarGzipMetadata(bundlePath);
}

async function validateZipBundle(bundlePath) {
  const names = runUnzip(["-Z1", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  if (names.length === 0) throw new Error("bundle is empty");
  for (const name of names) assertSafeArchivePath(name);
  const verbose = runUnzip(["-Z", bundlePath]).stdout.split(/\r?\n/u).filter(Boolean);
  for (const line of verbose) {
    const entry = parseZipListingLine(line);
    if (!entry) continue;
    if (entry.attrs.startsWith("l")) {
      throw new Error("bundle must not contain links");
    }
  }
}

async function validateTarGzipMetadata(bundlePath) {
  const stream = createReadStream(bundlePath).pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  const state = newTarValidationState();
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = validateTarBuffer(buffer, state);
    if (state.done) return;
  }
  if (state.entries === 0) throw new Error("bundle is empty");
  if (state.skipRemaining > 0 || state.pendingBody) throw new Error("read skill bundle");
}

function newTarValidationState() {
  return {
    done: false, entries: 0, skipRemaining: 0,
    pendingBody: null, nextPath: "", nextLinkPath: "",
  };
}

function validateTarBuffer(buffer, state) {
  for (;;) {
    if (state.pendingBody) {
      buffer = consumePendingTarBody(buffer, state);
      if (state.pendingBody) break;
      continue;
    }
    if (state.skipRemaining > 0) {
      buffer = skipTarBytes(buffer, state);
      if (state.skipRemaining > 0) break;
      continue;
    }
    if (buffer.length < 512) break;
    if (tarBlockIsEmpty(buffer.subarray(0, 512))) {
      buffer = consumeTarEndBlock(buffer, state);
      if (state.done) break;
      continue;
    }
    const entry = parseTarHeader(buffer.subarray(0, 512));
    buffer = buffer.subarray(512);
    startTarEntryValidation(entry, state);
  }
  return buffer;
}

function skipTarBytes(buffer, state) {
  if (buffer.length <= state.skipRemaining) {
    state.skipRemaining -= buffer.length;
    return Buffer.alloc(0);
  }
  const next = buffer.subarray(state.skipRemaining);
  state.skipRemaining = 0;
  return next;
}

function consumeTarEndBlock(buffer, state) {
  buffer = buffer.subarray(512);
  if (buffer.length >= 512 && tarBlockIsEmpty(buffer.subarray(0, 512))) {
    if (state.entries === 0) throw new Error("bundle is empty");
    state.done = true;
  }
  return buffer;
}

function startTarEntryValidation(entry, state) {
  if (entry.type === "g") throw new Error("bundle contains unsupported tar metadata entries");
  if (entry.type === "L" || entry.type === "K" || entry.type === "x") {
    assertSafeArchivePath(entry.name);
    state.pendingBody = {
      type: entry.type, remaining: entry.size, chunks: [],
      padding: Math.ceil(entry.size / 512) * 512 - entry.size,
    };
    return;
  }
  validateTarPayloadEntry(entry, state);
  state.skipRemaining = Math.ceil(entry.size / 512) * 512;
}

function validateTarPayloadEntry(entry, state) {
  const name = state.nextPath || entry.name;
  const linkPath = state.nextLinkPath || entry.linkName;
  state.nextPath = "";
  state.nextLinkPath = "";
  assertSafeArchivePath(name);
  if (linkPath) assertSafeArchivePath(linkPath);
  state.entries++;
  if (entry.type === "1" || entry.type === "2") throw new Error("bundle must not contain links");
}

function consumePendingTarBody(buffer, state) {
  const body = state.pendingBody;
  const take = Math.min(buffer.length, body.remaining);
  if (take > 0) body.chunks.push(buffer.subarray(0, take));
  body.remaining -= take;
  buffer = buffer.subarray(take);
  if (body.remaining > 0) return buffer;
  applyTarMetadataBody(Buffer.concat(body.chunks), body.type, state);
  state.pendingBody = null;
  state.skipRemaining = body.padding;
  return buffer;
}

function applyTarMetadataBody(body, type, state) {
  if (type === "L") {
    state.nextPath = tarMetadataPath(body);
    assertSafeArchivePath(state.nextPath);
    return;
  }
  if (type === "K") {
    state.nextLinkPath = tarMetadataPath(body);
    assertSafeArchivePath(state.nextLinkPath);
    return;
  }
  const records = parsePaxRecords(body);
  if (records.path) {
    state.nextPath = records.path;
    assertSafeArchivePath(state.nextPath);
  }
  if (records.linkpath) {
    state.nextLinkPath = records.linkpath;
    assertSafeArchivePath(state.nextLinkPath);
  }
}

function parseTarHeader(header) {
  const name = tarHeaderString(header, 0, 100);
  const prefix = tarHeaderString(header, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: parseTarOctal(header, 124, 12),
    type: String.fromCharCode(header[156] || 0),
    linkName: tarHeaderString(header, 157, 100),
  };
}

function tarMetadataPath(body) {
  const end = body.indexOf(0);
  return body.subarray(0, end === -1 ? body.length : end).toString("utf8").trim();
}

function parsePaxRecords(body) {
  const records = {};
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error("bundle contains invalid pax metadata");
    const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > body.length) {
      throw new Error("bundle contains invalid pax metadata");
    }
    const rawRecord = body.subarray(space + 1, offset + length);
    if (rawRecord.length === 0 || rawRecord[rawRecord.length - 1] !== 0x0a) {
      throw new Error("bundle contains invalid pax metadata");
    }
    const record = rawRecord.subarray(0, rawRecord.length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

function tarBlockIsEmpty(block) {
  return block.every((item) => item === 0);
}

function tarHeaderString(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
}

function parseTarOctal(header, offset, length) {
  const raw = tarHeaderString(header, offset, length).replaceAll("\0", "").trim();
  const value = Number.parseInt(raw || "0", 8);
  if (!Number.isFinite(value) || value < 0) throw new Error("bundle contains an invalid file size");
  return value;
}

function parseZipListingLine(line) {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 4 || !/^[dl-][rwxStTs-]{9}$/u.test(fields[0])) return null;
  const size = Number.parseInt(fields[3], 10);
  if (!Number.isFinite(size) || size < 0) throw new Error("bundle contains an invalid file size");
  return { attrs: fields[0], size };
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
  // Progress telemetry is disabled in the minimal runtime until a new audited
  // execution layer owns it end to end.
  const progressSupported = false;
  const browserRequired = rawManifest?.browserRequired === true ||
    (Array.isArray(rawManifest?.capabilities) && rawManifest.capabilities.includes("browser"));
  const longTask = rawManifest?.longTask === true;
  const scriptFiles = rawManifest ? [] : await scanTraditionalScripts(skillDir);
  const entryType = rawManifest
    ? "managed"
    : scriptFiles.length > 0 ? "traditional-script" : "traditional-prompt";
  const manifestJSON = JSON.stringify({
    name, version, runtime: rawManifest?.runtime ?? "", mode: rawManifest?.mode ?? "",
    visibility: rawManifest?.visibility ?? "private", platforms, progressSupported,
    browserRequired, longTask, entryType, ...(rawManifest ? {} : { scriptFiles }),
  });
  return {
    name, version, platforms, progressSupported, browserRequired, entryType,
    longTask, manifestHash: await hashSkillDirectory(skillDir), manifestJson: manifestJSON,
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
  const platforms = [];
  for (const item of raw) {
    if (!String(item ?? "").trim()) continue;
    const platform = normalizePlatformName(item);
    if (!platform) throw new Error("invalid platform dependency");
    platforms.push(platform);
  }
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

async function findPrimarySkillDir(root) {
  const found = [];
  await walk(root, async (entryPath, stat) => {
    if (stat.isFile() && path.basename(entryPath) === "SKILL.md") found.push(path.dirname(entryPath));
  });
  if (found.length === 0) throw new Error("bundle must contain a SKILL.md");
  found.sort((left, right) => {
    const depthDiff = archivePathDepth(root, left) - archivePathDepth(root, right);
    if (depthDiff !== 0) return depthDiff;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const topDepth = archivePathDepth(root, found[0]);
  let topLevelRoots = 1;
  for (const candidate of found.slice(1)) {
    if (archivePathDepth(root, candidate) !== topDepth) break;
    topLevelRoots++;
  }
  if (topLevelRoots > 1) throw new Error("bundle contains multiple top-level Skill roots");
  return found[0];
}

async function assertNoLinks(root) {
  await walk(root, async (_entryPath, stat) => {
    if (stat.isSymbolicLink()) throw new Error("bundle must not contain symlinks");
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
    if (error instanceof SyntaxError) throw new Error("invalid Skill manifest");
    throw error;
  }
}

async function readDirIfExists(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashSkillDirectory(skillDir) {
  const files = [];
  await collectHashFiles(skillDir, skillDir, files);
  files.sort(compareUTF8Path);
  const hash = createHash("sha256");
  const separator = Buffer.from([0]);
  for (const file of files) {
    hash.update(file, "utf8");
    hash.update(separator);
    hash.update(await fs.readFile(path.join(skillDir, file.split("/").join(path.sep))));
    hash.update(separator);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectHashFiles(root, current, files) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Skill directory must not contain symlinks");
    if (entry.isDirectory()) {
      if (!ignoredScriptDirectory(entry.name)) await collectHashFiles(root, entryPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path.relative(root, entryPath).split(path.sep).join("/"));
  }
}

function compareUTF8Path(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertSafeArchivePath(name) {
  const normalized = name.replaceAll("\\", "/");
  if (normalized === "") {
    throw new Error("bundle contains an invalid path");
  }
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

// runTarRaw captures binary stdout (no utf8 re-encoding) for archive packaging.
function runTarRaw(args, maxBuffer) {
  const result = spawnSync("tar", args, { maxBuffer });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "tar failed").toString().trim());
  }
  return result.stdout;
}

function hashBytes(value) {
  const hash = createHash("sha256");
  hash.update(value);
  return "sha256:" + hash.digest("hex");
}

function runUnzip(args) {
  const result = spawnSync("unzip", args, { encoding: "utf8", maxBuffer: MAX_BUNDLE_MEMORY_BYTES });
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
    if (total > MAX_BUNDLE_MEMORY_BYTES) throw new Error("bundle exceeds the memory guard");
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
  if (command === "list") {
    return listPrivateSkills({ agentId: options["agent-id"], stateDir: options["state-dir"] });
  }
  if (command === "export") {
    const result = await exportPrivateSkill({
      agentId: options["agent-id"], stateDir: options["state-dir"], skillName: options["skill-name"],
    });
    // Raw tar.gz goes to stdout so skill-upload can capture and POST it.
    process.stdout.write(result.bundle);
    return;
  }
  throw new Error("usage: private-skill-installer.mjs install|delete|list|export --agent-id <id>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((result) => {
    // export already wrote its binary bundle to stdout; skip the JSON envelope.
    if (result !== undefined) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

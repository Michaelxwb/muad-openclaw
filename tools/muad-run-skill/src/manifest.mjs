import fs from "node:fs/promises";
import path from "node:path";

import { validateDeclaredCommand, verifyManifestCommands } from "./command-policy.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const STEP_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const APPROVAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export async function loadSkillManifest({ skillsRoot, publicSkillsRoot, privateSkillsRoot, skillName }) {
  const name = requireString(skillName, "skill_name");
  if (!NAME_RE.test(name)) throw new Error("skill_name must be kebab-case");
  const publicRoot = publicSkillsRoot ?? skillsRoot;
  const [publicManifest, privateManifest] = await Promise.all([
    loadFromRoot(publicRoot, name, "public", true),
    loadFromRoot(privateSkillsRoot, name, "private", false),
  ]);
  const selected = selectVisibleManifest(publicManifest, privateManifest, name);
  await verifyManifestCommands(selected);
  return selected;
}

function selectVisibleManifest(publicManifest, privateManifest, name) {
  if (!publicManifest && !privateManifest) throw new Error(`muad.skill.json not found for ${name}`);
  if (!publicManifest) return privateManifest;
  if (!privateManifest) return publicManifest;
  if (!approvedOverride(publicManifest, privateManifest)) {
    throw new Error(`private Skill override is not approved for ${name}`);
  }
  return privateManifest;
}

function approvedOverride(publicManifest, privateManifest) {
  const approval = privateManifest.override;
  return Boolean(publicManifest.version && privateManifest.version && approval?.approved === true &&
    approval.publicVersion === publicManifest.version && APPROVAL_RE.test(approval.approvalId ?? ""));
}

async function loadFromRoot(rootValue, name, source, recursive) {
  if (!rootValue) return null;
  const root = path.resolve(rootValue);
  const candidates = await manifestCandidates(root, name, recursive);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) throw new Error(`multiple ${source} manifests found for ${name}`);
  const candidate = candidates[0];
  await assertCandidateWithinRoot(root, candidate.skillDir);
  const manifest = validateManifest(JSON.parse(candidate.rawText), candidate.skillDir);
  if (manifest.visibility && manifest.visibility !== source) {
    throw new Error(`${source} Skill has mismatched visibility`);
  }
  return { ...manifest, source };
}

async function manifestCandidates(root, name, recursive) {
  const direct = path.resolve(root, name);
  const directText = await readOptional(path.join(direct, "muad.skill.json"));
  if (directText !== null) return [{ skillDir: direct, rawText: directText }];
  if (!recursive) return [];
  return findManifestCandidates(root, name, 6);
}

async function findManifestCandidates(root, name, maxDepth) {
  const results = [];
  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    const entries = await readDirectory(directory);
    if (entries.some((entry) => entry.isFile() && entry.name === "muad.skill.json")) {
      const rawText = await fs.readFile(path.join(directory, "muad.skill.json"), "utf8");
      const parsed = JSON.parse(rawText);
      if (parsed && parsed.name === name) results.push({ skillDir: directory, rawText });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        await visit(path.join(directory, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return results;
}

function validateManifest(raw, skillDir) {
  if (!isObject(raw)) throw new Error("manifest must be an object");
  const name = requireString(raw.name, "name");
  if (!NAME_RE.test(name) || raw.runtime !== "script") throw new Error("invalid script manifest");
  if (raw.mode !== "steps" && raw.mode !== "entrypoint") throw new Error("invalid manifest mode");
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  if (stepsRaw.length === 0) throw new Error("steps required");
  const manifest = {
    name, runtime: "script", mode: raw.mode, skillDir,
    progress: validateProgress(raw.progress),
    steps: stepsRaw.map((step, index) => validateStep(step, index, raw.mode)),
  };
  addReleaseMetadata(manifest, raw);
  if (raw.mode === "entrypoint") manifest.entrypoint = validateDeclaredCommand(raw.entrypoint, "entrypoint");
  return manifest;
}

function validateStep(raw, index, mode) {
  if (!isObject(raw)) throw new Error(`steps[${index}] must be an object`);
  const id = requireString(raw.id, `steps[${index}].id`);
  if (!STEP_RE.test(id)) throw new Error(`steps[${index}].id must be kebab/snake case`);
  const step = { id, title: requireString(raw.title, `steps[${index}].title`) };
  if (raw.command !== undefined) {
    step.command = validateDeclaredCommand(raw.command, `steps[${index}].command`);
  } else if (mode === "steps") {
    throw new Error(`steps[${index}].command required in steps mode`);
  }
  return step;
}

function addReleaseMetadata(manifest, raw) {
  if (raw.visibility !== undefined) {
    if (raw.visibility !== "public" && raw.visibility !== "private") throw new Error("invalid visibility");
    manifest.visibility = raw.visibility;
  }
  if (raw.version !== undefined) {
    const version = requireString(raw.version, "version");
    if (!VERSION_RE.test(version)) throw new Error("invalid version");
    manifest.version = version;
  }
  if (raw.override !== undefined) {
    if (!isObject(raw.override)) throw new Error("invalid override approval");
    manifest.override = {
      approved: raw.override.approved === true,
      publicVersion: String(raw.override.publicVersion ?? "").trim(),
      approvalId: String(raw.override.approvalId ?? "").trim(),
    };
  }
}

function validateProgress(raw) {
  if (raw === undefined) return { source: "auto" };
  if (!isObject(raw) || (raw.source !== undefined && raw.source !== "auto" && raw.source !== "manual")) {
    throw new Error("invalid progress configuration");
  }
  return { source: raw.source ?? "auto" };
}

async function assertCandidateWithinRoot(root, skillDir) {
  const [realRoot, realSkill] = await Promise.all([fs.realpath(root), fs.realpath(skillDir)]);
  const relative = path.relative(realRoot, realSkill);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill directory escapes its root");
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readDirectory(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} required`);
  return value.trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

export const testing = { validateManifest, selectVisibleManifest };

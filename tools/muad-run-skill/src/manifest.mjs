import fs from "node:fs/promises";
import path from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const STEP_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} required`);
  }
  return value.trim();
}

function validateCommand(command, field) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  for (const part of command) {
    if (typeof part !== "string" || part.trim() === "") {
      throw new Error(`${field} entries must be non-empty strings`);
    }
  }
  return command;
}

function validateStep(raw, index, mode) {
  if (!isObject(raw)) {
    throw new Error(`steps[${index}] must be an object`);
  }
  const id = requireString(raw.id, `steps[${index}].id`);
  if (!STEP_RE.test(id)) {
    throw new Error(`steps[${index}].id must be kebab/snake case`);
  }
  const title = requireString(raw.title, `steps[${index}].title`);
  const step = { id, title };
  if (raw.command !== undefined) {
    step.command = validateCommand(raw.command, `steps[${index}].command`);
  } else if (mode === "steps") {
    throw new Error(`steps[${index}].command required in steps mode`);
  }
  return step;
}

function validateProgress(raw) {
  if (raw === undefined) {
    return { source: "auto" };
  }
  if (!isObject(raw)) {
    throw new Error("progress must be an object");
  }
  if (raw.source !== undefined && raw.source !== "auto" && raw.source !== "manual") {
    throw new Error("progress.source must be auto or manual");
  }
  return { source: raw.source ?? "auto" };
}

function validateManifest(raw, skillDir) {
  if (!isObject(raw)) {
    throw new Error("manifest must be an object");
  }
  const name = requireString(raw.name, "name");
  if (!NAME_RE.test(name)) {
    throw new Error("name must be kebab-case");
  }
  if (raw.runtime !== "script") {
    throw new Error("runtime must be script");
  }
  if (raw.mode !== "steps" && raw.mode !== "entrypoint") {
    throw new Error("mode must be steps or entrypoint");
  }
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  if (stepsRaw.length === 0) {
    throw new Error("steps required");
  }
  const manifest = {
    name,
    runtime: "script",
    mode: raw.mode,
    skillDir,
    progress: validateProgress(raw.progress),
    steps: stepsRaw.map((step, index) => validateStep(step, index, raw.mode)),
  };
  if (raw.mode === "entrypoint") {
    manifest.entrypoint = validateCommand(raw.entrypoint, "entrypoint");
  }
  return manifest;
}

export async function loadSkillManifest({ skillsRoot, skillName }) {
  const name = requireString(skillName, "skill_name");
  if (!NAME_RE.test(name)) {
    throw new Error("skill_name must be kebab-case");
  }
  const root = path.resolve(skillsRoot);
  const direct = path.resolve(root, name);
  const directManifest = path.join(direct, "muad.skill.json");
  const candidates = [];
  try {
    candidates.push({ skillDir: direct, rawText: await fs.readFile(directManifest, "utf8") });
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
  if (candidates.length === 0) {
    candidates.push(...(await findManifestCandidates(root, name, 6)));
  }
  if (candidates.length === 0) {
    throw new Error(`muad.skill.json not found for ${name}`);
  }
  if (candidates.length > 1) {
    throw new Error(`multiple muad.skill.json manifests found for ${name}`);
  }
  const candidate = candidates[0];
  return validateManifest(JSON.parse(candidate.rawText), candidate.skillDir);
}

async function findManifestCandidates(root, name, maxDepth) {
  const results = [];
  async function visit(dir, depth) {
    if (depth > maxDepth) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const hasManifest = entries.some((entry) => entry.isFile() && entry.name === "muad.skill.json");
    if (hasManifest) {
      const rawText = await fs.readFile(path.join(dir, "muad.skill.json"), "utf8");
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && parsed.name === name) {
          results.push({ skillDir: dir, rawText });
        }
      } catch {
        // Invalid JSON is reported only when this candidate is selected by direct path.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return results;
}

export const testing = { validateManifest };

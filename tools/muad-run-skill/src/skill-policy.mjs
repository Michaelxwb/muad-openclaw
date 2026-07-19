import path from "node:path";

const ENTRY_TYPES = new Set(["managed", "traditional-script", "traditional-prompt"]);

export function normalizeSkillPolicies(rawPolicies) {
  const policies = new Map();
  if (!Array.isArray(rawPolicies)) return policies;
  for (const rawPolicy of rawPolicies) {
    if (!isObject(rawPolicy) || typeof rawPolicy.agentId !== "string") continue;
    const grants = new Map();
    for (const rawGrant of Array.isArray(rawPolicy.allowed) ? rawPolicy.allowed : []) {
      const grant = normalizeGrant(rawGrant);
      if (grant) grants.set(grant.name, grant);
    }
    policies.set(rawPolicy.agentId, grants);
  }
  return policies;
}

export function findSkillGrantByPath(policies, agentId, derivedPaths) {
  const grants = policies instanceof Map ? policies.get(agentId) : null;
  if (!(grants instanceof Map) || !Array.isArray(derivedPaths)) return null;
  const candidates = [...grants.values()].sort((left, right) =>
    right.rootPath.length - left.rootPath.length);
  for (const candidatePath of derivedPaths) {
    if (typeof candidatePath !== "string" || !path.isAbsolute(candidatePath)) continue;
    const resolved = path.resolve(candidatePath);
    const grant = candidates.find((item) => path.join(item.rootPath, "SKILL.md") === resolved);
    if (grant) return grant;
  }
  return null;
}

export function resolveSkillGrant(policies, agentId, skillName) {
  const grants = policies instanceof Map ? policies.get(agentId) : null;
  const grant = grants instanceof Map ? grants.get(skillName) : null;
  if (!grant) throw new Error(`Skill ${skillName} is not enabled for agent ${agentId}`);
  return grant;
}

export function listSkillGrants(policies, agentId) {
  const grants = policies instanceof Map ? policies.get(agentId) : null;
  if (!(grants instanceof Map)) return [];
  return [...grants.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function manifestSourceForGrant(source) {
  return source === "private" ? "private" : "public";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeGrant(rawGrant) {
  if (!isObject(rawGrant)) return null;
  const name = stringValue(rawGrant.name);
  const source = stringValue(rawGrant.source);
  const skillId = stringValue(rawGrant.skillId);
  const version = stringValue(rawGrant.version);
  const entryType = stringValue(rawGrant.entryType);
  const rootPath = stringValue(rawGrant.rootPath);
  if (!name || !skillId || !["system", "public", "private"].includes(source) ||
    !ENTRY_TYPES.has(entryType) || !path.isAbsolute(rootPath)) return null;
  const scriptFiles = normalizeScriptFiles(rawGrant.scriptFiles);
  if (scriptFiles === null) return null;
  return { name, source, skillId, version, entryType, rootPath: path.resolve(rootPath), scriptFiles };
}

function normalizeScriptFiles(value) {
  if (!Array.isArray(value)) return [];
  const files = [];
  for (const item of value) {
    const file = stringValue(item);
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/u).includes("..")) return null;
    files.push(file);
  }
  return files;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

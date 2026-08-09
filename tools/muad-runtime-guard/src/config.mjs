import { POD_SERVICE_TOKEN_FILE } from "./binding-client.mjs";

const ID_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;

export function parseGuardConfig(value) {
  const input = isRecord(value) ? value : {};
  const generation = input.generation;
  const mainAgentId = String(input.mainAgentId ?? "").trim();
  const quarantineProfile = String(input.quarantineProfile ?? "").trim();
  const consoleInternalURL = String(input.consoleInternalURL ?? "").trim();
  const serviceTokenFile = String(input.serviceTokenFile ?? "").trim();
  const agentProfiles = parseAgentProfiles(input.agentProfiles);
  const skillReadRoots = parseSkillReadRoots(input.skillReadRoots);
  const longTaskSkillGrants = parseLongTaskSkillGrants(input.longTaskSkillGrants);
  const sessionAgentIds = parseAgentIds(input.sessionAgentIds);
  const maxBrowserConcurrency = input.maxBrowserConcurrency;
  const maxSkillConcurrency = input.maxSkillConcurrency;
  const maxLongTaskConcurrency = input.maxLongTaskConcurrency;
  const valid = Number.isInteger(generation) && generation > 0 && mainAgentId === "main" &&
    ID_PATTERN.test(quarantineProfile) && validURL(consoleInternalURL) &&
    serviceTokenFile === POD_SERVICE_TOKEN_FILE && agentProfiles !== null && sessionAgentIds !== null &&
    skillReadRoots !== null && sameAgentSet(agentProfiles, sessionAgentIds) &&
    longTaskSkillGrants !== null && longTaskGrantsUseMappedAgents(agentProfiles, longTaskSkillGrants) &&
    sameSkillRootAgentSet(agentProfiles, skillReadRoots) &&
    agentProfiles.every((mapping) => mapping.profile !== quarantineProfile) &&
    positiveInteger(maxBrowserConcurrency) && positiveInteger(maxSkillConcurrency) &&
    positiveInteger(maxLongTaskConcurrency);
  return {
    valid,
    generation: valid ? generation : 0,
    mainAgentId: valid ? mainAgentId : "main",
    quarantineProfile,
    consoleInternalURL,
    serviceTokenFile,
    agentProfiles: agentProfiles ?? [],
    skillReadRoots: skillReadRoots ?? [],
    longTaskSkillGrants: longTaskSkillGrants ?? [],
    sessionAgentIds: sessionAgentIds ?? [],
    maxBrowserConcurrency: positiveInteger(maxBrowserConcurrency) ? maxBrowserConcurrency : 1,
    maxSkillConcurrency: positiveInteger(maxSkillConcurrency) ? maxSkillConcurrency : 1,
    maxLongTaskConcurrency: positiveInteger(maxLongTaskConcurrency) ? maxLongTaskConcurrency : 1,
  };
}

function parseLongTaskSkillGrants(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const agentId = String(item.agentId ?? "").trim();
    const name = String(item.name ?? "").trim();
    const rootPath = String(item.rootPath ?? "").trim();
    const key = `${agentId}/${name}`;
    if (!ID_PATTERN.test(agentId) || agentId === "main" || !SKILL_NAME_PATTERN.test(name) ||
      !rootPath.startsWith("/") || rootPath.includes("\0") || seen.has(key)) return null;
    seen.add(key);
    output.push({ agentId, name, rootPath });
  }
  return output;
}

function longTaskGrantsUseMappedAgents(profiles, grants) {
  const agents = new Set(profiles.map((profile) => profile.agentId));
  return grants.every((grant) => agents.has(grant.agentId));
}

function parseSkillReadRoots(value) {
  if (!Array.isArray(value)) return null;
  const agents = new Set();
  const output = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.roots)) return null;
    const agentId = String(item.agentId ?? "").trim();
    const roots = item.roots.map((root) => String(root ?? "").trim());
    if (!ID_PATTERN.test(agentId) || agentId === "main" || agents.has(agentId) ||
      roots.some((root) => !root || !root.startsWith("/") || root.includes("\0")) ||
      new Set(roots).size !== roots.length) return null;
    agents.add(agentId);
    output.push({ agentId, roots });
  }
  return output;
}

function sameSkillRootAgentSet(profiles, mappings) {
  if (profiles.length !== mappings.length) return false;
  const expected = new Set(profiles.map((profile) => profile.agentId));
  return mappings.every((mapping) => expected.has(mapping.agentId));
}

function parseAgentIds(value) {
  if (!Array.isArray(value)) return null;
  const unique = new Set();
  for (const entry of value) {
    const agentId = String(entry ?? "").trim();
    if (!ID_PATTERN.test(agentId) || agentId === "main" || unique.has(agentId)) return null;
    unique.add(agentId);
  }
  return [...unique];
}

function sameAgentSet(profiles, agentIds) {
  if (profiles.length !== agentIds.length) return false;
  const expected = new Set(agentIds);
  return profiles.every((profile) => expected.has(profile.agentId));
}

function parseAgentProfiles(value) {
  if (!Array.isArray(value)) return null;
  const agents = new Set();
  const profiles = new Set();
  const output = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const agentId = String(item.agentId ?? "").trim();
    const profile = String(item.profile ?? "").trim();
    if (!ID_PATTERN.test(agentId) || agentId === "main" || !ID_PATTERN.test(profile) ||
      agents.has(agentId) || profiles.has(profile)) return null;
    agents.add(agentId);
    profiles.add(profile);
    output.push({ agentId, profile });
  }
  return output;
}

function validURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

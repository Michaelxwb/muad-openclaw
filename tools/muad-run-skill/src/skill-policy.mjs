export function normalizeSkillPolicies(rawPolicies) {
  const policies = new Map();
  if (!Array.isArray(rawPolicies)) return policies;
  for (const rawPolicy of rawPolicies) {
    if (!isObject(rawPolicy) || typeof rawPolicy.agentId !== "string") continue;
    const grants = new Map();
    for (const rawGrant of Array.isArray(rawPolicy.allowed) ? rawPolicy.allowed : []) {
      if (!isObject(rawGrant) || typeof rawGrant.name !== "string") continue;
      const source = typeof rawGrant.source === "string" ? rawGrant.source : "";
      const skillId = typeof rawGrant.skillId === "string" ? rawGrant.skillId : "";
      if (!["system", "public", "private"].includes(source) || !skillId) continue;
      grants.set(rawGrant.name, { name: rawGrant.name, source, skillId });
    }
    policies.set(rawPolicy.agentId, grants);
  }
  return policies;
}

export function resolveSkillGrant(policies, agentId, skillName) {
  const grants = policies instanceof Map ? policies.get(agentId) : null;
  const grant = grants instanceof Map ? grants.get(skillName) : null;
  if (!grant) throw new Error(`Skill ${skillName} is not enabled for agent ${agentId}`);
  return grant;
}

export function manifestSourceForGrant(source) {
  return source === "private" ? "private" : "public";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

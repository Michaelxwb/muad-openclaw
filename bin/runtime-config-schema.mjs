const RUNTIME_VERSION = 1;
const SERVICE_TOKEN_FILE = "/run/secrets/muad/pod-service-token";
const ID_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

const TOP_LEVEL_KEYS = [
  "version", "podId", "generation", "consoleInternalUrl", "serviceTokenFile",
  "concurrency", "channels", "agents", "routes", "identityLinks", "browser", "providers",
  "platforms", "skills", "sessionManager", "guard",
];

export function parseRuntimeConfig(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new Error(`invalid Runtime DTO JSON: ${error.message}`);
    }
  }
  validateRuntimeConfig(value);
  return value;
}

export function readRuntimeConfig({ env = process.env, stdinText = "" } = {}) {
  const fromEnv = String(env.MUAD_RUNTIME_CONFIG ?? "").trim();
  const source = fromEnv || String(stdinText).trim();
  if (!source) throw new Error("MUAD_RUNTIME_CONFIG or stdin Runtime DTO is required");
  return parseRuntimeConfig(source);
}

export function validateRuntimeConfig(value) {
  assertRecord(value, "runtime");
  assertExactKeys(value, TOP_LEVEL_KEYS, "runtime");
  if (value.version !== RUNTIME_VERSION) throw new Error(`unsupported runtime version: ${value.version}`);
  assertID(value.podId, "runtime.podId");
  assertPositiveInteger(value.generation, "runtime.generation");
  assertURL(value.consoleInternalUrl, "runtime.consoleInternalUrl");
  if (value.serviceTokenFile !== SERVICE_TOKEN_FILE) throw new Error("invalid serviceTokenFile");
  validateConcurrency(value.concurrency);
  validateChannels(value.channels);
  const agents = validateAgents(value.agents);
  validateRoutes(value.routes, agents);
  validateIdentityLinks(value.identityLinks, agents);
  const profiles = validateBrowser(value.browser);
  const providers = validateProviders(value.providers);
  validateAgentModels(value.agents, providers);
  validatePlatforms(value.platforms);
  validateSkills(value.skills, agents);
  validateSessionManager(value.sessionManager, agents);
  validateGuard(value.guard, agents, profiles);
  return value;
}

function validateChannels(value) {
  assertRecord(value, "runtime.channels");
  assertExactKeys(value, ["enabled", "configs"], "runtime.channels");
  assertStringArray(value.enabled, "runtime.channels.enabled");
  assertRecord(value.configs, "runtime.channels.configs");
  if (value.enabled.length === 0 || new Set(value.enabled).size !== value.enabled.length) {
    throw new Error("runtime.channels.enabled is invalid");
  }
  const enabled = new Set(value.enabled);
  for (const [channel, config] of Object.entries(value.configs)) {
    if (!enabled.has(channel)) throw new Error(`runtime.channels.configs.${channel} is not enabled`);
    assertRecord(config, `runtime.channels.configs.${channel}`);
    if (Object.values(config).some((item) => typeof item !== "string")) {
      throw new Error(`runtime.channels.configs.${channel} values must be strings`);
    }
  }
}

function validateConcurrency(value) {
  assertRecord(value, "runtime.concurrency");
  assertExactKeys(value, ["maxSkills", "maxBrowser"], "runtime.concurrency");
  assertPositiveInteger(value.maxSkills, "runtime.concurrency.maxSkills");
  assertPositiveInteger(value.maxBrowser, "runtime.concurrency.maxBrowser");
}

function validateAgents(value) {
  assertArray(value, "runtime.agents");
  if (value.length === 0) throw new Error("runtime.agents must not be empty");
  const ids = new Set();
  value.forEach((agent, index) => {
    const label = `runtime.agents[${index}]`;
    assertRecord(agent, label);
    assertExactKeys(
      agent,
      ["id", "default", "status", "workspace", "agentDir", "browserProfile", "model", "skills", "tools"],
      label,
      ["id", "default", "status", "workspace", "agentDir", "tools"],
    );
    assertID(agent.id, `${label}.id`);
    assertBoolean(agent.default, `${label}.default`);
    if (!["active", "pending"].includes(agent.status)) throw new Error(`${label}.status is invalid`);
    assertAbsolutePath(agent.workspace, `${label}.workspace`);
    assertAbsolutePath(agent.agentDir, `${label}.agentDir`);
    optionalString(agent.browserProfile, `${label}.browserProfile`);
    optionalString(agent.model, `${label}.model`);
    optionalStringArray(agent.skills, `${label}.skills`);
    if (Array.isArray(agent.skills)) assertNoDuplicateStrings(agent.skills, `${label}.skills`);
    validateToolPolicy(agent.tools, `${label}.tools`);
    if (ids.has(agent.id)) throw new Error(`duplicate agent: ${agent.id}`);
    ids.add(agent.id);
  });
  if (value[0].id !== "main" || value[0].default !== true) throw new Error("first agent must be default main");
  if (value.slice(1).some((agent) => agent.default)) throw new Error("only main may be default");
  return ids;
}

function validateToolPolicy(value, label) {
  assertRecord(value, label);
  assertExactKeys(value, ["allow", "deny", "workspaceOnly"], label, ["workspaceOnly"]);
  optionalStringArray(value.allow, `${label}.allow`);
  optionalStringArray(value.deny, `${label}.deny`);
  assertBoolean(value.workspaceOnly, `${label}.workspaceOnly`);
}

function validateRoutes(value, agents) {
  assertArray(value, "runtime.routes");
  value.forEach((route, index) => {
    const label = `runtime.routes[${index}]`;
    assertRecord(route, label);
    assertExactKeys(route, ["agentId", "channel", "accountId", "peerKind", "externalId"], label);
    if (!agents.has(route.agentId) || route.agentId === "main") throw new Error(`${label}.agentId is invalid`);
    ["channel", "accountId", "peerKind", "externalId"].forEach((key) => assertString(route[key], `${label}.${key}`));
    if (!["direct", "group", "channel", "dm"].includes(route.peerKind)) throw new Error(`${label}.peerKind is invalid`);
  });
}

function validateIdentityLinks(value, agents) {
  assertArray(value, "runtime.identityLinks");
  const seen = new Set();
  value.forEach((link, index) => {
    const label = `runtime.identityLinks[${index}]`;
    assertRecord(link, label);
    assertExactKeys(link, ["agentId", "identities"], label);
    if (!agents.has(link.agentId) || link.agentId === "main" || seen.has(link.agentId)) throw new Error(`${label}.agentId is invalid`);
    assertStringArray(link.identities, `${label}.identities`);
    if (link.identities.length === 0 || link.identities.some((identity) => !identity.includes(":"))) throw new Error(`${label}.identities is invalid`);
    seen.add(link.agentId);
  });
}

function validateBrowser(value) {
  assertRecord(value, "runtime.browser");
  assertExactKeys(value, ["defaultProfile", "profiles"], "runtime.browser");
  if (value.defaultProfile !== "quarantine") throw new Error("runtime.browser.defaultProfile must be quarantine");
  assertArray(value.profiles, "runtime.browser.profiles");
  const profiles = new Set();
  const ports = new Set();
  value.profiles.forEach((profile, index) => {
    const label = `runtime.browser.profiles[${index}]`;
    assertRecord(profile, label);
    assertExactKeys(profile, ["id", "driver", "cdpPort"], label);
    assertID(profile.id, `${label}.id`);
    if (!["openclaw", "clawd", "existing-session", "extension"].includes(profile.driver)) throw new Error(`${label}.driver is invalid`);
    assertPort(profile.cdpPort, `${label}.cdpPort`);
    if (profiles.has(profile.id) || ports.has(profile.cdpPort)) throw new Error(`${label} duplicates a profile or port`);
    profiles.add(profile.id);
    ports.add(profile.cdpPort);
  });
  if (!profiles.has("quarantine")) throw new Error("quarantine profile is required");
  return profiles;
}

function validateProviders(value) {
  assertArray(value, "runtime.providers");
  const providers = new Set();
  value.forEach((provider, index) => {
    const label = `runtime.providers[${index}]`;
    assertRecord(provider, label);
    assertExactKeys(provider, ["id", "provider", "baseUrl", "apiKey", "model"], label);
    ["id", "provider", "baseUrl", "model"].forEach((key) => assertString(provider[key], `${label}.${key}`));
    if (typeof provider.apiKey !== "string") throw new Error(`${label}.apiKey must be a string`);
    assertURL(provider.baseUrl, `${label}.baseUrl`);
    if (providers.has(provider.id)) throw new Error(`duplicate provider: ${provider.id}`);
    providers.add(provider.id);
  });
  return providers;
}

function validateAgentModels(agents, providers) {
  agents.forEach((agent) => {
    if (!agent.model) return;
    const separator = agent.model.indexOf("/");
    if (separator <= 0 || !providers.has(agent.model.slice(0, separator))) throw new Error(`agent ${agent.id} references an unknown provider`);
  });
}

function validatePlatforms(value) {
  assertArray(value, "runtime.platforms");
  const ids = new Set();
  value.forEach((platform, index) => {
    const label = `runtime.platforms[${index}]`;
    assertRecord(platform, label);
    assertExactKeys(platform, ["id", "displayName", "config"], label);
    assertString(platform.id, `${label}.id`);
    assertString(platform.displayName, `${label}.displayName`);
    assertRecord(platform.config, `${label}.config`);
    if (ids.has(platform.id)) throw new Error(`duplicate platform: ${platform.id}`);
    ids.add(platform.id);
  });
}

function validateSkills(value, agents) {
  assertRecord(value, "runtime.skills");
  assertExactKeys(value, ["publicDirectory", "privateRoot", "agents"], "runtime.skills");
  assertAbsolutePath(value.publicDirectory, "runtime.skills.publicDirectory");
  assertAbsolutePath(value.privateRoot, "runtime.skills.privateRoot");
  assertArray(value.agents, "runtime.skills.agents");
  const mapped = new Set();
  value.agents.forEach((policy, index) => {
    const label = `runtime.skills.agents[${index}]`;
    assertRecord(policy, label);
    assertExactKeys(policy, ["agentId", "allowed"], label);
    if (!agents.has(policy.agentId) || policy.agentId === "main" || mapped.has(policy.agentId)) {
      throw new Error(`${label}.agentId is invalid`);
    }
    mapped.add(policy.agentId);
    assertArray(policy.allowed, `${label}.allowed`);
    const names = new Set();
    policy.allowed.forEach((skill, skillIndex) => {
      const skillLabel = `${label}.allowed[${skillIndex}]`;
      assertRecord(skill, skillLabel);
      assertExactKeys(
        skill,
        ["name", "source", "skillId", "version", "entryType", "rootPath", "scriptFiles"],
        skillLabel,
      );
      assertString(skill.name, `${skillLabel}.name`);
      assertString(skill.skillId, `${skillLabel}.skillId`);
      optionalString(skill.version, `${skillLabel}.version`);
      assertAbsolutePath(skill.rootPath, `${skillLabel}.rootPath`);
      assertStringArray(skill.scriptFiles, `${skillLabel}.scriptFiles`);
      if (!["managed", "traditional-script", "traditional-prompt"].includes(skill.entryType)) {
        throw new Error(`${skillLabel}.entryType is invalid`);
      }
      if (skill.entryType === "traditional-script" && skill.scriptFiles.length === 0) {
        throw new Error(`${skillLabel}.scriptFiles is required`);
      }
      skill.scriptFiles.forEach((file) => assertRelativeSkillPath(file, `${skillLabel}.scriptFiles`));
      if (!["system", "public", "private"].includes(skill.source)) throw new Error(`${skillLabel}.source is invalid`);
      if (names.has(skill.name)) throw new Error(`duplicate Skill grant: ${skill.name}`);
      names.add(skill.name);
    });
  });
  if (mapped.size !== agents.size - 1) throw new Error("runtime.skills must map every business agent");
}

function assertRelativeSkillPath(value, label) {
  assertString(value, label);
  if (value.startsWith("/") || value === "." || value === ".." || value.startsWith("../") || value.includes("/../")) {
    throw new Error(`${label} must contain relative Skill paths`);
  }
}

function validateSessionManager(value, agents) {
  assertRecord(value, "runtime.sessionManager");
  assertExactKeys(value, ["agents"], "runtime.sessionManager");
  assertArray(value.agents, "runtime.sessionManager.agents");
  const mapped = new Set();
  value.agents.forEach((mapping, index) => {
    const label = `runtime.sessionManager.agents[${index}]`;
    assertRecord(mapping, label);
    assertExactKeys(mapping, ["agentId", "workspace", "storeDirectory"], label);
    if (!agents.has(mapping.agentId) || mapping.agentId === "main" || mapped.has(mapping.agentId)) throw new Error(`${label}.agentId is invalid`);
    assertAbsolutePath(mapping.workspace, `${label}.workspace`);
    assertAbsolutePath(mapping.storeDirectory, `${label}.storeDirectory`);
    mapped.add(mapping.agentId);
  });
  if (mapped.size !== agents.size - 1) throw new Error("session-manager must map every business agent");
}

function validateGuard(value, agents, profiles) {
  assertRecord(value, "runtime.guard");
  assertExactKeys(value, ["mainAgentId", "quarantineProfile", "agentProfiles"], "runtime.guard");
  if (value.mainAgentId !== "main" || value.quarantineProfile !== "quarantine") throw new Error("runtime.guard defaults are invalid");
  assertArray(value.agentProfiles, "runtime.guard.agentProfiles");
  const mapped = new Set();
  value.agentProfiles.forEach((mapping, index) => {
    const label = `runtime.guard.agentProfiles[${index}]`;
    assertRecord(mapping, label);
    assertExactKeys(mapping, ["agentId", "profile"], label);
    if (!agents.has(mapping.agentId) || mapping.agentId === "main" || mapped.has(mapping.agentId)) throw new Error(`${label}.agentId is invalid`);
    if (!profiles.has(mapping.profile) || mapping.profile === "quarantine") throw new Error(`${label}.profile is invalid`);
    mapped.add(mapping.agentId);
  });
  if (mapped.size !== agents.size - 1) throw new Error("Runtime Guard must map every business agent");
}

function assertExactKeys(value, allowed, label, required = allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field: ${unknown[0]}`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing field: ${missing[0]}`);
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function optionalString(value, label) {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function assertStringArray(value, label) {
  assertArray(value, label);
  if (value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} must contain strings`);
}

function optionalStringArray(value, label) {
  if (value !== undefined) assertStringArray(value, label);
}

function assertNoDuplicateStrings(value, label) {
  const seen = new Set();
  for (const item of value) {
    if (seen.has(item)) throw new Error(`${label} must not contain duplicates`);
    seen.add(item);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${label} must be a valid port`);
}

function assertID(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..")) throw new Error(`${label} must be an absolute safe path`);
}

function assertURL(value, label) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("scheme");
  } catch {
    throw new Error(`${label} must be an HTTP URL`);
  }
}

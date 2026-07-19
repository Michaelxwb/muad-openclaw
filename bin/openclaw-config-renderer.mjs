import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRuntimeConfig } from "./runtime-config-schema.mjs";
import { mergeStartupContext, normalizeChannel } from "./startup-context.mjs";

const PLUGIN_PATHS = {
  "muad-run-skill": "/opt/muad/muad-run-skill",
  "session-manager": "/opt/muad/session-manager",
  "muad-runtime-guard": "/opt/muad/muad-runtime-guard",
};
const REQUIRED_PROFILE_TOOLS = ["browser", "muad_run_skill", "muad_use_skill", "session_get_state"];

export function renderOpenClawConfig(runtime, baseline = {}) {
  validateRuntimeConfig(runtime);
  const output = stripComments(cloneRecord(baseline));
  renderChannels(output, runtime);
  renderSession(output, runtime);
  renderAgents(output, runtime);
  renderBindings(output, runtime);
  renderBrowser(output, runtime);
  renderProviders(output, runtime);
  renderGlobalToolProfile(output);
  renderSkills(output, runtime);
  renderPlugins(output, runtime);
  return sortValue(output);
}

function renderGlobalToolProfile(output) {
  const tools = isRecord(output.tools) ? output.tools : {};
  output.tools = {
    ...tools,
    alsoAllow: uniqueSorted([...(tools.alsoAllow ?? []), ...REQUIRED_PROFILE_TOOLS]),
  };
}

function renderChannels(output, runtime) {
  const configs = {};
  for (const [channel, config] of Object.entries(runtime.channels.configs)) {
    configs[normalizeChannel(channel)] = config;
  }
  mergeStartupContext(output, {
    channels: runtime.channels.enabled.map(normalizeChannel),
    channelConfigs: configs,
    gatewayToken: "",
  });
}

export function canonicalStringify(value, indentation = 0) {
  return JSON.stringify(sortValue(value), null, indentation);
}

export function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;
}

export function writeAgentGuidance(runtime) {
  for (const agent of runtime.agents) {
    const file = agent.id === "main" ? `${agent.workspace}/BOOTSTRAP.md` : `${agent.workspace}/AGENTS.md`;
    if (agent.id === "main") {
      writeGuidanceWhenMissing(file, MAIN_GUIDANCE);
      continue;
    }
    upsertUserGuidance(file);
  }
}

function writeGuidanceWhenMissing(file, content) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o600 });
}

function upsertUserGuidance(file) {
  if (!existsSync(file)) {
    writeGuidanceWhenMissing(file, USER_GUIDANCE);
    return;
  }
  const current = readFileSync(file, "utf8");
  const next = replaceManagedBlock(removeLegacySkillGuidance(current));
  if (next !== current) writeFileSync(file, next, { mode: 0o600 });
}

function replaceManagedBlock(content) {
  const start = content.indexOf(SKILL_GUIDANCE_START);
  const end = content.indexOf(SKILL_GUIDANCE_END);
  if (start >= 0 && end >= start) {
    const suffix = end + SKILL_GUIDANCE_END.length;
    return `${content.slice(0, start)}${MANAGED_SKILL_GUIDANCE}${content.slice(suffix)}`;
  }
  return `${content.trimEnd()}\n\n${MANAGED_SKILL_GUIDANCE}\n`;
}

function removeLegacySkillGuidance(content) {
  return content.replace(LEGACY_SKILL_GUIDANCE, "");
}

function renderSession(output, runtime) {
  const identityLinks = {};
  for (const link of runtime.identityLinks) {
    identityLinks[link.agentId] = link.identities.map(normalizeIdentity);
  }
  output.session = {
    ...(isRecord(output.session) ? output.session : {}),
    dmScope: "per-channel-peer",
    identityLinks,
  };
}

function renderAgents(output, runtime) {
  const defaults = isRecord(output.agents?.defaults) ? output.agents.defaults : {};
  delete defaults.systemPrompt;
  output.agents = {
    defaults,
    list: runtime.agents.map((agent) => compact({
      id: agent.id,
      default: agent.default || undefined,
      workspace: agent.workspace,
      agentDir: agent.agentDir,
      model: agent.model ? { primary: agent.model } : undefined,
      skills: Array.isArray(agent.skills) ? [...agent.skills] : [],
      tools: renderToolPolicy(agent.tools, !agent.default),
    })),
  };
}

function renderToolPolicy(policy, requireNativeSkillRead) {
  const allow = policy.allow?.length ? [...policy.allow] : [];
  const deny = policy.deny?.length ? [...policy.deny] : [];
  if (requireNativeSkillRead) allow.push("read");
  return compact({
    allow: allow.length ? uniqueSorted(allow) : undefined,
    deny: deny.length
      ? uniqueSorted(deny.filter((tool) => !requireNativeSkillRead || tool !== "read"))
      : undefined,
    fs: { workspaceOnly: requireNativeSkillRead || policy.workspaceOnly },
  });
}

function renderBindings(output, runtime) {
  output.bindings = runtime.routes.map((route) => ({
    type: "route",
    agentId: route.agentId,
    match: {
      channel: normalizeChannel(route.channel),
      accountId: route.accountId,
      peer: { kind: route.peerKind === "dm" ? "direct" : route.peerKind, id: route.externalId },
    },
  }));
}

function renderBrowser(output, runtime) {
  const profiles = {};
  for (const profile of runtime.browser.profiles) {
    profiles[profile.id] = {
      driver: profile.driver,
      cdpPort: profile.cdpPort,
      color: browserProfileColor(profile, runtime.browser.defaultProfile),
    };
  }
  output.browser = {
    ...(isRecord(output.browser) ? output.browser : {}),
    enabled: true,
    defaultProfile: runtime.browser.defaultProfile,
    profiles,
  };
}

function renderProviders(output, runtime) {
  const providers = {};
  for (const provider of runtime.providers) {
    providers[provider.id] = compact({
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || undefined,
      models: [{ id: provider.model, name: provider.model }],
    });
  }
  output.models = { ...(isRecord(output.models) ? output.models : {}), providers };
}

function renderSkills(output, runtime) {
  const existing = isRecord(output.skills?.load) ? output.skills.load : {};
  const entries = isRecord(output.skills?.entries) ? output.skills.entries : {};
  output.skills = {
    ...(isRecord(output.skills) ? output.skills : {}),
    load: {
      ...existing,
      extraDirs: uniqueSorted([...(existing.extraDirs ?? []), runtime.skills.publicDirectory]),
      watch: true,
    },
    entries: {
      ...entries,
      "__muad-runtime-skill-state": {
        enabled: true,
        config: {
          generation: runtime.generation,
          agentsHash: canonicalHash(runtime.agents.map((agent) => ({
            id: agent.id,
            skills: Array.isArray(agent.skills) ? agent.skills : [],
          }))),
        },
      },
    },
  };
}

function renderPlugins(output, runtime) {
  const plugins = isRecord(output.plugins) ? output.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  output.plugins = {
    ...plugins,
    bundledDiscovery: "allowlist",
    allow: uniqueSorted([...(plugins.allow ?? []), ...Object.keys(PLUGIN_PATHS)]),
    load: { paths: uniqueSorted([...(plugins.load?.paths ?? []), ...Object.values(PLUGIN_PATHS)]) },
    entries: {
      ...entries,
      "muad-run-skill": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {
          skillsRoot: runtime.skills.publicDirectory,
          privateRoot: runtime.skills.privateRoot,
          skillPolicies: runtime.skills.agents,
          maxConcurrency: runtime.concurrency.maxSkills,
          activation: {
            toolName: "muad_use_skill",
            requireBeforeExecution: true,
            detectSkillFileReads: true,
            contextTimeoutMs: 6 * 60 * 60 * 1_000,
            cleanupIntervalMs: 60_000,
          },
          telemetry: {
            consoleInternalURL: runtime.consoleInternalUrl,
            serviceTokenFile: runtime.serviceTokenFile,
            outboxPath: runtimePath(runtime.skills.privateRoot, "muad/skill-execution-outbox.ndjson"),
            maxQueueItems: 256,
            maxOutboxBytes: 5 * 1024 * 1024,
          },
        },
      },
      "session-manager": {
        enabled: true,
        config: {
          consoleInternalURL: runtime.consoleInternalUrl,
        },
      },
      "muad-runtime-guard": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {
          generation: runtime.generation,
          mainAgentId: runtime.guard.mainAgentId,
          quarantineProfile: runtime.guard.quarantineProfile,
          agentProfiles: runtime.guard.agentProfiles,
          skillReadRoots: renderSkillReadRoots(runtime),
          sessionAgentIds: runtime.sessionManager.agents.map((agent) => agent.agentId),
          maxBrowserConcurrency: runtime.concurrency.maxBrowser,
          maxSkillConcurrency: runtime.concurrency.maxSkills,
          consoleInternalURL: runtime.consoleInternalUrl,
          serviceTokenFile: runtime.serviceTokenFile,
        },
      },
    },
  };
}

function renderSkillReadRoots(runtime) {
  const policies = new Map(runtime.skills.agents.map((policy) => [policy.agentId, policy]));
  return runtime.agents.filter((agent) => !agent.default).map((agent) => ({
    agentId: agent.id,
    roots: uniqueSorted((policies.get(agent.id)?.allowed ?? []).map((grant) => grant.rootPath)),
  }));
}

function browserProfileColor(profile, quarantineProfile) {
  if (profile.id === quarantineProfile) return "#6B7280";
  const hex = createHash("sha256")
    .update(`${profile.id}:${profile.cdpPort}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
  return `#${hex}`;
}

function normalizeIdentity(identity) {
  const separator = identity.indexOf(":");
  if (separator < 0) return identity;
  return `${normalizeChannel(identity.slice(0, separator))}${identity.slice(separator)}`;
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isRecord(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!key.startsWith("_comment")) result[key] = stripComments(child);
  }
  return result;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
}

function runtimePath(root, suffix) {
  return `${String(root).replace(/\/$/, "")}/${suffix}`;
}

function cloneRecord(value) {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const MAIN_GUIDANCE = `# Binding guidance

This is the unbound-user fallback agent. Only explain how to bind or contact an administrator.
Never access business tools, user memory, Browser profiles, Skills, files, or platform credentials.
`;

const USER_BASE_GUIDANCE = `# Shared memory boundary

This workspace belongs to one human who may use multiple IM channels.
- Treat this workspace as that person's shared memory boundary.
- Consult workspace memory when the person asks about facts learned through another IM channel.
- Never expose this workspace or its memory to another agent.
`;

const LEGACY_SKILL_GUIDANCE = `- Before using any Skill instructions, scripts, or referenced files, call muad_use_skill with the exact Skill name.
- A successful muad_use_skill result is authoritative: continue the task and never claim that Skill is not enabled.
- For traditional-script Skills, call muad_run_skill only with a script path returned by muad_use_skill; for traditional-prompt Skills, follow the returned instructions with allowed native tools.
- Report a Skill as unavailable only when muad_use_skill rejects the activation.`;

const SKILL_GUIDANCE_START = "<!-- muad:skill-activation:start -->";
const SKILL_GUIDANCE_END = "<!-- muad:skill-activation:end -->";
const MANAGED_SKILL_GUIDANCE = `${SKILL_GUIDANCE_START}
# Skill activation boundary

- Skill activation is scoped to one user turn.
- On every user turn, including a retry or follow-up, if the request clearly matches an available Skill, first read the exact SKILL.md path listed in <available_skills>.
- Reading that exact SKILL.md is the native Skill activation and audit boundary. If native reading is unavailable, call muad_use_skill with the exact Skill name instead.
- Do not call task tools until one of those activation methods succeeds.
- Never reuse a prior turn's Skill activation as authorization for the current turn.
${LEGACY_SKILL_GUIDANCE}
${SKILL_GUIDANCE_END}`;
const USER_GUIDANCE = `${USER_BASE_GUIDANCE}\n${MANAGED_SKILL_GUIDANCE}\n`;

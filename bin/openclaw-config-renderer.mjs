import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateRuntimeConfig } from "./runtime-config-schema.mjs";
import { mergeStartupContext, normalizeChannel } from "./startup-context.mjs";

const PLUGIN_PATHS = {
  "muad-run-skill": "/opt/muad/muad-run-skill",
  "session-manager": "/opt/muad/session-manager",
  "muad-runtime-guard": "/opt/muad/muad-runtime-guard",
};

export function renderOpenClawConfig(runtime, baseline = {}) {
  validateRuntimeConfig(runtime);
  const output = stripComments(cloneRecord(baseline));
  renderChannels(output, runtime);
  renderSession(output, runtime);
  renderAgents(output, runtime);
  renderBindings(output, runtime);
  renderBrowser(output, runtime);
  renderProviders(output, runtime);
  renderSkills(output, runtime);
  renderPlugins(output, runtime);
  return sortValue(output);
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
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, agent.id === "main" ? MAIN_GUIDANCE : USER_GUIDANCE, { mode: 0o600 });
  }
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
      tools: renderToolPolicy(agent.tools),
    })),
  };
}

function renderToolPolicy(policy) {
  return compact({
    allow: policy.allow?.length ? [...policy.allow] : undefined,
    deny: policy.deny?.length ? [...policy.deny] : undefined,
    fs: { workspaceOnly: policy.workspaceOnly },
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
  output.skills = {
    ...(isRecord(output.skills) ? output.skills : {}),
    load: {
      ...existing,
      extraDirs: uniqueSorted([...(existing.extraDirs ?? []), runtime.skills.publicDirectory]),
      watch: true,
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
        config: {
          skillsRoot: runtime.skills.publicDirectory,
          skillPolicies: runtime.skills.agents,
          consoleInternalURL: runtime.consoleInternalUrl,
          serviceTokenFile: runtime.serviceTokenFile,
          maxConcurrency: runtime.concurrency.maxSkills,
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

const USER_GUIDANCE = `# Shared memory boundary

This workspace belongs to one human who may use multiple IM channels.
- Treat this workspace as that person's shared memory boundary.
- Consult workspace memory when the person asks about facts learned through another IM channel.
- Never expose this workspace or its memory to another agent.
`;

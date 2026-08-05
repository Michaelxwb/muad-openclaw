import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  IMAGE_CHANNEL_PLUGIN_SPECS,
  MUAD_RUNTIME_PLUGIN_SPECS,
  pluginIds,
  pluginRoots,
} from "./image-plugin-paths.mjs";
import { validateRuntimeConfig } from "./runtime-config-schema.mjs";
import { mergeStartupContext, normalizeChannel } from "./startup-context.mjs";

const REQUIRED_PROFILE_TOOLS = ["browser", "session_get_state"];
const DEPRECATED_RUNTIME_PLUGINS = new Set(["muad-run-skill"]);
const DEPRECATED_RUNTIME_PLUGIN_ROOTS = new Set(["/opt/muad/muad-run-skill"]);
const DEPRECATED_PROFILE_TOOLS = new Set(["muad_run_skill", "muad_use_skill"]);

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
  const current = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  output.tools = {
    ...tools,
    alsoAllow: uniqueSorted([
      ...current.filter((tool) => !DEPRECATED_PROFILE_TOOLS.has(tool)),
      ...REQUIRED_PROFILE_TOOLS,
    ]),
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
      // Only overwrite BOOTSTRAP.md when the admin explicitly configured main
      // guidance; the default keeps the legacy write-if-missing semantics so a
      // manually maintained BOOTSTRAP.md is never silently replaced.
      if (runtime?.guidance?.main?.trim()) {
        upsertGuidanceFile(file, mainGuidance(runtime));
      } else {
        writeGuidanceWhenMissing(file, DEFAULT_MAIN_GUIDANCE);
      }
      continue;
    }
    upsertUserGuidance(file, runtime);
  }
}

function writeGuidanceWhenMissing(file, content) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o600 });
}

// upsertGuidanceFile writes a whole-file guidance (e.g. the main agent's
// BOOTSTRAP.md) when missing or when the configured content changed.
function upsertGuidanceFile(file, content) {
  if (!existsSync(file)) {
    writeGuidanceWhenMissing(file, content);
    return;
  }
  const current = readFileSync(file, "utf8");
  if (current !== content) writeFileSync(file, content, { mode: 0o600 });
}

function upsertUserGuidance(file, runtime) {
  if (!existsSync(file)) {
    writeGuidanceWhenMissing(file, userGuidance(runtime));
    return;
  }
  const current = readFileSync(file, "utf8");
  const withMemory = replaceMemoryGuidance(removeLegacyMemoryGuidance(current), runtime);
  const next = replaceManagedBlock(removeLegacySkillGuidance(withMemory), runtime);
  if (next !== current) writeFileSync(file, next, { mode: 0o600 });
}

function replaceMemoryGuidance(content, runtime) {
  const guidance = memoryGuidance(runtime);
  const start = content.indexOf(MEMORY_GUIDANCE_START);
  const end = content.indexOf(MEMORY_GUIDANCE_END);
  if (start >= 0 && end >= start) {
    const suffix = end + MEMORY_GUIDANCE_END.length;
    return `${content.slice(0, start)}${guidance}${content.slice(suffix)}`;
  }
  return `${guidance}\n\n${content.trimStart()}`;
}

function removeLegacyMemoryGuidance(content) {
  if (content.includes(MEMORY_GUIDANCE_START)) return content;
  const start = content.indexOf("# Shared memory boundary");
  if (start < 0) return content;
  const end = content.indexOf(SKILL_GUIDANCE_START, start);
  if (end < 0) return content;
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function replaceManagedBlock(content, runtime) {
  const guidance = managedSkillGuidance(runtime);
  const start = content.indexOf(SKILL_GUIDANCE_START);
  const end = content.indexOf(SKILL_GUIDANCE_END);
  if (start >= 0 && end >= start) {
    const suffix = end + SKILL_GUIDANCE_END.length;
    return `${content.slice(0, start)}${guidance}${content.slice(suffix)}`;
  }
  return `${content.trimEnd()}\n\n${guidance}\n`;
}

function removeLegacySkillGuidance(content) {
  return content.replace(DEPRECATED_SKILL_GUIDANCE, "");
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
      // No per-agent skills allowlist: agents can use all public Skills plus
      // their own workspace Skills (openclaw "unrestricted" semantics).
      tools: renderToolPolicy(agent.tools, !agent.default),
    })),
  };
}

function renderToolPolicy(policy, requireNativeSkillRead) {
  const allow = policy.allow?.length
    ? policy.allow.filter((tool) => !DEPRECATED_PROFILE_TOOLS.has(tool))
    : [];
  const deny = policy.deny?.length
    ? policy.deny.filter((tool) => !DEPRECATED_PROFILE_TOOLS.has(tool))
    : [];
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
  // Only the public directory root is listed; openclaw watches it and
  // auto-discovers child Skills, so a public Skill add/remove does not change
  // the config bytes (no gateway restart) while still hot-loading new Skills.
  const existing = isRecord(output.skills?.load) ? output.skills.load : {};
  output.skills = {
    ...(isRecord(output.skills) ? output.skills : {}),
    load: {
      ...existing,
      extraDirs: uniqueSorted([
        ...(existing.extraDirs ?? []),
        runtime.skills.publicDirectory,
      ]),
      watch: true,
    },
  };
}

function renderPlugins(output, runtime) {
  const plugins = isRecord(output.plugins) ? output.plugins : {};
  const pluginBase = { ...plugins };
  delete pluginBase.installs;
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const existingAllow = Array.isArray(plugins.allow) ? plugins.allow : [];
  const existingPaths = Array.isArray(plugins.load?.paths) ? plugins.load.paths : [];
  output.plugins = {
    ...pluginBase,
    bundledDiscovery: "allowlist",
    allow: uniqueSorted([
      ...existingAllow.filter((id) => !DEPRECATED_RUNTIME_PLUGINS.has(id)),
      ...pluginIds(MUAD_RUNTIME_PLUGIN_SPECS),
    ]),
    load: {
      ...(isRecord(plugins.load) ? plugins.load : {}),
      paths: uniqueSorted([
        ...existingPaths.filter((root) => !DEPRECATED_RUNTIME_PLUGIN_ROOTS.has(root)),
        ...pluginRoots(MUAD_RUNTIME_PLUGIN_SPECS),
        ...pluginRoots(IMAGE_CHANNEL_PLUGIN_SPECS),
      ]),
    },
    entries: {
      ...activePluginEntries(entries),
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

function activePluginEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([id]) => !DEPRECATED_RUNTIME_PLUGINS.has(id)),
  );
}

function renderSkillReadRoots(runtime) {
  const policies = new Map(runtime.skills.agents.map((policy) => [policy.agentId, policy]));
  return runtime.agents.filter((agent) => !agent.default).map((agent) => ({
    agentId: agent.id,
    // Directory-level roots: public Skills live under the public directory and
    // private Skills under the agent workspace skills root, so this stays byte
    // stable across Skill add/remove (no gateway restart). isWithin covers the
    // concrete child Skill directories.
    roots: uniqueSorted(
      (policies.get(agent.id)?.allowed ?? []).map((grant) => dirname(grant.rootPath)),
    ),
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

function cloneRecord(value) {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const DEFAULT_MAIN_GUIDANCE = `# Binding guidance

This is the unbound-user fallback agent. Only explain how to bind or contact an administrator.
Never access business tools, user memory, Browser profiles, Skills, files, or platform credentials.
`;

const MEMORY_GUIDANCE_START = "<!-- muad:memory:start -->";
const MEMORY_GUIDANCE_END = "<!-- muad:memory:end -->";
const DEFAULT_MEMORY_GUIDANCE = `# Shared memory boundary

This workspace belongs to one human who may use multiple IM channels.
- Treat this workspace as that person's shared memory boundary.
- Consult workspace memory when the person asks about facts learned through another IM channel.
- Never expose this workspace or its memory to another agent.

# Memory persistence

- When the user asks you to remember, save, record, write to memory, or update who you are, update the relevant workspace memory file before saying it is remembered.
- Store assistant identity, name, vibe, and emoji in \`IDENTITY.md\`; store user facts, names, preferences, and notes in \`USER.md\`.
- Read the current file first, then use a file-writing tool to persist the change. Do not rely on chat history as memory.
- Never say a fact has been saved, remembered, or written until the file-writing tool has completed successfully.
- If file-writing tools are unavailable or fail, say that memory was not saved and explain the blocker briefly.`;

const DEPRECATED_SKILL_GUIDANCE = `- Before using any Skill instructions, scripts, or referenced files, call muad_use_skill with the exact Skill name.
- A successful muad_use_skill result is authoritative: continue the task and never claim that Skill is not enabled.
- For traditional-script Skills, call muad_run_skill only with a script path returned by muad_use_skill; for traditional-prompt Skills, follow the returned instructions with allowed native tools.
- Report a Skill as unavailable only when muad_use_skill rejects the activation.`;

const SKILL_GUIDANCE_START = "<!-- muad:skill-activation:start -->";
const SKILL_GUIDANCE_END = "<!-- muad:skill-activation:end -->";
// System activation mechanics stay locked; only the "用户自建 Skill" product rules
// are admin-configurable via runtime.guidance.userSkill.
const ACTIVATION_BOUNDARY_GUIDANCE = `# Skill activation boundary

- Skill activation is scoped to one user turn.
- On every user turn, including a retry or follow-up, if the request clearly matches an available Skill, first read the exact SKILL.md path listed in <available_skills>.
- Reading that exact SKILL.md is the native Skill activation and audit boundary.
- Do not call task tools until one of those activation methods succeeds.
- Never reuse a prior turn's Skill activation as authorization for the current turn.`;

const DEFAULT_USER_SKILL_GUIDANCE = `- 用户说"写/创建 skill"时：与用户多轮对话澄清需求，把草稿写到 skill-staging/<name>/（含 SKILL.md，frontmatter 的 name 与目录同名）；完成后提示用户可继续修改。
- 用户说"上传 / 生效 / 提交 skill"时：才调用 skill-upload 把 staging 草稿上传到控制台。
- 用户说"修改 / 更新已上传的 skill"时：同样走 skill-upload——先读现有内容，把修改写到 skill-staging/<name>/ 草稿，再重传；若控制台返回 "skill already exists"，如实告知用户需先联系管理员在控制台删除旧 skill，再重新上传。
- 【重要】不要直接编辑 workspace/skills/ 下的平台托管私有 skill（guard 只读，直接改不生效且会被同步覆盖）；写草稿不自动上传，上传/修改时机由用户决定。`;

function mainGuidance(runtime) {
  return runtime?.guidance?.main?.trim() || DEFAULT_MAIN_GUIDANCE;
}

function memoryGuidance(runtime) {
  const inner = runtime?.guidance?.memory?.trim() || DEFAULT_MEMORY_GUIDANCE;
  return `${MEMORY_GUIDANCE_START}\n${inner}\n${MEMORY_GUIDANCE_END}`;
}

function managedSkillGuidance(runtime) {
  const inner = runtime?.guidance?.userSkill?.trim() || DEFAULT_USER_SKILL_GUIDANCE;
  return `${SKILL_GUIDANCE_START}\n${ACTIVATION_BOUNDARY_GUIDANCE}\n\n# 用户自建 Skill\n\n${inner}\n${SKILL_GUIDANCE_END}`;
}

function userGuidance(runtime) {
  return `${memoryGuidance(runtime)}\n\n${managedSkillGuidance(runtime)}\n`;
}

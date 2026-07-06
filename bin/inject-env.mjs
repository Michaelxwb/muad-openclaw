// inject-env.mjs — entrypoint runtime env injection into openclaw.json.
// Idempotent: overwrites on every boot. Supports multi-channel via CHANNELS env.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const state = process.env.OPENCLAW_STATE_DIR || `${homedir()}/.openclaw`;
const p = `${state}/openclaw.json`;
const d = JSON.parse(readFileSync(p, "utf8"));
const E = process.env;
const v = (x) => (x ?? "").trim();

// Gateway token
if (v(E.OPENCLAW_GATEWAY_TOKEN)) {
  d.gateway = d.gateway || {};
  d.gateway.auth = { mode: "token", token: v(E.OPENCLAW_GATEWAY_TOKEN) };
}

// Channel mapping: internal id → openclaw channel id.
const CHANNEL_MAP = { wecom: "wecom", wechat: "openclaw-weixin" };
const KNOWN = new Set(Object.values(CHANNEL_MAP));

// Multi-channel: CHANNELS (comma-separated) is primary; legacy CHANNEL is fallback.
const channelsStr = v(E.CHANNELS) || v(E.CHANNEL) || "wecom";
const channels = channelsStr
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ocChannels = channels.map((c) => CHANNEL_MAP[c] || c);

d.channels = d.channels || {};
// Enable selected channels, disable the rest.
for (const id of KNOWN) {
  const c = (d.channels[id] = d.channels[id] || {});
  c.enabled = ocChannels.includes(id);
}
// Remove channel keys not in CHANNEL_MAP (clean up from buggy hot-updates).
for (const id of Object.keys(d.channels)) {
  if (!KNOWN.has(id)) delete d.channels[id];
}

// Gate non-bundled plugin auto-load by setting `plugins.allow` to exactly the
// currently-needed set. Without an explicit allow-list, openclaw auto-loads
// every non-bundled plugin it can discover — even if its channel was removed
// from `channels`, the plugin stays loaded and its long-poll session keeps
// running. Required for clean channel removal via hot reload.
const PLUGIN_BY_CH = {
  wecom: "wecom-openclaw-plugin",
  wechat: "openclaw-weixin",
};
d.plugins = d.plugins || {};
d.plugins.allow = channels.map((c) => PLUGIN_BY_CH[c]).filter(Boolean);

// Per-channel credentials from CHANNEL_CONFIGS JSON, with legacy fallback.
const configsStr = v(E.CHANNEL_CONFIGS);
if (configsStr) {
  try {
    const configs = JSON.parse(configsStr);
    for (const [ch, cfg] of Object.entries(configs)) {
      const ocID = CHANNEL_MAP[ch] || ch;
      const c = (d.channels[ocID] = d.channels[ocID] || {});
      if (cfg.botId) c.botId = cfg.botId;
      if (cfg.secret) c.secret = cfg.secret;
    }
  } catch (_) {
    /* ignore malformed JSON */
  }
} else {
  // Legacy single-channel credential env vars
  const ch = d.channels[ocChannels[0]] || {};
  if (v(E.WECOM_BOT_ID)) ch.botId = v(E.WECOM_BOT_ID);
  if (v(E.WECOM_SECRET)) ch.secret = v(E.WECOM_SECRET);
}

// LLM provider
const prov = v(E.LLM_PROVIDER) || "deepseek";
d.models = d.models || {};
d.models.providers = d.models.providers || {};
const pc = (d.models.providers[prov] = d.models.providers[prov] || {});
if (v(E.LLM_API_KEY)) pc.apiKey = v(E.LLM_API_KEY);
if (v(E.LLM_BASE_URL)) pc.baseUrl = v(E.LLM_BASE_URL);
pc.api = pc.api || "openai-completions";
const model = v(E.LLM_MODEL);
if (model) {
  pc.models = [{ id: model, name: model }];
}

// Ensure cross-session identity bootstrap exists in agent workspace.
import { mkdirSync, writeFileSync as wfs, existsSync } from "node:fs";
const agentDir = `${state}/agents/main`;
const bootstrapPath = `${agentDir}/BOOTSTRAP.md`;
if (!existsSync(bootstrapPath)) {
  mkdirSync(agentDir, { recursive: true });
  wfs(
    bootstrapPath,
    `# Identity & Memory
You serve the same user across multiple chat platforms (WeChat, WeCom, etc.).
Each platform appears as a separate conversation session, but the person
behind them is the same individual.

## Cross-Session Rules
- Always check your memory first before asking for name or preferences.
- Save new information to memory immediately for cross-session recall.
- If the user references another platform, use memory to bridge context.`,
  );
}
writeFileSync(p, JSON.stringify(d, null, 2));
const enabled = ocChannels.join(",");
console.log(
  `[inject-env] channels=[${enabled}] chConfigs=${!!configsStr} provider=${prov} model=${model || "(default)"}`,
);

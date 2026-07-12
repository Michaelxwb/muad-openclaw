const CHANNEL_ALIASES = {
  wechat: "openclaw-weixin",
  weixin: "openclaw-weixin",
};

const CHANNEL_PLUGINS = {
  wecom: "wecom-openclaw-plugin",
  "openclaw-weixin": "openclaw-weixin",
};

const CREDENTIAL_FIELDS = ["botId", "secret"];

export function collectStartupContext({ env = process.env, runtime }) {
  const channelConfigs = readChannelConfigs(env);
  applyLegacyWeComCredentials(channelConfigs, env);
  const channels = resolveChannels(env, runtime, channelConfigs);
  return {
    channels,
    channelConfigs,
    gatewayToken: clean(env.OPENCLAW_GATEWAY_TOKEN),
  };
}

export function applyStartupContext(baseline, context) {
  const output = cloneRecord(baseline);
  return mergeStartupContext(output, context);
}

export function mergeStartupContext(output, context) {
  applyGateway(output, context.gatewayToken);
  applyChannels(output, context);
  applyChannelPlugins(output, context.channels);
  return output;
}

export function normalizeChannel(channel) {
  const value = clean(channel);
  return CHANNEL_ALIASES[value] ?? value;
}

function readChannelConfigs(env) {
  const source = clean(env.CHANNEL_CONFIGS);
  if (!source) return {};
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid CHANNEL_CONFIGS JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) throw new Error("CHANNEL_CONFIGS must be an object");
  return normalizeChannelConfigs(parsed);
}

function normalizeChannelConfigs(configs) {
  const normalized = {};
  for (const [channel, config] of Object.entries(configs)) {
    const id = normalizeChannel(channel);
    if (!id || !isRecord(config)) throw new Error(`CHANNEL_CONFIGS.${channel} must be an object`);
    if (normalized[id]) throw new Error(`CHANNEL_CONFIGS contains duplicate channel: ${id}`);
    const fields = Object.entries(config);
    if (fields.some(([, value]) => typeof value !== "string")) {
      throw new Error(`CHANNEL_CONFIGS.${channel} values must be strings`);
    }
    normalized[id] = Object.fromEntries(fields);
  }
  return normalized;
}

function applyLegacyWeComCredentials(configs, env) {
  if (Object.keys(configs).length > 0) return;
  const botId = clean(env.WECOM_BOT_ID);
  const secret = clean(env.WECOM_SECRET);
  if (botId || secret) configs.wecom = { ...(botId ? { botId } : {}), ...(secret ? { secret } : {}) };
}

function resolveChannels(env, runtime, configs) {
  const explicit = clean(env.CHANNELS) || clean(env.CHANNEL);
  const candidates = explicit
    ? explicit.split(",")
    : Object.keys(configs).length > 0
      ? Object.keys(configs)
      : runtime.routes.map((route) => route.channel);
  const channels = [...new Set(candidates.map(normalizeChannel).filter(Boolean))];
  return channels.length > 0 ? channels : ["wecom"];
}

function applyGateway(output, token) {
  if (!token) return;
  const gateway = isRecord(output.gateway) ? output.gateway : {};
  output.gateway = { ...gateway, auth: { mode: "token", token } };
}

function applyChannels(output, context) {
  const channels = isRecord(output.channels) ? output.channels : {};
  const selected = new Set(context.channels);
  for (const id of new Set([...Object.keys(CHANNEL_PLUGINS), ...context.channels])) {
    const current = isRecord(channels[id]) ? channels[id] : {};
    for (const field of CREDENTIAL_FIELDS) delete current[field];
    channels[id] = { ...current, ...(context.channelConfigs[id] ?? {}), enabled: selected.has(id) };
  }
  output.channels = channels;
}

function applyChannelPlugins(output, channels) {
  const plugins = isRecord(output.plugins) ? output.plugins : {};
  const existing = Array.isArray(plugins.allow) ? plugins.allow : [];
  const channelPluginIds = new Set(Object.values(CHANNEL_PLUGINS));
  const retained = existing.filter((id) => !channelPluginIds.has(id));
  const selected = channels.map((id) => CHANNEL_PLUGINS[id]).filter(Boolean);
  output.plugins = { ...plugins, allow: [...new Set([...retained, ...selected])].sort() };
}

function cloneRecord(value) {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function clean(value) {
  return String(value ?? "").trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const MUAD_RUNTIME_PLUGIN_SPECS = Object.freeze([
  plugin("session-manager", "/opt/muad/session-manager", "openclaw-plugin.mjs"),
  plugin("muad-runtime-guard", "/opt/muad/muad-runtime-guard", "src/index.mjs"),
]);

export const IMAGE_CHANNEL_PLUGIN_SPECS = Object.freeze([
  plugin("wecom-openclaw-plugin", "/opt/openclaw-plugins/wecom-openclaw-plugin", "dist/index.js"),
  plugin("openclaw-weixin", "/opt/openclaw-plugins/openclaw-weixin", "dist/index.js"),
  plugin("mattermost", "/opt/openclaw-plugins/mattermost", "dist/index.js"),
]);

export const IMAGE_PLUGIN_SPECS = Object.freeze([
  ...MUAD_RUNTIME_PLUGIN_SPECS,
  ...IMAGE_CHANNEL_PLUGIN_SPECS,
]);

export function ensurePluginLoadPaths(config, specs = IMAGE_PLUGIN_SPECS) {
  if (!isRecord(config)) return false;
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const load = isRecord(plugins.load) ? plugins.load : {};
  const current = Array.isArray(load.paths) ? load.paths : [];
  const paths = uniqueSorted([...current, ...specs.map((spec) => spec.root)]);
  if (JSON.stringify(current) === JSON.stringify(paths)) return false;
  config.plugins = { ...plugins, load: { ...load, paths } };
  return true;
}

export function pluginRoots(specs) {
  return specs.map((spec) => spec.root);
}

export function pluginIds(specs) {
  return specs.map((spec) => spec.id);
}

function plugin(id, root, relativeEntry) {
  return Object.freeze({
    id,
    root,
    manifest: `${root}/openclaw.plugin.json`,
    entry: `${root}/${relativeEntry}`,
  });
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

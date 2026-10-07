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

/** 9.8 信任模型：这些通道插件必须以官方 npm 安装（trusted-official）才能使用通道
 * 入口队列；镜像路径加载（origin=config）会被 PLUGIN_TRUST_REFUSED 拒绝并让通道退出。
 * 由 entrypoint 在启动前确保 npm 安装，所有 load.paths 写入点都不得包含其 root。 */
export const NPM_TRUSTED_CHANNEL_PLUGIN_IDS = Object.freeze(["mattermost"]);

export const NPM_TRUSTED_CHANNEL_PLUGIN_SPECS = Object.freeze(
  IMAGE_CHANNEL_PLUGIN_SPECS.filter((spec) => NPM_TRUSTED_CHANNEL_PLUGIN_IDS.includes(spec.id)),
);

export function ensurePluginLoadPaths(config, specs = IMAGE_PLUGIN_SPECS) {
  if (!isRecord(config)) return false;
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const load = isRecord(plugins.load) ? plugins.load : {};
  const current = Array.isArray(load.paths) ? load.paths : [];
  const npmTrustedRoots = new Set(pluginRoots(NPM_TRUSTED_CHANNEL_PLUGIN_SPECS));
  const paths = uniqueSorted([
    ...current.filter((root) => !npmTrustedRoots.has(root)),
    ...specs.map((spec) => spec.root).filter((root) => !npmTrustedRoots.has(root)),
  ]);
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

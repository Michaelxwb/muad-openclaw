import assert from "node:assert/strict";
import { accessSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IMAGE_CHANNEL_PLUGINS,
  PINNED_OPENCLAW_VERSION,
  POD_SERVICE_TOKEN_FILE,
  REQUIRED_RUNTIME_PLUGINS,
  assertOpenClawVersion,
  validatePluginArtifacts,
  validatePluginDependencies,
  validatePluginInventory,
  validateNoManagedPluginInstalls,
  validateRuntimePermissions,
  validateRuntimePluginConfig,
  validateRuntimePluginsOfflineSafe,
  runImageSelfCheck,
} from "../runtime-image-self-check.mjs";

test("OpenClaw image version is pinned exactly", () => {
  assert.equal(PINNED_OPENCLAW_VERSION, "2026.7.1");
  assert.doesNotThrow(() => assertOpenClawVersion("OpenClaw 2026.7.1"));
  assert.throws(() => assertOpenClawVersion("OpenClaw 2026.6.11"), /version mismatch/);
});

test("all repository plugin manifests match their load roots and entries", () => {
  const root = join(import.meta.dirname, "..", "..");
  validatePluginArtifacts([
    localPlugin(root, "session-manager", "openclaw-plugin.mjs"),
    localPlugin(root, "muad-runtime-guard", "src/index.mjs"),
  ]);
});

test("runtime plugins are packaged for offline startup", () => {
  const root = join(import.meta.dirname, "..", "..");
  assert.doesNotThrow(() => validateRuntimePluginsOfflineSafe([
    localPlugin(root, "session-manager", "openclaw-plugin.mjs"),
    localPlugin(root, "muad-runtime-guard", "src/index.mjs"),
  ]));

  assert.throws(
    () => validateRuntimePluginsOfflineSafe(
      [{ id: "bad", root: "/bad", manifest: "unused", entry: "unused" }],
      { readFile: () => JSON.stringify({ peerDependencies: { openclaw: ">=2026.0.0" } }) },
    ),
    /runtime npm install/u,
  );
});

test("runtime assembly requires explicit allow, load path, entries, CLI, and readable token", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-image-check-"));
  const cli = join(root, "session-manager");
  const token = join(root, "pod-service-token");
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(token, "opaque", { mode: 0o400 });
  const specs = imageSpecs();
  const config = runtimeConfig(specs);

  assert.doesNotThrow(() => validateNoManagedPluginInstalls(config));
  assert.doesNotThrow(() => validateRuntimePluginConfig(config, specs, IMAGE_CHANNEL_PLUGINS));
  assert.doesNotThrow(() => validateRuntimePermissions(config, {
    cliPath: cli,
    access: (path, mode) => accessSync(path === POD_SERVICE_TOKEN_FILE ? token : path, mode),
  }));

  config.plugins.installs = { mattermost: { source: "npm" } };
  assert.throws(() => validateNoManagedPluginInstalls(config), /managed plugin install records/u);
  delete config.plugins.installs;

  config.plugins.entries["muad-runtime-guard"].hooks.allowConversationAccess = false;
  assert.throws(
    () => validateRuntimePluginConfig(config, specs, IMAGE_CHANNEL_PLUGINS),
    /conversation hook access/,
  );
  config.plugins.entries["muad-runtime-guard"].hooks.allowConversationAccess = true;

  config.plugins.entries["session-manager"].enabled = false;
  assert.throws(
    () => validateRuntimePluginConfig(config, specs, IMAGE_CHANNEL_PLUGINS),
    /not explicitly enabled/,
  );
  config.plugins.entries["session-manager"].enabled = true;

  config.plugins.load.paths = config.plugins.load.paths.filter(
    (path) => path !== IMAGE_CHANNEL_PLUGINS[0].root,
  );
  assert.throws(
    () => validateRuntimePluginConfig(config, specs, IMAGE_CHANNEL_PLUGINS),
    /image channel plugin path is missing/,
  );
});

test("startup self-check skips OpenClaw CLI migration paths", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-startup-check-"));
  const configPath = join(root, "openclaw.json");
  const cli = join(root, "session-manager");
  const token = join(root, "pod-service-token");
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(token, "opaque", { mode: 0o400 });
  writeFileSync(configPath, JSON.stringify(runtimeConfig(imageSpecs())));

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.doesNotThrow(() => runImageSelfCheck({
      skipOpenClawCLI: true,
      configPath,
      plugins: [],
      requiredRuntimePlugins: imageSpecs(),
      imageChannelPlugins: IMAGE_CHANNEL_PLUGINS,
      dependencies: {
        cliPath: cli,
        readFile: () => "{}",
        access: (path, mode) => accessSync(path === POD_SERVICE_TOKEN_FILE ? token : path, mode),
      },
    }));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("cold OpenClaw inventory must discover every plugin as enabled and healthy", () => {
  const specs = imageSpecs();
  const plugins = specs.map((item) => ({ id: item.id, enabled: true, status: "enabled" }));
  assert.doesNotThrow(() => validatePluginInventory({ plugins }, specs));
  plugins[1].status = "error";
  assert.throws(() => validatePluginInventory({ plugins }, specs), /inventory is unhealthy/);
});

test("image channel plugins must include their runtime dependencies", () => {
  const plugins = IMAGE_CHANNEL_PLUGINS.map((item) => ({
    id: item.id,
    enabled: item.id === "wecom-openclaw-plugin",
    status: item.id === "wecom-openclaw-plugin" ? "loaded" : "disabled",
    dependencyStatus: { requiredInstalled: true, missing: [] },
  }));
  assert.doesNotThrow(() => validatePluginDependencies({ plugins }, IMAGE_CHANNEL_PLUGINS));

  plugins[0].dependencyStatus = { requiredInstalled: false, missing: ["zod"] };
  assert.throws(
    () => validatePluginDependencies({ plugins }, IMAGE_CHANNEL_PLUGINS),
    /dependencies are incomplete/,
  );
});

function localPlugin(root, id, entry) {
  const pluginRoot = join(root, "tools", id);
  return { id,
    root: pluginRoot, manifest: join(pluginRoot, "openclaw.plugin.json"),
    entry: join(pluginRoot, entry) };
}

function imageSpecs() {
  return REQUIRED_RUNTIME_PLUGINS.map((spec) => ({
    ...spec,
    manifest: "unused",
    entry: "unused",
  }));
}

function runtimeConfig(specs) {
  return { plugins: {
    allow: specs.map((item) => item.id),
    load: { paths: [...specs, ...IMAGE_CHANNEL_PLUGINS].map((item) => item.root) },
    entries: Object.fromEntries(specs.map((item) => [item.id, {
      enabled: true,
      ...(item.id === "muad-runtime-guard"
        ? { hooks: { allowConversationAccess: true } }
        : {}),
      config: item.id === "muad-runtime-guard"
        ? { serviceTokenFile: POD_SERVICE_TOKEN_FILE } : {},
    }])),
  } };
}

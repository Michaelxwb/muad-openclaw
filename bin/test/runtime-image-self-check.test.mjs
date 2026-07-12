import assert from "node:assert/strict";
import { accessSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PINNED_OPENCLAW_VERSION,
  POD_SERVICE_TOKEN_FILE,
  assertOpenClawVersion,
  validatePluginArtifacts,
  validatePluginInventory,
  validateRuntimePermissions,
  validateRuntimePluginConfig,
} from "../runtime-image-self-check.mjs";

test("OpenClaw image version is pinned exactly", () => {
  assert.equal(PINNED_OPENCLAW_VERSION, "2026.6.10");
  assert.doesNotThrow(() => assertOpenClawVersion("OpenClaw 2026.6.10"));
  assert.throws(() => assertOpenClawVersion("OpenClaw 2026.6.11"), /version mismatch/);
});

test("all repository plugin manifests match their load roots and entries", () => {
  const root = join(import.meta.dirname, "..", "..");
  validatePluginArtifacts([
    localPlugin(root, "muad-run-skill", "src/index.mjs"),
    localPlugin(root, "session-manager", "openclaw-plugin.mjs"),
    localPlugin(root, "muad-runtime-guard", "src/index.mjs"),
  ]);
});

test("runtime assembly requires explicit allow, load path, entries, CLI, and readable token", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-image-check-"));
  const cli = join(root, "session-manager");
  const token = join(root, "pod-service-token");
  writeFileSync(cli, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(token, "opaque", { mode: 0o400 });
  const specs = imageSpecs();
  const config = runtimeConfig(specs);

  assert.doesNotThrow(() => validateRuntimePluginConfig(config, specs));
  assert.doesNotThrow(() => validateRuntimePermissions(config, {
    cliPath: cli,
    access: (path, mode) => accessSync(path === POD_SERVICE_TOKEN_FILE ? token : path, mode),
  }));

  config.plugins.entries["muad-runtime-guard"].hooks.allowConversationAccess = false;
  assert.throws(() => validateRuntimePluginConfig(config, specs), /conversation hook access/);
  config.plugins.entries["muad-runtime-guard"].hooks.allowConversationAccess = true;

  config.plugins.entries["session-manager"].enabled = false;
  assert.throws(() => validateRuntimePluginConfig(config, specs), /not explicitly enabled/);
});

test("cold OpenClaw inventory must discover every plugin as enabled and healthy", () => {
  const specs = imageSpecs();
  const plugins = specs.map((item) => ({ id: item.id, enabled: true, status: "enabled" }));
  assert.doesNotThrow(() => validatePluginInventory({ plugins }, specs));
  plugins[1].status = "error";
  assert.throws(() => validatePluginInventory({ plugins }, specs), /inventory is unhealthy/);
});

function localPlugin(root, id, entry) {
  const pluginRoot = join(root, "tools", id);
  return { id,
    root: pluginRoot, manifest: join(pluginRoot, "openclaw.plugin.json"),
    entry: join(pluginRoot, entry) };
}

function imageSpecs() {
  return ["muad-run-skill", "session-manager", "muad-runtime-guard"].map((id) => ({
    id, root: `/opt/muad/${id}`, manifest: "unused", entry: "unused",
  }));
}

function runtimeConfig(specs) {
  return { plugins: {
    allow: specs.map((item) => item.id),
    load: { paths: specs.map((item) => item.root) },
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

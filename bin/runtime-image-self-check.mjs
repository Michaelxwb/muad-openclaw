#!/usr/bin/env node
import { constants, accessSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PINNED_OPENCLAW_VERSION = "2026.6.10";
export const POD_SERVICE_TOKEN_FILE = "/run/secrets/muad/pod-service-token";
export const SESSION_MANAGER_CLI = "/usr/local/bin/session-manager";
export const IMAGE_PLUGINS = Object.freeze([
  plugin("muad-run-skill", "/opt/muad/muad-run-skill", "src/index.mjs"),
  plugin("session-manager", "/opt/muad/session-manager", "openclaw-plugin.mjs"),
  plugin("muad-runtime-guard", "/opt/muad/muad-runtime-guard", "src/index.mjs"),
]);

export function assertOpenClawVersion(output, expected = PINNED_OPENCLAW_VERSION) {
  const version = String(output ?? "").trim();
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u").test(version)) {
    throw new Error(`OpenClaw version mismatch: expected ${expected}`);
  }
}

export function validatePluginArtifacts(specs = IMAGE_PLUGINS, dependencies = {}) {
  const read = dependencies.readFile ?? readFileSync;
  const access = dependencies.access ?? accessSync;
  for (const spec of specs) {
    const manifest = parseJSON(read(spec.manifest, "utf8"), spec.manifest);
    if (manifest.id !== spec.id) throw new Error(`plugin manifest id mismatch: ${spec.id}`);
    access(spec.entry, constants.R_OK);
  }
}

export function validateRuntimePluginConfig(config, specs = IMAGE_PLUGINS) {
  const allow = config?.plugins?.allow;
  const paths = config?.plugins?.load?.paths;
  const entries = config?.plugins?.entries;
  if (!Array.isArray(allow) || !Array.isArray(paths) || !isRecord(entries)) {
    throw new Error("OpenClaw plugin configuration is incomplete");
  }
  for (const spec of specs) {
    if (!allow.includes(spec.id) || !paths.includes(spec.root) || entries[spec.id]?.enabled !== true) {
      throw new Error(`OpenClaw plugin is not explicitly enabled: ${spec.id}`);
    }
  }
  if (entries["muad-runtime-guard"]?.hooks?.allowConversationAccess !== true) {
    throw new Error("Muad Runtime Guard conversation hook access is not enabled");
  }
}

export function validatePluginInventory(value, specs = IMAGE_PLUGINS) {
  const inventory = typeof value === "string" ? parseJSON(value, "plugin inventory") : value;
  if (!Array.isArray(inventory?.plugins)) throw new Error("OpenClaw plugin inventory is invalid");
  for (const spec of specs) {
    const item = inventory.plugins.find((candidate) => candidate?.id === spec.id);
    if (!item || item.enabled !== true || item.status === "error") {
      throw new Error(`OpenClaw plugin inventory is unhealthy: ${spec.id}`);
    }
  }
}

export function validateRuntimePermissions(config, dependencies = {}) {
  const access = dependencies.access ?? accessSync;
  const cliPath = dependencies.cliPath ?? SESSION_MANAGER_CLI;
  const tokenPath = config?.plugins?.entries?.["muad-runtime-guard"]?.config?.serviceTokenFile;
  if (tokenPath !== POD_SERVICE_TOKEN_FILE) throw new Error("Pod service token path is invalid");
  access(cliPath, constants.R_OK | constants.X_OK);
  access(tokenPath, constants.R_OK);
}

export function runImageSelfCheck(options = {}) {
  const versionOutput = options.versionOutput ?? execFileSync("openclaw", ["--version"], {
    encoding: "utf8",
  });
  assertOpenClawVersion(versionOutput);
  validatePluginArtifacts(options.plugins ?? IMAGE_PLUGINS, options.dependencies);
  if (options.imageOnly) return;
  const configPath = options.configPath ?? openClawConfigPath(process.env);
  const config = parseJSON(readFileSync(configPath, "utf8"), configPath);
  validateRuntimePluginConfig(config, options.plugins ?? IMAGE_PLUGINS);
  validateRuntimePermissions(config, options.dependencies);
  const inventory = options.inventoryOutput ?? execFileSync(
    "openclaw", ["plugins", "list", "--json"], { encoding: "utf8" },
  );
  validatePluginInventory(inventory, options.plugins ?? IMAGE_PLUGINS);
}

function openClawConfigPath(env) {
  const state = String(env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw").trim();
  return `${state}/openclaw.json`;
}

function plugin(id, root, relativeEntry) {
  return Object.freeze({ id, root, manifest: `${root}/openclaw.plugin.json`,
    entry: `${root}/${relativeEntry}` });
}

function parseJSON(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`invalid JSON: ${label}`, { cause: error });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function main() {
  try {
    runImageSelfCheck({ imageOnly: process.argv.includes("--image-only") });
    console.log(`[muad-self-check] openclaw=${PINNED_OPENCLAW_VERSION} status=ok`);
  } catch (error) {
    console.error(`[muad-self-check] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

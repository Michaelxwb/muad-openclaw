#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { IMAGE_CHANNEL_PLUGIN_SPECS } from "./image-plugin-paths.mjs";

const INSTALLED_PLUGIN_INDEX_KEY = "installed-plugin-index";

export function pruneManagedPluginInstalls({
  stateDir = defaultStateDir(process.env),
  pluginSpecs = IMAGE_CHANNEL_PLUGIN_SPECS,
  dependencies = {},
} = {}) {
  const targets = pluginTargetMap(pluginSpecs);
  if (targets.size === 0) return { changed: false, removedRecords: [], removedProjects: [] };

  const projectsDir = join(stateDir, "npm", "projects");
  const updatedRecords = rehomeInstalledPluginIndexRecords(stateDir, targets, dependencies);
  const removedProjects = uniqueSorted([
    ...pruneRecordNpmProjects(
      projectsDir,
      updatedRecords.previousInstallPaths,
      dependencies,
    ),
    ...pruneRecoveredNpmProjects(projectsDir, new Set(targets.keys()), dependencies),
  ]);
  const removedRecords = updatedRecords.ids;
  const changed = removedProjects.length > 0 || removedRecords.length > 0;
  return { changed, removedRecords, removedProjects };
}

function rehomeInstalledPluginIndexRecords(stateDir, targets, dependencies) {
  const dbPath = join(stateDir, "state", "openclaw.sqlite");
  if (!existsSync(dbPath)) return { ids: [], previousInstallPaths: [] };
  const sqlite = dependencies.sqlite ?? loadSqlite();
  if (!sqlite?.DatabaseSync) return { ids: [], previousInstallPaths: [] };

  const db = new sqlite.DatabaseSync(dbPath);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("installed_plugin_index");
    if (!table) return { ids: [], previousInstallPaths: [] };

    const row = db
      .prepare("SELECT install_records_json FROM installed_plugin_index WHERE index_key = ?")
      .get(INSTALLED_PLUGIN_INDEX_KEY);
    const records = parseRecord(row?.install_records_json);
    const updated = [];
    const previousInstallPaths = [];
    for (const [id, root] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
      const record = records[id];
      if (typeof record?.installPath === "string") previousInstallPaths.push(record.installPath);
      const nextRecord = buildImagePluginInstallRecord(root, dependencies);
      if (!nextRecord || stableJSON(record) === stableJSON(nextRecord)) continue;
      records[id] = nextRecord;
      updated.push(id);
    }
    if (updated.length === 0) return { ids: [], previousInstallPaths };

    db.prepare(
      "UPDATE installed_plugin_index SET install_records_json = ?, updated_at_ms = ? WHERE index_key = ?",
    ).run(JSON.stringify(records), Date.now(), INSTALLED_PLUGIN_INDEX_KEY);
    return { ids: updated, previousInstallPaths };
  } finally {
    db.close();
  }
}

function pruneRecordNpmProjects(projectsDir, installPaths, dependencies) {
  const rm = dependencies.rm ?? rmSync;
  const removed = [];
  for (const installPath of installPaths) {
    const projectDir = resolveProjectDir(projectsDir, installPath);
    if (!projectDir || removed.includes(projectDir)) continue;
    rm(projectDir, { recursive: true, force: true });
    removed.push(projectDir);
  }
  return removed.sort();
}

function pruneRecoveredNpmProjects(projectsDir, targets, dependencies) {
  const readDir = dependencies.readdir ?? readdirSync;
  const rm = dependencies.rm ?? rmSync;
  let entries;
  try {
    entries = readDir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projectsDir, entry.name);
    if (!projectOwnsAnyTarget(projectDir, targets, dependencies)) continue;
    rm(projectDir, { recursive: true, force: true });
    removed.push(projectDir);
  }
  return removed.sort();
}

function projectOwnsAnyTarget(projectDir, targets, dependencies) {
  const read = dependencies.readFile ?? readFileSync;
  for (const manifestPath of listPluginManifests(projectDir, dependencies)) {
    try {
      const manifest = JSON.parse(read(manifestPath, "utf8"));
      if (targets.has(String(manifest?.id ?? ""))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function listPluginManifests(projectDir, dependencies) {
  const readDir = dependencies.readdir ?? readdirSync;
  const nodeModules = join(projectDir, "node_modules");
  let packages;
  try {
    packages = readDir(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests = [];
  for (const entry of packages) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const entryPath = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      let scoped;
      try {
        scoped = readDir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (child.isDirectory()) manifests.push(join(entryPath, child.name, "openclaw.plugin.json"));
      }
      continue;
    }
    manifests.push(join(entryPath, "openclaw.plugin.json"));
  }
  return manifests.filter((file) => isInside(nodeModules, file));
}

function parseRecord(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildImagePluginInstallRecord(root, dependencies) {
  const read = dependencies.readFile ?? readFileSync;
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return null;
  let manifest = {};
  try {
    manifest = JSON.parse(read(packagePath, "utf8"));
  } catch {
    return null;
  }
  // 与 `openclaw plugins install <本地路径>` 写出的 path 记录对齐：
  // 只保留 source/sourcePath/installPath/version。spec、resolvedName、
  // resolvedVersion 是 npm 记录专属字段，path 记录里不存在，写多了反而
  // 增大与 OpenClaw 期望形态的偏差。installedAt 是动态时间戳，写入会破坏
  // stableJSON 幂等（每次运行都判 changed），且实测 gateway 接受缺失该字段。
  const version = clean(manifest?.version);
  return {
    source: "path",
    sourcePath: root,
    installPath: root,
    ...(version ? { version } : {}),
  };
}

function resolveProjectDir(projectsDir, installPath) {
  const raw = String(installPath ?? "").trim();
  if (!raw) return "";
  const base = resolve(projectsDir);
  const target = resolve(raw);
  if (!isInside(base, target)) return "";
  const relative = target.slice(base.length).split(sep).filter(Boolean);
  return relative.length > 0 ? join(base, relative[0]) : "";
}

function pluginTargetMap(specs) {
  const targets = new Map();
  for (const spec of Array.isArray(specs) ? specs : []) {
    const id = clean(spec?.id);
    const root = clean(spec?.root);
    if (id && root) targets.set(id, root);
  }
  return targets;
}

function stableJSON(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = sortValue(value[key]);
  return result;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
}

function clean(value) {
  return String(value ?? "").trim();
}

function loadSqlite() {
  try {
    return process.getBuiltinModule?.("node:sqlite") ?? null;
  } catch {
    return null;
  }
}

function defaultStateDir(env) {
  return String(env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw");
}

function isInside(parent, child) {
  const relative = resolve(child).slice(resolve(parent).length);
  return relative === "" || relative.startsWith(sep);
}

function main() {
  const result = pruneManagedPluginInstalls();
  if (!result.changed) return;
  console.log(
    `[muad-prune-plugin-installs] records=[${result.removedRecords.join(",")}] projects=${result.removedProjects.map((project) => basename(project)).join(",")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

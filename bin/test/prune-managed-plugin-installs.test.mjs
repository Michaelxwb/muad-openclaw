import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { pruneManagedPluginInstalls } from "../prune-managed-plugin-installs.mjs";

const sqlite = process.getBuiltinModule("node:sqlite");

test("rehomes image-managed plugin install records and prunes recovered npm projects", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "muad-prune-plugin-installs-"));
  try {
    const dbPath = join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(join(stateDir, "state"), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        install_records_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    const mattermostProject = join(stateDir, "npm", "projects", "mm");
    const wecomProject = join(stateDir, "npm", "projects", "wecom");
    const customProject = join(stateDir, "npm", "projects", "custom");
    const mattermostImage = join(stateDir, "image", "mattermost");
    const wecomImage = join(stateDir, "image", "wecom");
    db.prepare(
      "INSERT INTO installed_plugin_index (index_key, install_records_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run("installed-plugin-index", JSON.stringify({
      mattermost: { source: "npm", installPath: join(mattermostProject, "node_modules", "@openclaw", "mattermost") },
      "wecom-openclaw-plugin": { source: "npm", installPath: join(wecomProject, "node_modules", "@wecom", "wecom-openclaw-plugin") },
      custom: { source: "npm", installPath: join(customProject, "node_modules", "@custom", "plugin") },
    }), 1);
    db.close();

    writePluginManifest(mattermostProject, "@openclaw", "mattermost", "mattermost");
    mkdirSync(wecomProject, { recursive: true });
    writePluginManifest(customProject, "@custom", "plugin", "custom");
    writePackageManifest(mattermostImage, "@openclaw/mattermost", "2026.7.1");
    writePackageManifest(wecomImage, "@wecom/wecom-openclaw-plugin", "2026.6.23");

    const result = pruneManagedPluginInstalls({
      stateDir,
      pluginSpecs: [
        { id: "mattermost", root: mattermostImage },
        { id: "wecom-openclaw-plugin", root: wecomImage },
      ],
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.removedRecords, ["mattermost", "wecom-openclaw-plugin"]);
    assert.deepEqual(result.removedProjects, [mattermostProject, wecomProject].sort());
    assert.equal(existsSync(mattermostProject), false);
    assert.equal(existsSync(wecomProject), false);
    assert.equal(existsSync(customProject), true);

    const verify = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = verify
      .prepare("SELECT install_records_json FROM installed_plugin_index WHERE index_key = ?")
      .get("installed-plugin-index");
    verify.close();
    const records = JSON.parse(row.install_records_json);
    assert.deepEqual(Object.keys(records), ["mattermost", "wecom-openclaw-plugin", "custom"]);
    // 与 `openclaw plugins install <本地路径>` 的 path 记录形态一致，
    // 不允许混入 npm 专属字段（spec/resolvedName/resolvedVersion）。
    assert.deepEqual(records.mattermost, {
      source: "path",
      sourcePath: mattermostImage,
      installPath: mattermostImage,
      version: "2026.7.1",
    });
    assert.deepEqual(records["wecom-openclaw-plugin"], {
      source: "path",
      sourcePath: wecomImage,
      installPath: wecomImage,
      version: "2026.6.23",
    });
    assert.equal(records.custom.source, "npm");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("CLI pruning entrypoint exits cleanly and reports pruned plugins", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "muad-prune-plugin-cli-"));
  try {
    const dbPath = join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(join(stateDir, "state"), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        install_records_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO installed_plugin_index (index_key, install_records_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run("installed-plugin-index", JSON.stringify({
      mattermost: { source: "npm", installPath: join(stateDir, "npm", "projects", "mm", "node_modules", "@openclaw", "mattermost") },
    }), 1);
    db.close();

    const projectDir = join(stateDir, "npm", "projects", "mm");
    writePluginManifest(projectDir, "@openclaw", "mattermost", "mattermost");

    const result = spawnSync("node", ["bin/prune-managed-plugin-installs.mjs"], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /muad-prune-plugin-installs/);
    assert.equal(existsSync(projectDir), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function writePluginManifest(projectDir, scope, packageName, pluginId) {
  const packageDir = join(projectDir, "node_modules", scope, packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId }),
  );
}

function writePackageManifest(root, name, version) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version }),
  );
}

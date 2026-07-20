import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { deletePrivateSkill, installPrivateSkill } from "../private-skill-installer.mjs";

test("installs one private skill into the target agent workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-install-"));
  const bundle = makeBundle(root, {
    name: "xdr-query",
    manifest: {
      name: "xdr-query", runtime: "script", mode: "entrypoint", version: "1.2.0",
      visibility: "private", platforms: ["xdr"], progress: { source: "manual" },
      capabilities: ["browser"],
    },
  });
  const result = await installPrivateSkill({
    bundle, agentId: "alice", stateDir: root, expectedName: "xdr-query",
  });
  assert.equal(result.name, "xdr-query");
  assert.equal(result.version, "1.2.0");
  assert.deepEqual(result.platforms, ["xdr"]);
  assert.equal(result.progressSupported, true);
  assert.equal(result.browserRequired, true);
  assert.equal(result.entryType, "managed");
  assert.match(result.manifestHash, /^sha256:/u);
  assert.equal(readFileSync(join(root, "workspace-alice", "skills", "xdr-query", "SKILL.md"), "utf8"), "# XDR\n");
});

test("classifies a manifest-free private Skill with nested scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-traditional-script-"));
  const bundle = makeBundle(root, {
    name: "mss-report-skill",
    scripts: ["config/display.py", "scripts/export.sh", "node_modules/ignored.js"],
  });

  const result = await installPrivateSkill({ bundle, agentId: "alice", stateDir: root });

  assert.equal(result.entryType, "traditional-script");
  assert.deepEqual(JSON.parse(result.manifestJson).scriptFiles, [
    "config/display.py", "scripts/export.sh",
  ]);
});

test("installs one private skill from a zip bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-install-zip-"));
  const bundle = makeZipBundle(root, {
    name: "sdsp-query",
    manifest: { name: "sdsp-query", runtime: "script", visibility: "private", platform: "sdsp" },
  });
  const result = await installPrivateSkill({
    bundle, agentId: "alice", stateDir: root, expectedName: "sdsp-query", bundleFormat: "zip",
  });
  assert.equal(result.name, "sdsp-query");
  assert.deepEqual(result.platforms, ["sdsp"]);
  assert.equal(readFileSync(join(root, "workspace-alice", "skills", "sdsp-query", "SKILL.md"), "utf8"), "# sdsp-query\n");
});

test("uses fallback name when private skill metadata is loose", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-loose-zip-"));
  const bundle = makeZipBundle(root, {
    name: "Web Tools Guide 1.0.2",
    rawManifest: "{not json",
  });
  const result = await installPrivateSkill({
    bundle, agentId: "alice", stateDir: root, bundleFormat: "zip",
  });
  assert.equal(result.name, "web-tools-guide-1-0-2");
  assert.equal(readFileSync(
    join(root, "workspace-alice", "skills", "web-tools-guide-1-0-2", "SKILL.md"),
    "utf8",
  ), "# Web Tools Guide 1.0.2\n");
});

test("rejects zip bundles containing unsafe paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-bad-zip-"));
  const bundle = makeUnsafeZipBundle(root);
  await assert.rejects(
    () => installPrivateSkill({ bundle, agentId: "alice", stateDir: root, bundleFormat: "zip" }),
    /parent path|absolute path|escapes/u,
  );
});

test("rejects bundles containing symbolic links", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-symlink-"));
  const skillDir = join(root, "src", "bad-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Bad\n");
  symlinkSync("/etc/passwd", join(skillDir, "leak"));
  const bundle = tar(root, "src");
  await assert.rejects(
    () => installPrivateSkill({ bundle, agentId: "alice", stateDir: root }),
    /links|symlinks/u,
  );
});

test("rejects bundles with too many extracted entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-many-files-"));
  const source = join(root, "src", "huge-skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# Huge\n");
  for (let index = 0; index < 2050; index++) {
    writeFileSync(join(source, `file-${index}.txt`), "x");
  }

  await assert.rejects(
    () => installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root }),
    /too many files/u,
  );
});

test("delete removes only the selected private skill directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-delete-"));
  const bundle = makeBundle(root, { name: "soar-sync" });
  await installPrivateSkill({ bundle, agentId: "alice", stateDir: root });
  const result = await deletePrivateSkill({ agentId: "alice", stateDir: root, skillName: "soar-sync" });
  assert.equal(result.name, "soar-sync");
  assert.throws(() => readFileSync(join(root, "workspace-alice", "skills", "soar-sync", "SKILL.md")));
});

test("CLI emits JSON and enforces expected skill name", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-cli-"));
  const bundle = makeBundle(root, { name: "mssw-check" });
  const ok = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "private-skill-installer.mjs"),
    "install", "--agent-id", "alice", "--state-dir", root, "--expected-name", "mssw-check",
  ], { input: bundle, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).name, "mssw-check");

  const bad = spawnSync(process.execPath, [
    join(import.meta.dirname, "..", "private-skill-installer.mjs"),
    "install", "--agent-id", "alice", "--state-dir", root, "--expected-name", "wrong-name",
  ], { input: bundle, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /expected skill name/u);
});

function makeBundle(root, { name, manifest, scripts = [] }) {
  const source = join(root, `src-${name}`);
  const skillDir = join(source, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${name === "xdr-query" ? "XDR" : name}\n`);
  if (manifest) writeFileSync(join(skillDir, "muad.skill.json"), JSON.stringify(manifest));
  for (const script of scripts) {
    const target = join(skillDir, script);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "print('ok')\n");
  }
  return tar(root, `src-${name}`);
}

function makeZipBundle(root, { name, manifest, rawManifest }) {
  const source = join(root, `zip-src-${name}`);
  const skillDir = join(source, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
  if (manifest) writeFileSync(join(skillDir, "muad.skill.json"), JSON.stringify(manifest));
  if (rawManifest) writeFileSync(join(skillDir, "muad.skill.json"), rawManifest);
  return zip(root, `zip-src-${name}`);
}

function makeUnsafeZipBundle(root) {
  const source = join(root, "bad-zip-src");
  const evil = join(root, "evil");
  mkdirSync(source, { recursive: true });
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(source, "safe.txt"), "safe");
  writeFileSync(join(evil, "SKILL.md"), "# bad\n");
  const bundlePath = join(root, "bad.zip");
  execFileSync("zip", ["-q", bundlePath, "../evil/SKILL.md"], { cwd: source });
  return readFileSync(bundlePath);
}

function tar(root, relative) {
  const bundlePath = join(root, `${relative}.tar.gz`);
  execFileSync("tar", ["-czf", bundlePath, "-C", root, relative]);
  return readFileSync(bundlePath);
}

function zip(root, relative) {
  const bundlePath = join(root, `${relative}.zip`);
  execFileSync("zip", ["-qr", bundlePath, relative], { cwd: root });
  return readFileSync(bundlePath);
}

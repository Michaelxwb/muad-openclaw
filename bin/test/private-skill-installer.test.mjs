import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { deletePrivateSkill, exportPrivateSkill, installPrivateSkill, listPrivateSkills } from "../private-skill-installer.mjs";

test("installs one private skill into the target agent workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-install-"));
  const bundle = makeBundle(root, {
    name: "xdr-query",
    manifest: {
      name: "xdr-query", runtime: "script", mode: "entrypoint", version: "1.2.0",
      visibility: "private", platforms: ["xdr"], progress: { source: "manual" },
      capabilities: ["browser"], longTask: true,
    },
  });
  const result = await installPrivateSkill({
    bundle, agentId: "alice", stateDir: root, expectedName: "xdr-query",
  });
  assert.equal(result.name, "xdr-query");
  assert.equal(result.version, "1.2.0");
  assert.deepEqual(result.platforms, ["xdr"]);
  assert.equal(result.progressSupported, false);
  assert.equal(result.browserRequired, true);
  assert.equal(result.longTask, true);
  assert.equal(result.entryType, "managed");
  assert.match(result.manifestHash, /^sha256:/u);
  const stub = readFileSync(join(root, "workspace-alice", "skills", "xdr-query", "_longtask_submit.md"), "utf8");
  assert.match(stub, /background task/u);
  assert.doesNotMatch(stub, /MUAD_TASK/u);
  assert.equal(readFileSync(join(root, "workspace-alice", "skills", "xdr-query", "SKILL.md"), "utf8"), "# XDR\n");
});

test("export packages a staging skill as a tar.gz bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-export-staging-"));
  const staging = join(root, "workspace-alice", "skill-staging", "draft-skill");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "SKILL.md"), "# Draft\n");
  writeFileSync(join(staging, "run.py"), "print('draft')\n");

  const result = await exportPrivateSkill({ agentId: "alice", stateDir: root, skillName: "draft-skill" });
  assert.equal(result.name, "draft-skill");
  assert.ok(result.bundle.length > 0, "bundle should be non-empty");

  // Re-extract: the archive must contain draft-skill/SKILL.md for console skill_bundle validation.
  const extractDir = join(root, "extract-check");
  mkdirSync(extractDir, { recursive: true });
  const bundlePath = join(root, "bundle.tar.gz");
  writeFileSync(bundlePath, result.bundle);
  execFileSync("tar", ["-xzf", bundlePath, "-C", extractDir]);
  assert.equal(readFileSync(join(extractDir, "draft-skill", "SKILL.md"), "utf8"), "# Draft\n");
  assert.equal(readFileSync(join(extractDir, "draft-skill", "run.py"), "utf8"), "print('draft')\n");
});

test("export falls back to the installed real skills dir and rejects missing skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-export-real-"));
  const bundle = makeBundle(root, { name: "installed-skill" });
  await installPrivateSkill({ bundle, agentId: "alice", stateDir: root, expectedName: "installed-skill" });

  const result = await exportPrivateSkill({ agentId: "alice", stateDir: root, skillName: "installed-skill" });
  assert.equal(result.name, "installed-skill");
  assert.ok(result.bundle.length > 0);

  await assert.rejects(
    () => exportPrivateSkill({ agentId: "alice", stateDir: root, skillName: "missing-skill" }),
    /skill not found/u,
  );
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

test("lists installed private Skill manifest hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-list-"));
  const bundle = makeBundle(root, { name: "listed-skill" });
  const installed = await installPrivateSkill({ bundle, agentId: "alice", stateDir: root });

  const result = await listPrivateSkills({ agentId: "alice", stateDir: root });

  assert.deepEqual(result.skills, [{ name: "listed-skill", manifestHash: installed.manifestHash }]);
});

test("hashes the full private Skill directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-dir-hash-"));
  const source = join(root, "src");
  const skillDir = join(source, "hash-skill");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Hash\n");
  writeFileSync(join(skillDir, "scripts", "run.py"), "print('v1')\n");

  const installed = await installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root });
  assert.equal(installed.manifestHash, "sha256:c89fc9503b000262ffb1c772b3b6d639fe3738d349a281161f14028dd5212ab8");
  const listed = await listPrivateSkills({ agentId: "alice", stateDir: root });
  assert.deepEqual(listed.skills, [{ name: "hash-skill", manifestHash: installed.manifestHash }]);

  writeFileSync(join(skillDir, "scripts", "run.py"), "print('v2')\n");
  const changed = await installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root });
  assert.notEqual(changed.manifestHash, installed.manifestHash);
});

test("hashes private Skill paths using UTF-8 byte ordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-byte-sort-"));
  const files = {
    "SKILL.md": "# unicode-sort\n",
    "\uE000.txt": "private-use\n",
    "\u{10000}.txt": "supplementary\n",
  };

  const installed = await installPrivateSkill({
    bundle: makeBundle(root, {
      name: "unicode-sort",
      files: {
        "\uE000.txt": files["\uE000.txt"],
        "\u{10000}.txt": files["\u{10000}.txt"],
      },
    }),
    agentId: "alice",
    stateDir: root,
  });

  assert.equal(installed.manifestHash, expectedSkillHash(files));
  const listed = await listPrivateSkills({ agentId: "alice", stateDir: root });
  assert.deepEqual(listed.skills, [{ name: "unicode-sort", manifestHash: installed.manifestHash }]);
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

test("rejects invalid private Skill manifest JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-loose-zip-"));
  const bundle = makeZipBundle(root, {
    name: "Web Tools Guide 1.0.2",
    rawManifest: "{not json",
  });
  await assert.rejects(
    () => installPrivateSkill({ bundle, agentId: "alice", stateDir: root, bundleFormat: "zip" }),
    /invalid Skill manifest/u,
  );
});

test("accepts zip bundles with link-like text in regular file names", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-link-name-"));
  const bundle = makeZipBundle(root, {
    name: "link-name-skill",
    files: {
      "docs/a-link-name.txt": "ok\n",
      "docs/arrow->name.txt": "ok\n",
    },
  });

  const result = await installPrivateSkill({
    bundle, agentId: "alice", stateDir: root, bundleFormat: "zip",
  });

  assert.equal(result.name, "link-name-skill");
  assert.equal(
    readFileSync(join(root, "workspace-alice", "skills", "link-name-skill", "docs", "a-link-name.txt"), "utf8"),
    "ok\n",
  );
});

test("accepts zip bundles whose extracted size exceeds the old limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-huge-zip-"));
  const source = join(root, "huge-src", "huge-skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# Huge\n");
  writeFileSync(join(source, "payload.bin"), Buffer.alloc(26 * 1024 * 1024));

  const result = await installPrivateSkill({
    bundle: zip(root, "huge-src"), agentId: "alice", stateDir: root, bundleFormat: "zip",
  });
  assert.equal(result.name, "huge-skill");
});

test("rejects bundles containing multiple Skill roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-multiple-"));
  const source = join(root, "src");
  for (const name of ["one-skill", "two-skill"]) {
    const skillDir = join(source, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
  }
  await assert.rejects(
    () => installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root }),
    /multiple top-level Skill roots/u,
  );
});

test("allows nested SKILL.md files under one primary Skill root", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-nested-md-"));
  const source = join(root, "src");
  const skillDir = join(source, "xdr-query");
  mkdirSync(join(skillDir, "examples", "demo"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# XDR\n");
  writeFileSync(join(skillDir, "examples", "demo", "SKILL.md"), "# Demo\n");

  const result = await installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root });

  assert.equal(result.name, "xdr-query");
  assert.equal(
    readFileSync(join(root, "workspace-alice", "skills", "xdr-query", "examples", "demo", "SKILL.md"), "utf8"),
    "# Demo\n",
  );
});

test("rejects bundles without a SKILL.md entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-missing-md-"));
  const source = join(root, "src", "missing-skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "README.md"), "# Missing\n");

  await assert.rejects(
    () => installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root }),
    /must contain a SKILL.md/u,
  );
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
    /links|symlinks|absolute path/u,
  );
});

test("accepts tar bundles using local pax path metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-pax-"));
  const result = await installPrivateSkill({
    bundle: tarWithPaxLongPath(), agentId: "alice", stateDir: root,
  });
  assert.equal(result.name, "pax-skill");
  assert.equal(readFileSync(join(root, "workspace-alice", "skills", "pax-skill", "SKILL.md"), "utf8"), "# Pax\n");
});

test("accepts tar bundles using GNU long path metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-long-"));
  const result = await installPrivateSkill({
    bundle: tarWithGnuLongPath(), agentId: "alice", stateDir: root,
  });
  assert.equal(result.name, "long-skill");
  assert.equal(readFileSync(join(root, "workspace-alice", "skills", "long-skill", "SKILL.md"), "utf8"), "# Long\n");
});

test("rejects tar bundles whose pax path escapes the archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-bad-pax-"));

  await assert.rejects(
    () => installPrivateSkill({
      bundle: tarWithUnsafePaxPath(), agentId: "alice", stateDir: root,
    }),
    /parent path|absolute path/u,
  );
});

test("rejects tar bundles containing global pax metadata entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-global-pax-"));

  await assert.rejects(
    () => installPrivateSkill({
      bundle: tarWithGlobalPaxMetadata(), agentId: "alice", stateDir: root,
    }),
    /unsupported tar metadata entries/u,
  );
});

test("accepts bundles with more files than the old entry limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-many-files-"));
  const source = join(root, "src", "huge-skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# Huge\n");
  for (let index = 0; index < 2050; index++) {
    writeFileSync(join(source, `file-${index}.txt`), "x");
  }

  const result = await installPrivateSkill({ bundle: tar(root, "src"), agentId: "alice", stateDir: root });
  assert.equal(result.name, "huge-skill");
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

function makeBundle(root, { name, manifest, scripts = [], files = {} }) {
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
  for (const [name, content] of Object.entries(files)) {
    const target = join(skillDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return tar(root, `src-${name}`);
}

function expectedSkillHash(files) {
  const names = Object.keys(files).sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"), Buffer.from(right, "utf8"),
  ));
  const hash = createHash("sha256");
  const separator = Buffer.from([0]);
  for (const name of names) {
    hash.update(name, "utf8");
    hash.update(separator);
    hash.update(Buffer.from(files[name]));
    hash.update(separator);
  }
  return `sha256:${hash.digest("hex")}`;
}

function makeZipBundle(root, { name, manifest, rawManifest, files = {} }) {
  const source = join(root, `zip-src-${name}`);
  const skillDir = join(source, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
  if (manifest) writeFileSync(join(skillDir, "muad.skill.json"), JSON.stringify(manifest));
  if (rawManifest) writeFileSync(join(skillDir, "muad.skill.json"), rawManifest);
  for (const [name, content] of Object.entries(files)) {
    const target = join(skillDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
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

function tarWithPaxLongPath() {
  const skillBody = Buffer.from("# Pax\n");
  const longFile = `pax-skill/${"a".repeat(101)}.txt`;
  const longFileBody = Buffer.from("ok\n");
  return gzipSync(Buffer.concat([
    rawTarEntry("pax-skill/", "5", Buffer.alloc(0)),
    rawTarEntry("pax-skill/SKILL.md", "0", skillBody),
    rawTarEntry("./PaxHeaders.0/long-file", "x", paxBody({ path: longFile })),
    rawTarEntry("pax-skill/placeholder.txt", "0", longFileBody),
    Buffer.alloc(1024),
  ]));
}

function tarWithGnuLongPath() {
  const skillBody = Buffer.from("# Long\n");
  const longFile = `long-skill/${"b".repeat(101)}.txt`;
  const longFileBody = Buffer.from("ok\n");
  return gzipSync(Buffer.concat([
    rawTarEntry("long-skill/", "5", Buffer.alloc(0)),
    rawTarEntry("long-skill/SKILL.md", "0", skillBody),
    rawTarEntry("././@LongLink", "L", Buffer.from(`${longFile}\0`)),
    rawTarEntry("long-skill/placeholder.txt", "0", longFileBody),
    Buffer.alloc(1024),
  ]));
}

function tarWithUnsafePaxPath() {
  const skillBody = Buffer.from("# Safe\n");
  return gzipSync(Buffer.concat([
    rawTarEntry("./PaxHeaders.0/unsafe", "x", paxBody({ path: "../evil/SKILL.md" })),
    rawTarEntry("safe-skill/SKILL.md", "0", skillBody),
    Buffer.alloc(1024),
  ]));
}

function tarWithGlobalPaxMetadata() {
  const skillBody = Buffer.from("# Safe\n");
  return gzipSync(Buffer.concat([
    rawTarEntry("./GlobalHead.0", "g", paxBody({ comment: "global" })),
    rawTarEntry("safe-skill/SKILL.md", "0", skillBody),
    Buffer.alloc(1024),
  ]));
}

function paxBody(records) {
  return Buffer.from(Object.entries(records).map(([key, value]) => paxRecord(key, value)).join(""));
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

function rawTarEntry(name, type, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(type === "5" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(octalField(body.length, 12), 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(octalField(checksum, 8), 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function octalField(value, width) {
  const octal = value.toString(8);
  return `${"0".repeat(Math.max(0, width - octal.length - 1))}${octal}\0`;
}

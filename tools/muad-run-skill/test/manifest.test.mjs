import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSkillManifest, testing } from "../src/manifest.mjs";

test("validates steps mode manifests", () => {
  const manifest = testing.validateManifest(
    {
      name: "example-long-task",
      runtime: "script",
      mode: "steps",
      steps: [{ id: "auth", title: "鉴权", command: ["bash", "scripts/auth.sh"] }],
    },
    "/skills/example-long-task",
  );
  assert.equal(manifest.name, "example-long-task");
  assert.equal(manifest.steps[0].command[0], "bash");
});

test("rejects script manifests without commands in steps mode", () => {
  assert.throws(
    () =>
      testing.validateManifest(
        {
          name: "example-long-task",
          runtime: "script",
          mode: "steps",
          steps: [{ id: "auth", title: "鉴权" }],
        },
        "/skills/example-long-task",
      ),
    /command required/u,
  );
});

test("validates entrypoint mode manifests", () => {
  const manifest = testing.validateManifest(
    {
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "auth", title: "鉴权" }],
    },
    "/skills/example-long-task",
  );
  assert.deepEqual(manifest.entrypoint, ["bash", "scripts/run.sh"]);
  assert.deepEqual(manifest.progress, { source: "auto" });
});

test("validates manual progress source", () => {
  const manifest = testing.validateManifest(
    {
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      progress: { source: "manual" },
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "auth", title: "鉴权" }],
    },
    "/skills/example-long-task",
  );
  assert.deepEqual(manifest.progress, { source: "manual" });
});

test("loads nested manifests by manifest name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-manifest-test-"));
  const skillDir = path.join(root, "_templates", "example-long-task");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
  await fs.writeFile(
    path.join(skillDir, "muad.skill.json"),
    JSON.stringify({
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "query", title: "查询" }],
    }),
  );

  const manifest = await loadSkillManifest({ skillsRoot: root, skillName: "example-long-task" });

  assert.equal(manifest.skillDir, skillDir);
});

test("ignores unrelated corrupt manifests during recursive discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-manifest-corrupt-"));
  const badDir = path.join(root, "broken-skill");
  const skillDir = path.join(root, "reviewed", "example-long-task");
  await fs.mkdir(badDir, { recursive: true });
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(badDir, "muad.skill.json"), "{");
  await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
  await fs.writeFile(
    path.join(skillDir, "muad.skill.json"),
    JSON.stringify({
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "query", title: "查询" }],
    }),
  );

  const manifest = await loadSkillManifest({ skillsRoot: root, skillName: "example-long-task" });

  assert.equal(manifest.skillDir, skillDir);
});

test("loads the shipped reviewed public Skill template", async () => {
  const publicSkillsRoot = fileURLToPath(new URL("../../../skills", import.meta.url));
  const manifest = await loadSkillManifest({
    publicSkillsRoot, skillName: "example-long-task",
  });
  assert.equal(manifest.source, "public");
  assert.equal(manifest.visibility, "public");
  assert.equal(manifest.version, "1.0.0");
});

test("rejects arbitrary interpreters, absolute paths, and traversal", () => {
  const base = {
    name: "example-long-task",
    runtime: "script",
    mode: "entrypoint",
    steps: [{ id: "query", title: "查询" }],
  };
  assert.throws(
    () => testing.validateManifest({ ...base, entrypoint: ["curl", "scripts/run.sh"] }, "/skills/x"),
    /not approved/u,
  );
  assert.throws(
    () => testing.validateManifest({ ...base, entrypoint: ["bash", "/tmp/run.sh"] }, "/skills/x"),
    /unsafe path/u,
  );
  assert.throws(
    () => testing.validateManifest({ ...base, entrypoint: ["bash", "scripts/../run.sh"] }, "/skills/x"),
    /unsafe path/u,
  );
});

test("rejects script symlinks escaping the selected Skill", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-manifest-symlink-"));
  const skillDir = path.join(root, "unsafe-skill");
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  const outside = path.join(root, "outside.sh");
  await fs.writeFile(outside, "#!/bin/sh\nexit 0\n");
  await fs.symlink(outside, path.join(skillDir, "scripts", "run.sh"));
  await writeManifest(skillDir, manifestFor("unsafe-skill"));
  await assert.rejects(
    () => loadSkillManifest({ publicSkillsRoot: root, skillName: "unsafe-skill" }),
    /escapes the Skill directory/u,
  );
});

test("private same-name override requires explicit version approval", async () => {
  const publicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "muad-public-skills-"));
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "muad-private-skills-"));
  const publicDir = await createSkill(publicRoot, "xdr-query", manifestFor("xdr-query", {
    visibility: "public", version: "1.0.0",
  }));
  const privateDir = await createSkill(privateRoot, "xdr-query", manifestFor("xdr-query", {
    visibility: "private", version: "2.0.0",
  }));
  assert.ok(publicDir);
  await assert.rejects(
    () => loadSkillManifest({ publicSkillsRoot: publicRoot, privateSkillsRoot: privateRoot, skillName: "xdr-query" }),
    /override is not approved/u,
  );
  await writeManifest(privateDir, manifestFor("xdr-query", {
    visibility: "private",
    version: "2.0.0",
    override: { approved: true, publicVersion: "1.0.0", approvalId: "review-42" },
  }));
  const selected = await loadSkillManifest({
    publicSkillsRoot: publicRoot, privateSkillsRoot: privateRoot, skillName: "xdr-query",
  });
  assert.equal(selected.source, "private");
  assert.equal(selected.version, "2.0.0");
});

test("control-plane allowed source forces visible manifest selection", async () => {
  const publicRoot = await fs.mkdtemp(path.join(os.tmpdir(), "muad-public-forced-"));
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "muad-private-forced-"));
  await createSkill(publicRoot, "xdr-query", manifestFor("xdr-query", {
    visibility: "public", version: "1.0.0",
  }));
  await createSkill(privateRoot, "xdr-query", manifestFor("xdr-query", {
    visibility: "private", version: "2.0.0",
  }));

  const privateManifest = await loadSkillManifest({
    publicSkillsRoot: publicRoot, privateSkillsRoot: privateRoot,
    skillName: "xdr-query", allowedSource: "private",
  });
  assert.equal(privateManifest.source, "private");
  assert.equal(privateManifest.version, "2.0.0");

  const publicManifest = await loadSkillManifest({
    publicSkillsRoot: publicRoot, privateSkillsRoot: privateRoot,
    skillName: "xdr-query", allowedSource: "public",
  });
  assert.equal(publicManifest.source, "public");
  assert.equal(publicManifest.version, "1.0.0");
});

test("pure prompt Skills remain non-executable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-prompt-skill-"));
  const skillDir = path.join(root, "prompt-only");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Prompt only\n");
  await assert.rejects(
    () => loadSkillManifest({ publicSkillsRoot: root, skillName: "prompt-only" }),
    /muad\.skill\.json not found/u,
  );
});

async function createSkill(root, name, manifest) {
  const skillDir = path.join(root, name);
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
  await writeManifest(skillDir, manifest);
  return skillDir;
}

async function writeManifest(skillDir, manifest) {
  await fs.writeFile(path.join(skillDir, "muad.skill.json"), JSON.stringify(manifest));
}

function manifestFor(name, metadata = {}) {
  return {
    name,
    runtime: "script",
    mode: "entrypoint",
    entrypoint: ["bash", "scripts/run.sh"],
    steps: [{ id: "query", title: "查询" }],
    ...metadata,
  };
}

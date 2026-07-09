import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentGuidance } from "../openclaw-config-renderer.mjs";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "guid-render-"));
}

function runtime(root, guidance) {
  return {
    agents: [
      { id: "main", workspace: join(root, "workspace") },
      { id: "agent1", workspace: join(root, "workspace-agent1") },
    ],
    ...(guidance ? { guidance } : {}),
  };
}

test("default main guidance does not overwrite an existing BOOTSTRAP.md", () => {
  const root = freshRoot();
  const mainWs = join(root, "workspace");
  mkdirSync(mainWs, { recursive: true });
  const boot = join(mainWs, "BOOTSTRAP.md");
  writeFileSync(boot, "# Main custom\n\nAdmin hand-written notes.\n", { mode: 0o600 });
  writeAgentGuidance(runtime(root));
  assert.equal(
    readFileSync(boot, "utf8"),
    "# Main custom\n\nAdmin hand-written notes.\n",
    "hand-written BOOTSTRAP.md must be preserved when main guidance is unset",
  );
  rmSync(root, { recursive: true, force: true });
});

test("configured main guidance overwrites BOOTSTRAP.md", () => {
  const root = freshRoot();
  const mainWs = join(root, "workspace");
  mkdirSync(mainWs, { recursive: true });
  const boot = join(mainWs, "BOOTSTRAP.md");
  writeFileSync(boot, "old\n", { mode: 0o600 });
  writeAgentGuidance(runtime(root, { main: "CUSTOM-MAIN\n" }));
  assert.ok(
    readFileSync(boot, "utf8").includes("CUSTOM-MAIN"),
    "BOOTSTRAP.md must be replaced when main guidance is configured",
  );
  rmSync(root, { recursive: true, force: true });
});

test("configured userSkill guidance lands in AGENTS.md under 用户自建 Skill", () => {
  const root = freshRoot();
  const ag = join(root, "workspace-agent1", "AGENTS.md");
  writeAgentGuidance(runtime(root, { userSkill: "CUSTOM-SKILL-RULE\n" }));
  const text = readFileSync(ag, "utf8");
  assert.ok(text.includes("# 用户自建 Skill"), "user-skill section heading present");
  assert.ok(text.includes("CUSTOM-SKILL-RULE"), "configured rule present");
  assert.ok(text.includes("Skill activation boundary"), "locked system section still present");
  rmSync(root, { recursive: true, force: true });
});

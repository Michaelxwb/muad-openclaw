import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentGuidance } from "../openclaw-config-renderer.mjs";

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "guid-render-"));
}

function runtime(root, guidance, prompt) {
  return {
    agents: [
      { id: "main", workspace: join(root, "workspace") },
      {
        id: "agent1",
        workspace: join(root, "workspace-agent1"),
        ...(prompt ? { prompt } : {}),
      },
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

test("global prompt renders before memory, per-user prompt after skill", () => {
  const root = freshRoot();
  const ag = join(root, "workspace-agent1", "AGENTS.md");
  writeAgentGuidance(runtime(
    root,
    { globalPrompt: "# 全局规则\n- 用中文回答中文提问" },
    "用中文回答中文提问",
  ));
  const text = readFileSync(ag, "utf8");
  assert.ok(text.includes("<!-- muad:global-prompt:start -->"), "global prompt block present");
  assert.ok(text.includes("<!-- muad:user-prompt:start -->"), "user prompt block present");
  assert.ok(
    text.indexOf("<!-- muad:global-prompt:start -->") < text.indexOf("<!-- muad:memory:start -->"),
    "global block must precede the memory block",
  );
  assert.ok(
    text.indexOf("<!-- muad:skill-activation:end -->") < text.indexOf("<!-- muad:user-prompt:start -->"),
    "user prompt block must follow the skill block",
  );
  assert.ok(text.includes("用中文回答中文提问"), "configured prompt content present");
  rmSync(root, { recursive: true, force: true });
});

test("empty per-agent prompt renders no user prompt block", () => {
  const root = freshRoot();
  const ag = join(root, "workspace-agent1", "AGENTS.md");
  writeAgentGuidance(runtime(root));
  const text = readFileSync(ag, "utf8");
  assert.doesNotMatch(text, /muad:user-prompt/u, "no user prompt block for an empty prompt");
  assert.doesNotMatch(text, /muad:global-prompt/u, "no global prompt block when unset");
  rmSync(root, { recursive: true, force: true });
});

test("clearing a per-agent prompt removes the block and keeps manual content", () => {
  const root = freshRoot();
  const ws = join(root, "workspace-agent1");
  mkdirSync(ws, { recursive: true });
  const ag = join(ws, "AGENTS.md");
  writeFileSync(ag, "# My manual notes\n\nKeep this.\n\n", { mode: 0o600 });
  writeAgentGuidance(runtime(root, {}, "always-zh"));
  const withBlock = readFileSync(ag, "utf8");
  assert.match(withBlock, /muad:user-prompt:start/u, "prompt block inserted on first apply");
  assert.match(withBlock, /Keep this\./u, "manual content preserved alongside the block");

  writeAgentGuidance(runtime(root));
  const afterClear = readFileSync(ag, "utf8");
  assert.doesNotMatch(afterClear, /muad:user-prompt/u, "prompt block removed after clearing");
  assert.match(afterClear, /Keep this\./u, "manual content survives block removal");
  assert.match(afterClear, /muad:memory:start/u, "managed memory block still present");
  rmSync(root, { recursive: true, force: true });
});

test("inserting new blocks into an unmanaged file preserves manual content", () => {
  const root = freshRoot();
  const ws = join(root, "workspace-agent1");
  mkdirSync(ws, { recursive: true });
  const ag = join(ws, "AGENTS.md");
  writeFileSync(ag, "# Hand-written preamble\n\nCustom rules.\n", { mode: 0o600 });
  writeAgentGuidance(runtime(root, { globalPrompt: "GLOBAL-RULE" }, "USER-RULE"));
  const text = readFileSync(ag, "utf8");
  assert.match(text, /# Hand-written preamble/u, "manual preamble preserved");
  assert.match(text, /Custom rules\./u, "manual rules preserved");
  assert.ok(
    text.indexOf("<!-- muad:global-prompt:start -->") < text.indexOf("<!-- muad:memory:start -->"),
    "global block inserted before memory",
  );
  assert.ok(
    text.indexOf("<!-- muad:skill-activation:end -->") < text.indexOf("<!-- muad:user-prompt:start -->"),
    "user prompt block inserted after skill",
  );
  rmSync(root, { recursive: true, force: true });
});

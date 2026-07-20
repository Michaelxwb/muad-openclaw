import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentFilesPolicy,
  createBrowserProfilePolicy,
  createMainDenyPolicy,
} from "../src/tool-policies.mjs";

const config = {
  valid: true,
  mainAgentId: "main",
  agentProfiles: [
    { agentId: "alice", profile: "profile-alice" },
    { agentId: "bob", profile: "profile-bob" },
  ],
  skillReadRoots: [
    { agentId: "alice", roots: ["/opt/openclaw-skills/web-tools-guide"] },
    { agentId: "bob", roots: ["/state/workspace-bob/skills/private-report"] },
  ],
};

test("browser policy pins omitted profiles and accepts only the mapped profile", async () => {
  const policy = createBrowserProfilePolicy({ config });
  const pinned = await policy.evaluate(browser({ action: "open", targetUrl: "https://example.com" }), context("alice"));
  assert.deepEqual(pinned.params, {
    action: "open", targetUrl: "https://example.com", profile: "profile-alice",
  });

  const same = await policy.evaluate(browser({ action: "tabs", profile: "profile-alice" }), context("alice"));
  assert.equal(same.params.profile, "profile-alice");
});

test("browser policy rejects forged, unmapped and profile-management requests", async () => {
  const violations = [];
  const policy = createBrowserProfilePolicy({ config, onViolation: (entry) => violations.push(entry) });
  for (const [params, agentId] of [
    [{ action: "open", profile: "profile-bob" }, "alice"],
    [{ action: "profiles" }, "alice"],
    [{ action: "open" }, "unknown"],
    [{ profile: "profile-alice" }, "alice"],
  ]) {
    const result = await policy.evaluate(browser(params), context(agentId));
    assert.equal(result.allow, false);
  }
  assert.equal(violations.length, 4);
});

test("main and business-agent shell execution are denied fail-closed", async () => {
  const main = createMainDenyPolicy(config);
  assert.equal((await main.evaluate(browser({ action: "open" }), context("main"))).allow, false);
  assert.equal(await main.evaluate(browser({ action: "open" }), context("alice")), undefined);

  const files = filePolicy();
  for (const event of [
    { toolName: "exec", params: { command: "id" } },
    { toolName: "bash", params: { command: "id" } },
    { toolName: "custom", toolKind: "code_mode_exec", params: {} },
  ]) assert.equal((await files.evaluate(event, context("alice"))).allow, false);
});

test("file policy allows the current workspace and blocks cross-user and runtime state", async () => {
  const policy = filePolicy();
  assert.equal(await policy.evaluate(file("read", "notes/today.md"), context("alice")), undefined);
  assert.equal(await policy.evaluate(file("write", "/state/workspace-alice/result.txt"), context("alice")), undefined);

  for (const target of [
    "/state/workspace-bob/MEMORY.md",
    "/state/agents/alice/agent/config.json",
    "/state/agents/alice/session-store/xdr/cookies.json",
    "../workspace-bob/MEMORY.md",
  ]) assert.equal((await policy.evaluate(file("read", target), context("alice"))).allow, false);
});

test("file policy rejects workspace symlink escapes via realpath", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muad-policy-"));
  try {
    const workspace = path.join(root, "workspace-alice");
    const outside = path.join(root, "outside-secret.txt");
    const escapeLink = path.join(workspace, "escape.txt");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, escapeLink);

    const policy = createAgentFilesPolicy({
      config,
      resolvePaths: () => ({
        workspace,
        agentDir: path.join(root, "agents/alice/agent"),
        sessionStore: path.join(root, "agents/alice/session-store"),
      }),
    });
    assert.equal((await policy.evaluate(file("read", escapeLink), context("alice"))).allow, false);
    assert.equal((await policy.evaluate(file("read", "escape.txt"), context("alice"))).allow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("file policy allows only read access to the current agent authorized Skill roots", async () => {
  const policy = filePolicy();
  const skillFile = "/opt/openclaw-skills/web-tools-guide/SKILL.md";
  assert.equal(await policy.evaluate(file("read", skillFile), context("alice")), undefined);
  assert.equal((await policy.evaluate(file("write", skillFile), context("alice"))).allow, false);
  assert.equal((await policy.evaluate(
    file("read", "/opt/openclaw-skills/ungranted/SKILL.md"), context("alice"),
  )).allow, false);
  assert.equal((await policy.evaluate(
    file("read", "/state/workspace-bob/skills/private-report/SKILL.md"), context("alice"),
  )).allow, false);
});

test("apply_patch requires host-derived paths and checks every target", async () => {
  const policy = filePolicy();
  const allowed = { toolName: "apply_patch", params: { patch: "opaque" },
    derivedPaths: ["/state/workspace-alice/a.txt", "/state/workspace-alice/b.txt"] };
  assert.equal(await policy.evaluate(allowed, context("alice")), undefined);
  assert.equal((await policy.evaluate({ ...allowed, derivedPaths: [] }, context("alice"))).allow, false);
  assert.equal((await policy.evaluate({ ...allowed,
    derivedPaths: ["/state/workspace-alice/a.txt", "/state/workspace-bob/b.txt"],
  }, context("alice"))).allow, false);
});

function filePolicy() {
  return createAgentFilesPolicy({
    config,
    resolvePaths: (agentId) => ({
      workspace: `/state/workspace-${agentId}`,
      agentDir: `/state/agents/${agentId}/agent`,
      sessionStore: `/state/agents/${agentId}/session-store`,
    }),
  });
}

function browser(params) {
  return { toolName: "browser", params };
}

function file(toolName, path) {
  return { toolName, params: { path } };
}

function context(agentId) {
  return { agentId, toolName: "test", toolCallId: "call-1" };
}

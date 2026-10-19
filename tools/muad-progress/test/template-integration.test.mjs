import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliPath = path.join(packageRoot, "dist", "cli.js");
const templatesRoot = path.join(repoRoot, "skills", "_templates");
const templates = [
  { name: "python", dir: "business-skill-python", command: "python3", script: "scripts/run.py" },
];

test("template scripts report stage and done without polluting successful business stdout", (t) => {
  const setup = testSetup(t);
  for (const template of templates) {
    const result = runTemplate(template, setup, false, true);
    assert.equal(result.status, 0, `${template.name}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.deepEqual(readEvents(result.eventsFile).map((event) => event.type), ["progress", "done"]);
  }
});

test("template scripts fail loud and report a user-readable error node", (t) => {
  const setup = testSetup(t);
  for (const template of templates) {
    const result = runTemplate(template, setup, true, true);
    assert.notEqual(result.status, 0, `${template.name} must fail`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /处理失败，请稍后重试/u);
    assert.deepEqual(readEvents(result.eventsFile).map((event) => event.type), ["progress", "error"]);
  }
});

test("template progress is explicit best-effort when no execution bridge is available", (t) => {
  const setup = testSetup(t);
  for (const template of templates) {
    const result = runTemplate(template, setup, false, false);
    assert.equal(result.status, 0, `${template.name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test("template business success survives a missing progress executable during rollback", (t) => {
  const setup = testSetup(t, false);
  for (const template of templates) {
    const result = runTemplate(template, setup, false, false);
    assert.equal(result.status, 0, `${template.name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

function testSetup(t, includeProgress = true) {
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-templates-"));
  const binDir = createTestBin(root, includeProgress);
  const stubDir = createPlatformStub(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, binDir, stubDir };
}

function runTemplate(template, setup, failPlatform, withEvents, extraEnv = {}) {
  const templateRoot = path.join(templatesRoot, template.dir);
  const eventsFile = path.join(setup.root, `${template.name}-${failPlatform ? "fail" : "ok"}.jsonl`);
  const outputDir = path.join(setup.root, `${template.name}-output`);
  const pythonPath = [setup.stubDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    HOME: setup.root,
    USERPROFILE: setup.root,
    PATH: `${setup.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PYTHONPATH: pythonPath,
    SKILL_OUTPUT_DIR: outputDir,
    PLATFORM_STUB_FAIL: failPlatform ? "1" : "0",
    ...extraEnv,
  };
  if (withEvents) env.MUAD_PROGRESS_EVENTS_FILE = eventsFile;
  const result = spawnSync(template.command, [template.script], { cwd: templateRoot, env, encoding: "utf8" });
  return { ...result, eventsFile };
}

const TEMPLATE_STATE = {
  version: 1,
  platforms: {
    example_platform: {
      cookies: [],
      requestProfile: { baseUrl: "https://platform.invalid" },
    },
  },
};

test("template falls back to ~/.muad-local/session-state.json without session-manager", (t) => {
  const setup = testSetup(t);
  rmSync(path.join(setup.binDir, "session-manager"));
  const statePath = path.join(setup.root, ".muad-local", "session-state.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(TEMPLATE_STATE));
  for (const template of templates) {
    const result = runTemplate(template, setup, false, false, {
      MUAD_SESSION_KEY: "",
    });
    assert.equal(result.status, 0, `${template.name}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

function createTestBin(root, includeProgress) {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, "session-state.json");
  writeFileSync(statePath, JSON.stringify(TEMPLATE_STATE));
  writeFileSync(path.join(binDir, "session-manager"),
    `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"sessionStateFile": ${JSON.stringify(statePath)}}))\n`,
    { mode: 0o755 });
  if (includeProgress) {
    writeFileSync(path.join(binDir, "muad-progress"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`, { mode: 0o755 });
  }
  return binDir;
}

function createPlatformStub(root) {
  const stubDir = path.join(root, "stub");
  mkdirSync(stubDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stubDir, "requests.py"), `import os

class _Response:
    def __init__(self, status_code):
        self.status_code = status_code

def get(url, **kwargs):
    if os.environ.get("PLATFORM_STUB_FAIL") == "1":
        return _Response(500)
    expected = os.environ.get("PLATFORM_STUB_EXPECT_URL")
    if expected and url != expected:
        raise RuntimeError("unexpected url: %r" % (url,))
    return _Response(200)
`);
  return stubDir;
}

function readEvents(eventsFile) {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

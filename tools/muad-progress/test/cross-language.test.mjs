import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageRoot, "dist", "cli.js");
const fixtures = path.join(packageRoot, "test", "fixtures");

test("S-05 Shell Python Node and Go invoke one compiled CLI with the same event schema", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-languages-"));
  const binDir = createTestBin(root);
  const eventsFile = path.join(root, "events.jsonl");
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, MUAD_PROGRESS_EVENTS_FILE: eventsFile };
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    { language: "shell", command: "bash", args: [path.join(fixtures, "progress-shell.sh")] },
    { language: "python", command: "python3", args: [path.join(fixtures, "progress-python.py")] },
    { language: "node", command: process.execPath, args: [path.join(fixtures, "progress-node.mjs")] },
  ];
  if (spawnSync("go", ["version"], { encoding: "utf8" }).status === 0) {
    cases.push({ language: "go", command: "go", args: ["run", path.join(fixtures, "progress-go.go")] });
  } else {
    assert.match(readFileSync(path.join(fixtures, "progress-go.go"), "utf8"), /exec\.Command/u);
  }
  for (const fixture of cases) assertFixture(fixture, env);

  const events = readEvents(eventsFile);
  assert.equal(events.length, cases.length);
  assert.deepEqual(events.map(eventShape), Array.from({ length: cases.length }, () => eventShape(events[0])));
  for (const event of events) assertEvent(event);
});

function assertFixture(fixture, env) {
  const result = spawnSync(fixture.command, fixture.args, { cwd: packageRoot, env, encoding: "utf8" });
  assert.equal(result.status, 0, `${fixture.language}: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, language: fixture.language });
  assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1, "progress must not pollute business stdout");
}

function assertEvent(event) {
  assert.equal(event.type, "done");
  assert.equal(event.stage, "query");
  assert.equal(event.text, "四语言一致 ✅\nMarkdown **bold**");
  assert.equal(event.id, "cross-language");
  assert.equal(event.skill, "fixture-skill");
  assert.equal(event.visibility, "channel");
  assert.equal(event.privacy, "public");
  assert.equal(Number.isNaN(Date.parse(event.ts)), false);
}

function eventShape(event) {
  return Object.keys(event).sort();
}

function createTestBin(root) {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const executable = path.join(binDir, "muad-progress");
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`, { mode: 0o755 });
  return binDir;
}

function readEvents(eventsFile) {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

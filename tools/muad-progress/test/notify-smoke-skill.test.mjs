import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliPath = path.join(packageRoot, "dist", "cli.js");
const skillRoot = path.join(repoRoot, "skills", "progress-notify-smoke");

test("B-04 progress-notify-smoke emits two ordered stage/done nodes without route arguments", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "progress-notify-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = createTestBin(root);
  const eventsFile = path.join(root, "events.jsonl");
  const result = spawnSync(process.execPath, ["scripts/run.mjs"], {
    cwd: skillRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      MUAD_PROGRESS_EVENTS_FILE: eventsFile,
      MUAD_SKILL_NAME: "progress-notify-smoke",
      PROGRESS_SMOKE_DELAY_MS: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "PROGRESS_NOTIFY_SMOKE_OK",
    nodes: 2,
    notifications: 4,
  });
  const events = readEvents(eventsFile);
  assert.deepEqual(events.map(({ type, stage }) => ({ type, stage })), [
    { type: "progress", stage: "prepare" },
    { type: "done", stage: "prepare" },
    { type: "progress", stage: "deliver" },
    { type: "done", stage: "deliver" },
  ]);
  assert.match(events[0].text, /中文.*English.*😀.*\*\*Markdown\*\*/su);
  assert.ok(events.every((event) => !("channel" in event) && !("peerId" in event)));
});

function createTestBin(root) {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(binDir, "muad-progress"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`,
    { mode: 0o755 },
  );
  return binDir;
}

function readEvents(eventsFile) {
  return readFileSync(eventsFile, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

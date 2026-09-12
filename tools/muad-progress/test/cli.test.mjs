import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("S-01 stage, done, and error append schema-v1 events to a real JSONL file", () => {
  const fixture = temporaryEvents();
  try {
    const cases = [
      ["stage", "progress", "query", "正在查询"],
      ["done", "done", "query", "已获取 128 条"],
      ["error", "error", "query", "查询失败"],
    ];
    for (const [command, type, stage, text] of cases) {
      const extra = command === "error" ? ["--code", "query_failed"] : [];
      const result = runCLI([command, "--stage", stage, "--text", text, ...extra], fixture.path);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "", `${command} success must be silent by default`);
      assert.equal(result.stderr, "");
      const event = readEvents(fixture.path).at(-1);
      assert.equal(event.type, type);
      assert.equal(event.stage, stage);
      assert.equal(event.text, text);
      assert.equal(event.visibility, "channel");
      assert.equal(event.privacy, "public");
      assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/u);
    }
    assert.equal(readEvents(fixture.path).length, 3);
  } finally {
    fixture.cleanup();
  }
});

test("S-01 validate checks an event without writing the JSONL file", () => {
  const fixture = temporaryEvents();
  try {
    const result = runCLI([
      "validate", "--stage", "query", "--text", "**正在查询** 😀",
    ], fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(existsSync(fixture.path), false);
  } finally {
    fixture.cleanup();
  }
});

test("S-01 --json reports only the local written result", () => {
  const fixture = temporaryEvents();
  try {
    const result = runCLI([
      "stage", "--stage", "render", "--text", "生成报告", "--id", "render-1", "--json",
    ], fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      delivery: "written",
      event: readEvents(fixture.path)[0],
    });
  } finally {
    fixture.cleanup();
  }
});

test("done raw accepts a long final result and repeated absolute media paths", () => {
  const fixture = temporaryEvents();
  try {
    const text = "推".repeat(2_000);
    const result = runCLI([
      "done", "--stage", "event_1", "--text", text, "--raw",
      "--media", "/workspace/one.png", "--media", "/workspace/two.png",
    ], fixture.path);
    assert.equal(result.status, 0, result.stderr);
    const event = readEvents(fixture.path)[0];
    assert.equal(event.raw, true);
    assert.equal(event.text, text);
    assert.deepEqual(event.media, ["/workspace/one.png", "/workspace/two.png"]);
  } finally {
    fixture.cleanup();
  }
});

test("stage rejects raw final-result flags", () => {
  const result = runCLI(["stage", "--stage", "event_1", "--text", "safe", "--raw"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "muad-progress: invalid_arguments\n");
});

test("S-01 skill falls back to the trusted execution environment", () => {
  const fixture = temporaryEvents();
  try {
    const result = runCLI(
      ["stage", "--stage", "query", "--text", "正在查询"],
      fixture.path,
      { MUAD_SKILL_NAME: "report-customer-weekly" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readEvents(fixture.path)[0].skill, "report-customer-weekly");
  } finally {
    fixture.cleanup();
  }
});

test("S-01 unavailable bridge is best-effort unless strict mode is enabled", () => {
  const args = ["stage", "--stage", "query", "--text", "正在查询", "--json"];
  const bestEffort = runCLI(args);
  assert.equal(bestEffort.status, 0, bestEffort.stderr);
  assert.equal(JSON.parse(bestEffort.stdout).delivery, "skipped");

  const silent = runCLI(["stage", "--stage", "query", "--text", "正在查询"]);
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, "");
  assert.equal(silent.stderr, "");

  const strict = runCLI(args, undefined, { MUAD_PROGRESS_STRICT_ADAPTER: "1" });
  assert.equal(strict.status, 4);
  assert.equal(strict.stdout, "");
  assert.deepEqual(JSON.parse(strict.stderr), {
    ok: false,
    error: { code: "bridge_unavailable", message: "progress bridge is unavailable" },
  });

  const relative = runCLI(args, "relative/events.jsonl");
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal(JSON.parse(relative.stdout).delivery, "skipped");

  const strictRelative = runCLI(args, "relative/events.jsonl", { MUAD_PROGRESS_STRICT_BRIDGE: "true" });
  assert.equal(strictRelative.status, 4);
  assert.equal(JSON.parse(strictRelative.stderr).error.code, "bridge_unavailable");
});

test("RULE-03 CLI rejection never echoes sensitive input or writes a deliverable event", () => {
  const fixture = temporaryEvents();
  try {
    const secret = "token=must-not-leak";
    const result = runCLI([
      "stage", "--stage", "query", "--text", secret, "--json",
    ], fixture.path);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "sensitive_content");
    assert.equal(result.stderr.includes(secret), false);
    // 失败只允许留下 type="log" 诊断事件（不含用户输入），供 runtime-guard
    // 写入 openclaw 日志；不得写入任何投递类事件。
    const events = existsSync(fixture.path) ? readEvents(fixture.path) : [];
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "log");
    assert.equal(events[0].text, "error=sensitive_content");
    assert.equal(JSON.stringify(events[0]).includes("must-not-leak"), false);
  } finally {
    fixture.cleanup();
  }
});

test("S-01 CLI failures append a log diagnostic event for openclaw logging", () => {
  const fixture = temporaryEvents();
  try {
    const result = runCLI(["stage", "--stage", "Bad Stage!", "--text", "安全文本"], fixture.path);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "muad-progress: invalid_event\n");
    const events = readEvents(fixture.path);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "log");
    assert.equal(events[0].stage, "stage");
    assert.equal(events[0].text, "error=invalid_event");
    assert.equal(events[0].visibility, "channel");
    assert.equal(events[0].privacy, "public");
  } finally {
    fixture.cleanup();
  }
});

test("S-01 unknown and duplicate arguments fail without echoing values", () => {
  const unknown = runCLI([
    "stage", "--stage", "query", "--text", "safe", "--channel", "private-peer",
  ]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, "muad-progress: invalid_arguments\n");
  assert.equal(unknown.stderr.includes("private-peer"), false);

  const duplicate = runCLI([
    "stage", "--stage", "one", "--stage", "two", "--text", "safe",
  ]);
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.stderr, "muad-progress: invalid_arguments\n");
});

test("S-01 --help and --version remain stable for scripts and image self-check", () => {
  const help = runCLI(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^muad-progress reports user-visible skill progress\./u);
  assert.match(help.stdout, /muad-progress stage --stage <id> --text <text>/u);
  assert.equal(help.stderr, "");

  const version = runCLI(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "muad-progress 0.2.0\n");
  assert.equal(version.stderr, "");
});

test("S-01 concurrent processes preserve one complete JSON line per append", async () => {
  const fixture = temporaryEvents();
  try {
    const count = 24;
    await Promise.all(Array.from({ length: count }, (_, index) => runCLIAsync([
      "stage", "--stage", "parallel", "--text", `事件 ${index}`, "--id", `event-${index}`,
    ], fixture.path)));
    const events = readEvents(fixture.path);
    assert.equal(events.length, count);
    assert.deepEqual(new Set(events.map((event) => event.id)), new Set(
      Array.from({ length: count }, (_, index) => `event-${index}`),
    ));
  } finally {
    fixture.cleanup();
  }
});

function runCLI(args, eventsFile, extraEnv = {}) {
  const env = { PATH: process.env.PATH, ...extraEnv };
  if (eventsFile !== undefined) env.MUAD_PROGRESS_EVENTS_FILE = eventsFile;
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
}

function runCLIAsync(args, eventsFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { PATH: process.env.PATH, MUAD_PROGRESS_EVENTS_FILE: eventsFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

function temporaryEvents() {
  const root = mkdtempSync(join(tmpdir(), "muad-progress-cli-"));
  return { path: join(root, "events.jsonl"), cleanup: () => rmSync(root, { recursive: true }) };
}

function readEvents(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

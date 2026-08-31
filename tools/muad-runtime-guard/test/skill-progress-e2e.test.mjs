import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LongTaskManager } from "../src/long-task-manager.mjs";
import { createSkillOutputHooks } from "../src/skill-output-hooks.mjs";
import { createSkillProgressHooks } from "../src/skill-progress-hooks.mjs";
import { SkillProgressManager } from "../src/skill-progress-manager.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliRoot = path.join(repoRoot, "tools", "muad-progress");
const cliPath = path.join(cliRoot, "dist", "cli.js");
const executableFixture = fileURLToPath(new URL("./fixtures/openclaw-progress-test.mjs", import.meta.url));
const finalText = "完整最终报告：共处理 128 条记录";

test("S-04 B-03 progress stays isolated across two users and native final is delivered once", async (t) => {
  buildCli();
  const harness = createHarness(t);
  const executions = await startExecutions(harness);
  emitProgress(executions);
  assertCapabilityFiles(executions);

  const records = await completeExecutions(harness, executions);
  assertProgressIsolation(records);
  assertFailureIsolation(records);
  assertFinalDelivery(records);
  assertDiagnostics(harness.logs);
});

function buildCli() {
  const build = spawnSync("npm", ["run", "build"], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
}

function createHarness(t) {
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-full-e2e-"));
  const logs = [];
  const restoreEnv = configureExecutable(root);
  const progressManager = new SkillProgressManager({
    rootDir: path.join(root, "events"),
    notifyTimeoutMs: 1_000,
    finishTimeoutMs: 1_500,
    log: (message) => logs.push(message),
  });
  const foreground = createSkillProgressHooks({ manager: progressManager, autoStart: false });
  const longManager = new LongTaskManager({
    limit: 1,
    timeoutSeconds: 5,
    stateFile: path.join(root, "long-task", "state.jsonl"),
    progressManager,
    log: (message) => logs.push(message),
  });
  const output = createSkillOutputHooks({
    manager: longManager,
    progressManager,
    resolveWorkspace: () => path.join(root, "workspace"),
  });
  t.after(() => cleanup({ root, restoreEnv, progressManager, foreground, longManager }));
  return { root, logs, restoreEnv, progressManager, foreground, longManager, output };
}

function configureExecutable(root) {
  const binDir = path.join(root, "bin");
  const executable = path.join(binDir, "openclaw");
  const logFile = path.join(root, "openclaw.jsonl");
  const releaseFile = path.join(root, "release-final");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(logFile, "", { mode: 0o600 });
  copyFileSync(executableFixture, executable);
  chmodSync(executable, 0o755);
  const previous = captureEnv(["PATH", "OPENCLAW_TEST_LOG", "OPENCLAW_TEST_RELEASE_FILE", "OPENCLAW_TEST_FINAL_TEXT"]);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.OPENCLAW_TEST_LOG = logFile;
  process.env.OPENCLAW_TEST_RELEASE_FILE = releaseFile;
  process.env.OPENCLAW_TEST_FINAL_TEXT = finalText;
  return { previous, logFile, releaseFile };
}

async function startExecutions(harness) {
  const foregroundContext = {
    runId: "run-foreground", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:foreground-owner",
  };
  const registered = harness.foreground.activate({
    ...foregroundContext, skillName: "foreground-skill", locale: "zh",
  });
  assert.equal(registered.registered, true);
  const foregroundEnv = await harness.foreground.resolveExecEnv(
    { toolName: "exec", runId: foregroundContext.runId }, foregroundContext,
  );
  const submitted = harness.longManager.submit(backgroundTask());
  const backgroundContext = { agentId: "bob", sessionKey: submitted.task.sessionKey };
  const backgroundEnv = await harness.output.resolveExecEnv(
    { toolName: "exec", sessionKey: submitted.task.sessionKey }, backgroundContext,
  );
  assert.notEqual(foregroundEnv.MUAD_PROGRESS_EVENTS_FILE, backgroundEnv.MUAD_PROGRESS_EVENTS_FILE);
  return { foregroundContext, foregroundEnv, backgroundEnv };
}

function emitProgress(executions) {
  assertRouteFlagsRejected(executions.backgroundEnv);
  runProgress(executions.foregroundEnv, "stage", "query", "正在查询", "forged-foreground");
  runProgress(executions.backgroundEnv, "stage", "export", "正在导出", "forged-background");
  runProgress(executions.foregroundEnv, "done", "query", "已获取前台摘要", "forged-foreground");
  runProgress(executions.backgroundEnv, "done", "export", "已生成 128 条结果摘要", "forged-background");
}

function assertRouteFlagsRejected(env) {
  const result = spawnSync(process.execPath, [
    cliPath, "stage", "--stage", "route", "--text", "forged route",
    "--channel", "mattermost", "--peerId", "foreground-owner",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "muad-progress: invalid_arguments\n");
}

function runProgress(env, command, stage, text, skill) {
  const result = spawnSync(process.execPath, [
    cliPath, command, "--stage", stage, "--text", text, "--skill", skill,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}

function assertCapabilityFiles(executions) {
  const contents = [executions.foregroundEnv, executions.backgroundEnv]
    .map((env) => readFileSync(env.MUAD_PROGRESS_EVENTS_FILE, "utf8"));
  for (const content of contents) {
    assert.equal(/foreground-owner|background-owner|mattermost|wecom|credential/iu.test(content), false);
  }
}

async function completeExecutions(harness, executions) {
  await waitFor(() => records(harness).filter((item) =>
    item.kind === "progress-end" && item.target === "background-owner").length === 2);
  writeFileSync(harness.restoreEnv.releaseFile, "release", { mode: 0o600 });
  await waitFor(() => records(harness).filter((item) => item.kind === "final").length === 1);
  await waitFor(() => harness.longManager.snapshot().pools[0].tasks.some((item) =>
    item.taskId === "task-e2e" && item.status === "succeeded"));
  await harness.foreground.agentEnd(
    { runId: executions.foregroundContext.runId }, executions.foregroundContext,
  );
  await waitFor(() => records(harness).filter((item) =>
    item.kind === "progress-end" && item.target === "foreground-owner").length === 2);
  return records(harness);
}

function assertProgressIsolation(allRecords) {
  const starts = allRecords.filter((item) => item.kind === "progress-start");
  const foreground = starts.filter((item) => item.target === "foreground-owner");
  const background = starts.filter((item) => item.target === "background-owner");
  assert.deepEqual(foreground.map((item) => item.channel), ["mattermost", "mattermost"]);
  assert.deepEqual(background.map((item) => item.channel), ["wecom", "wecom"]);
  assert.deepEqual(foreground.map((item) => item.message), [
    "进度 · foreground-skill\n⏳ query：正在查询",
    "进度 · foreground-skill\n✅ query：已获取前台摘要",
  ]);
  assert.deepEqual(background.map((item) => item.message), [
    "进度 · background-skill\n⏳ export：正在导出",
    "进度 · background-skill\n✅ export：已生成 128 条结果摘要",
  ]);
}

function assertFailureIsolation(allRecords) {
  const backgroundEnds = allRecords.filter((item) =>
    item.kind === "progress-end" && item.target === "background-owner");
  const foregroundEnds = allRecords.filter((item) =>
    item.kind === "progress-end" && item.target === "foreground-owner");
  assert.equal(backgroundEnds.every((item) => item.ok === true), true);
  assert.equal(foregroundEnds.every((item) => item.ok === false), true);
  assert.ok(Math.max(...backgroundEnds.map((item) => item.at)) < foregroundEnds[1].at);
}

function assertFinalDelivery(allRecords) {
  const finals = allRecords.filter((item) => item.kind === "final");
  const progress = allRecords.filter((item) => item.kind === "progress-start");
  assert.deepEqual(finals, [{
    kind: "final", channel: "wecom", target: "background-owner",
    message: finalText, at: finals[0].at,
  }]);
  assert.equal(progress.some((item) => item.message.includes(finalText)), false);
  assert.equal(allRecords.filter((item) => item.message === finalText).length, 1);
}

function assertDiagnostics(logs) {
  const diagnostics = logs.join("\n");
  assert.equal(/foreground-owner|background-owner|正在查询|128 条结果|credential/iu.test(diagnostics), false);
  assert.match(diagnostics, /\[muad-runtime-guard\]\[skill-progress\]/u);
}

function backgroundTask() {
  return {
    taskId: "task-e2e", agentId: "bob", peerId: "background-owner",
    skillName: "background-skill", skillRoot: "/skills/background-skill",
    objective: "generate report", originalPrompt: "generate report",
    replyChannel: "wecom", locale: "zh",
    sessionKey: "agent:bob:wecom:direct:background-owner",
  };
}

function records(harness) {
  const file = harness.restoreEnv.logFile;
  return readFileSync(file, "utf8").split(/\r?\n/u)
    .filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("timed out waiting for the OpenClaw E2E boundary");
}

function captureEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function cleanup({ root, restoreEnv, progressManager, foreground, longManager }) {
  foreground.close();
  longManager.close();
  progressManager.close();
  for (const [key, value] of Object.entries(restoreEnv.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { notifyUser } from "../../shared/notify-user.mjs";
import { LongTaskManager } from "../src/long-task-manager.mjs";
import { createSkillOutputHooks } from "../src/skill-output-hooks.mjs";
import { SkillProgressManager } from "../src/skill-progress-manager.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliRoot = path.join(repoRoot, "tools", "muad-progress");
const cliPath = path.join(cliRoot, "dist", "cli.js");

test("S-02B long task progress uses its trusted task route through the real CLI and bridge", async (t) => {
  const build = spawnSync("npm", ["run", "build"], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-background-e2e-"));
  const sent = [];
  const runs = [];
  const progressManager = new SkillProgressManager({
    rootDir: path.join(root, "events"),
    notify: (input) => notifyUser({ ...input, spawn: fakeSpawn(sent) }),
  });
  const manager = new LongTaskManager({
    limit: 1,
    stateFile: path.join(root, "long-task", "state.jsonl"),
    progressManager,
    runTask: (task) => new Promise((resolve, reject) => runs.push({ task, resolve, reject })),
  });
  const hooks = createSkillOutputHooks({
    manager,
    progressManager,
    resolveWorkspace: () => path.join(root, "workspace"),
  });
  t.after(() => {
    manager.close();
    progressManager.close();
    rmSync(root, { recursive: true, force: true });
  });

  const submitted = manager.submit(taskInput());
  const queued = manager.submit({ ...taskInput(), taskId: "task-background-queued", objective: "queued" });
  const queuedEnv = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: queued.task.sessionKey },
    { agentId: "alice", sessionKey: queued.task.sessionKey },
  );
  assert.equal(queued.task.status, "queued");
  assert.equal(queuedEnv.MUAD_PROGRESS_EVENTS_FILE, undefined);
  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: submitted.task.sessionKey },
    { agentId: "alice", sessionKey: submitted.task.sessionKey },
  );
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.equal(path.isAbsolute(env.MUAD_PROGRESS_EVENTS_FILE), true);
  const executionDir = path.dirname(env.MUAD_PROGRESS_EVENTS_FILE);

  const cli = spawnSync(process.execPath, [
    cliPath, "done", "--stage", "query", "--text", "已获取 128 条有效记录", "--skill", "forged",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "");
  assert.equal(existsSync(executionDir), true);

  runs[0].resolve();
  await waitFor(() => sent.length === 1 && !existsSync(executionDir));
  assert.equal(manager.snapshot().pools[0].tasks.some((task) =>
    task.taskId === submitted.task.taskId && task.status === "succeeded"), true);
  const terminalEnv = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: submitted.task.sessionKey },
    { agentId: "alice", sessionKey: submitted.task.sessionKey },
  );
  assert.equal(terminalEnv.MUAD_PROGRESS_EVENTS_FILE, undefined);
  assert.deepEqual(sent[0].args.slice(0, 6), [
    "message", "send", "--channel", "mattermost", "--target", "owner-1",
  ]);
  assert.equal(sent[0].args.includes("other-user"), false);
  assert.equal(sent[0].args[sent[0].args.indexOf("--message") + 1],
    "进度 · xdr-query\n✅ query：已获取 128 条有效记录");

  const secondEnv = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: queued.task.sessionKey },
    { agentId: "alice", sessionKey: queued.task.sessionKey },
  );
  runs[1].resolve();
  await waitFor(() => !existsSync(path.dirname(secondEnv.MUAD_PROGRESS_EVENTS_FILE)));
});

function taskInput() {
  return {
    taskId: "task-background-e2e",
    agentId: "alice",
    peerId: "owner-1",
    skillName: "xdr-query",
    skillRoot: "/skills/xdr-query",
    objective: "query",
    originalPrompt: "query",
    replyChannel: "mattermost",
    sessionKey: "agent:alice:mattermost:direct:owner-1",
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("timed out waiting for progress final drain");
}

function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
}

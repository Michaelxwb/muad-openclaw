import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { notifyUser } from "../../shared/notify-user.mjs";
import { createSkillAuditHooks } from "../src/skill-audit-hooks.mjs";
import { createSkillProgressHooks } from "../src/skill-progress-hooks.mjs";
import { SkillProgressManager } from "../src/skill-progress-manager.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliRoot = path.join(repoRoot, "tools", "muad-progress");
const cliPath = path.join(cliRoot, "dist", "cli.js");

test("SkillProgressHooks S-02A runs CLI to real JSONL and trusted notify argv", async (t) => {
  const build = spawnSync("npm", ["run", "build"], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-foreground-e2e-"));
  const sent = [];
  const manager = new SkillProgressManager({
    rootDir: path.join(root, "events"),
    notify: (input) => notifyUser({ ...input, spawn: fakeSpawn(sent) }),
  });
  const progress = createSkillProgressHooks({ manager, autoStart: false });
  t.after(() => {
    progress.close();
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });
  const audit = createSkillAuditHooks({
    config: {
      locale: "zh",
      skillAuditGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: "/skills/xdr-query", source: "system" },
      ],
    },
    client: null,
    onSkillActivated: progress.activate,
  });
  const ctx = {
    runId: "run-e2e", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:user-1",
  };

  await audit.beforeDispatch({ runId: "run-e2e", prompt: "/skill:xdr-query now" }, ctx);
  const env = await progress.resolveExecEnv({
    toolName: "exec", runId: "run-e2e",
    env: { MUAD_PROGRESS_EVENTS_FILE: "/tmp/forged", MUAD_SKILL_NAME: "forged" },
  }, ctx);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.equal(env.MUAD_PROGRESS_EVENTS_FILE.includes("forged"), false);
  assert.equal(await progress.resolveExecEnv(
    { toolName: "exec", runId: "run-e2e" },
    { ...ctx, agentId: "bob" },
  ), undefined);

  const cli = spawnSync(process.execPath, [
    cliPath, "stage", "--stage", "query", "--text", "正在查询",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "");
  const stateDir = path.dirname(env.MUAD_PROGRESS_EVENTS_FILE);
  assert.equal(existsSync(stateDir), true);

  await progress.agentEnd({ runId: "run-e2e" }, ctx);
  assert.equal(existsSync(stateDir), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, "openclaw");
  assert.deepEqual(sent[0].args.slice(0, 6), [
    "message", "send", "--channel", "mattermost", "--target", "user-1",
  ]);
  assert.equal(sent[0].args[sent[0].args.indexOf("--message") + 1],
    "进度 · xdr-query\n⏳ query：正在查询");
});

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

test("SkillProgressHooks S-02C routes the turn sender when activation lacks senderId", async (t) => {
  // 复刻自然语言触发的生产链路：dispatch 不含显式 skill 指令（无 pending），
  // 注册来自 read-SKILL.md 路径（事件无 senderId），真实发送者只在
  // before_agent_run 事件里（多用户网关下 session key 末段是 agent id）。
  const build = spawnSync("npm", ["run", "build"], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-foreground-e2e-3-"));
  const sent = [];
  const manager = new SkillProgressManager({
    rootDir: path.join(root, "events"),
    notify: (input) => notifyUser({ ...input, spawn: fakeSpawn(sent) }),
  });
  const progress = createSkillProgressHooks({ manager, autoStart: false });
  t.after(() => {
    progress.close();
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = {
    agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:alice",
  };
  const senderId = "hqskp3r8ktdgjy9ra3fm5htdwc";

  // 自然语言 turn：before_agent_run 携带 senderId，无 pending 可提升
  await progress.beforeAgentRun({ runId: "run-3", senderId }, ctx);
  // 模型 read SKILL.md → 注册（activationInput 无 senderId）
  progress.activate({ ...ctx, runId: "run-3", skillName: "xdr-query" });
  const env = await progress.resolveExecEnv({ toolName: "exec", host: "gateway" }, ctx);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");

  const cli = spawnSync(process.execPath, [
    cliPath, "stage", "--stage", "query", "--text", "正在查询",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(cli.status, 0, cli.stderr);

  await progress.agentEnd({ runId: "run-3" }, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args.slice(0, 6), [
    "message", "send", "--channel", "mattermost", "--target", senderId,
  ]);
});

test("SkillProgressHooks S-02B promotes a run-less dispatch and routes the trusted sender", async (t) => {
  const build = spawnSync("npm", ["run", "build"], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-foreground-e2e-2-"));
  const sent = [];
  const manager = new SkillProgressManager({
    rootDir: path.join(root, "events"),
    notify: (input) => notifyUser({ ...input, spawn: fakeSpawn(sent) }),
  });
  const progress = createSkillProgressHooks({ manager, autoStart: false });
  t.after(() => {
    progress.close();
    manager.close();
    rmSync(root, { recursive: true, force: true });
  });
  const audit = createSkillAuditHooks({
    config: {
      locale: "zh",
      skillAuditGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: "/skills/xdr-query", source: "system" },
      ],
    },
    client: null,
    onSkillActivated: progress.activate,
  });
  // 复现生产形态：多用户网关下 session key 的 direct 段是 agent id，
  // 真实 Mattermost 用户 id 只出现在 dispatch/agent_run 事件的 senderId 里。
  const ctx = {
    agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:alice",
  };
  const senderId = "hqskp3r8ktdgjy9ra3fm5htdwc";

  // dispatch 先于 run 创建（无 runId）：激活进入 pending
  await audit.beforeDispatch({ prompt: "/skill:xdr-query now", senderId }, ctx);
  // 模型未重读 SKILL.md，直接 exec：before_agent_run 补注册并提供 runId
  await progress.beforeAgentRun({ runId: "run-2", senderId }, ctx);
  const env = await progress.resolveExecEnv({ toolName: "exec", host: "gateway" }, ctx);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.match(env.MUAD_PROGRESS_EVENTS_FILE, /events\.jsonl$/u);

  const cli = spawnSync(process.execPath, [
    cliPath, "stage", "--stage", "query", "--text", "正在查询",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(cli.status, 0, cli.stderr);

  await progress.agentEnd({ runId: "run-2" }, ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args.slice(0, 6), [
    "message", "send", "--channel", "mattermost", "--target", senderId,
  ]);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLongTaskHooks } from "../src/long-task-hooks.mjs";

test("long task hooks submit explicit Skill commands before dispatch", async () => {
  const { hooks, submissions } = setupHooks();

  const result = await hooks.beforeDispatch({
    prompt: "/skill:xdr-query check alerts",
    sessionKey: "agent:alice:openclaw-weixin:direct:wx-1",
    channelId: "openclaw-weixin",
    senderId: "openclaw-weixin:wx-1",
  }, context());

  assert.equal(result.handled, true);
  assert.equal(result.reason, "muad-long-task-submitted");
  assert.match(result.text, /任务已提交：xdr-query/u);
  assert.match(result.text, /任务ID：task-1/u);
  assert.match(result.text, /当前排队：0 ｜ 执行中：1/u);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].objective, "check alerts");
  assert.equal(submissions[0].peerId, "wx-1");
  assert.equal(submissions[0].replyChannel, "openclaw-weixin");
});

test("long task hooks rewrite natural Skill reads and enqueue the task at read time", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "Please use xdr-query for alert triage",
    channelId: "openclaw-weixin",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));

  const rewritten = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1", channel: "openclaw-weixin", channelId: "openclaw-weixin" }));

  // The read is rewritten to a per-task submit stub named after the pre-generated
  // task ID, and the task is enqueued right here (read-to-enqueue).
  assert.match(rewritten.params.path, /_longtask_submit_[0-9a-f-]+\.md$/u);
  assert.ok(existsSync(rewritten.params.path), "per-task submit stub exists");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].objective, "Please use xdr-query for alert triage");
  assert.equal(submissions[0].originalPrompt, "Please use xdr-query for alert triage");
  assert.equal(submissions[0].replyChannel, "openclaw-weixin");
  assert.equal(submissions[0].peerId, "wx-1");
  // The stub the model reads carries the same task ID console recorded, so any IM —
  // even one that bypasses reply_payload_sending — delivers the identical ID.
  assert.ok(readFileSync(rewritten.params.path, "utf8").includes(`任务ID：${submissions[0].taskId}`));

  // Non-read tools pass through untouched.
  assert.equal(
    await hooks.beforeToolCall({ runId: "run-1", toolName: "exec", params: {} }, context({ runId: "run-1" })),
    undefined,
  );

  // Finalize passes through — the model already copied the full confirmation from
  // the stub on its first read; no revise replay is needed.
  const finalized = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "好的，正在后台为你执行 xdr-query，完成后结果会推送给你。",
    channel: "openclaw-weixin",
    sessionKey: "agent:alice:openclaw-weixin:direct:wx-1",
    runId: "run-1",
  }, context({ runId: "run-1", senderId: "wx-1" }));
  assert.equal(finalized, undefined);
  assert.equal(submissions.length, 1);
});

test("long task hooks submit once on first read, reuse the same stub on re-reads, never double-submit", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "use xdr-query",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));

  const firstRead = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));
  const stubPath = firstRead.params.path;
  assert.match(stubPath, /_longtask_submit_[0-9a-f-]+\.md$/u);
  assert.ok(existsSync(stubPath), "per-task submit stub exists");
  assert.equal(submissions.length, 1);

  // A re-read (e.g. a revision re-run) is redirected to the same stub — no second submit.
  const reRead = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));
  assert.deepEqual(reRead.params, { path: stubPath });
  assert.equal(submissions.length, 1);

  // Finalize passes through and never re-submits.
  const finalized = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "好的，正在后台执行。",
    channel: "wecom",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    runId: "run-1",
  }, context({ runId: "run-1", senderId: "wx-1" }));
  assert.equal(finalized, undefined);
  assert.equal(submissions.length, 1);

  await hooks.agentEnd({ runId: "run-1" }, context({ runId: "run-1" }));
  assert.equal(existsSync(stubPath), false, "per-task submit stub removed at agent_end");
});

test("per-task submit stub carries the task ID and queue counts verbatim and is cleaned up at agent_end", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "帮我导一下客户周报",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));

  const rewritten = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));

  const stubText = readFileSync(rewritten.params.path, "utf8");
  // The stub is the deterministic lever for direct-delivery IMs (Mattermost): the
  // model copies it verbatim, so the delivered confirmation carries the task ID and
  // the same queue counts console recorded — identical on every IM.
  assert.match(rewritten.params.path, /_longtask_submit_[0-9a-f-]+\.md$/u);
  assert.match(stubText, /任务已提交：xdr-query/u);
  assert.ok(stubText.includes(`任务ID：${submissions[0].taskId}`));
  assert.match(stubText, /当前排队：0 ｜ 执行中：1/u);

  await hooks.agentEnd({ runId: "run-1" }, context({ runId: "run-1" }));
  assert.equal(existsSync(rewritten.params.path), false, "per-task submit stub removed at agent_end");
});

test("long task hooks pass through runs that never read the Skill and skip task sessions", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "use xdr-query",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));

  // A run that never reads the long-task SKILL.md has no recorded submission:
  // the reply passes through untouched and nothing is enqueued.
  const plain = await hooks.beforeAgentFinalize({
    lastAssistantMessage: "I will do it now.",
    channel: "wecom",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    runId: "run-1",
  }, context({ runId: "run-1", senderId: "wx-1" }));
  assert.equal(plain, undefined);
  assert.equal(submissions.length, 0);

  // Task sessions are skipped at every interception point.
  const skippedDispatch = await hooks.beforeDispatch(
    { prompt: "/skill:xdr-query check alerts" },
    context({ sessionKey: "agent:alice:longtask:task-1" }),
  );
  assert.equal(skippedDispatch, undefined);

  const skippedRead = await hooks.beforeToolCall(
    { runId: "task-run", toolName: "read", params: { path: join(skillDir, "SKILL.md") } },
    context({ runId: "task-run", sessionKey: "agent:alice:longtask:task-1" }),
  );
  assert.equal(skippedRead, undefined);

  const skippedReply = await hooks.beforeAgentFinalize(
    { lastAssistantMessage: "done", channel: "wecom", sessionKey: "agent:alice:longtask:task-1" },
    context({ sessionKey: "agent:alice:longtask:task-1" }),
  );
  assert.equal(skippedReply, undefined);
  assert.equal(submissions.length, 0);
});

test("long task hooks resolve mattermost reply channel and user-prefixed deliver target", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  const sessionKey = "agent:alice:mattermost:direct:alice";
  const channelId = "hqskp3r8ktdgjy9ra3fm5htdwc";

  await hooks.beforeAgentRun({
    runId: "mm-1",
    prompt: "帮我导一下客户周报",
    channelId,
    senderId: `mattermost:${channelId}`,
  }, context({ runId: "mm-1", sessionKey }));

  await hooks.beforeToolCall({
    runId: "mm-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "mm-1", sessionKey }));

  // read-to-enqueue: the submission carries the mattermost reply channel and the
  // user-prefixed deliver target resolved from the session.
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].replyChannel, "mattermost");
  assert.equal(submissions[0].peerId, `user:${channelId}`);
});

test("reply_payload_sending rewrites the delivered confirmation with the pre-generated task ID", async () => {
  const { hooks, skillDir, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "帮我导一下客户周报",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));
  await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));

  // agent_end fires before reply_payload_sending in the real delivery path; it
  // must not evict the submitted record or the delivery-time rewrite misses.
  await hooks.agentEnd({ runId: "run-1" }, context({ runId: "run-1" }));

  // Delivery-time rewrite: whatever the model drafted, the sent text is the
  // deterministic confirmation carrying the same task ID console recorded.
  const rewritten = await hooks.replyPayloadSending({
    runId: "run-1",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    payload: { text: "好的，正在后台执行。" },
  }, context({ runId: "run-1" }));

  assert.ok(rewritten);
  assert.match(rewritten.payload.text, /任务已提交：xdr-query/u);
  assert.ok(rewritten.payload.text.includes(`任务ID：${submissions[0].taskId}`));
  assert.match(rewritten.payload.text, /当前排队：0 ｜ 执行中：1/u);

  // One-shot: the record is consumed, so a second delivery is untouched.
  const again = await hooks.replyPayloadSending({
    runId: "run-1",
    payload: { text: "anything" },
  }, context({ runId: "run-1" }));
  assert.equal(again, undefined);
});

test("reply_payload_sending ignores deliveries without a recorded submission", async () => {
  const { hooks } = setupHooks();
  const result = await hooks.replyPayloadSending({
    runId: "unknown-run",
    payload: { text: "hi" },
  }, context({ runId: "unknown-run" }));
  assert.equal(result, undefined);
});

test("submit stubs are written inside the agent workspace at .openclaw/tmp", async () => {
  const { hooks, skillDir, workspace, submissions } = setupHooks();
  await hooks.beforeAgentRun({
    runId: "run-1",
    prompt: "帮我导一下客户周报",
    senderId: "wx-1",
  }, context({ runId: "run-1" }));
  const rewritten = await hooks.beforeToolCall({
    runId: "run-1",
    toolName: "read",
    params: { path: join(skillDir, "SKILL.md") },
  }, context({ runId: "run-1" }));

  // 桩落 <workspace>/.openclaw/tmp/：位于 agent workspace 内（OpenClaw 原生 read
  // 工具的 sandbox roots=[workspace, ...skillDirs]），模型读改写后的桩不会被原生
  // 沙箱拦截。skill-outputs 现在也在 workspace 内，但桩用独立 scratch 目录，
  // 不与 skill 输出文件混放。
  assert.equal(dirname(rewritten.params.path), join(workspace, ".openclaw", "tmp"));
  assert.match(rewritten.params.path, /_longtask_submit_[0-9a-f-]+\.md$/u);
  assert.ok(existsSync(rewritten.params.path), "submit stub exists under .openclaw/tmp");
  const rel = rewritten.params.path.replace(new RegExp(`^${workspace}/`, "u"), "");
  assert.ok(!rel.startsWith("../"), "stub path must not escape the native sandbox root");
  assert.equal(submissions.length, 1);
});

test("confirmation text follows the guard locale (default zh, en when configured)", async () => {
  const zh = setupHooks();
  await zh.hooks.beforeAgentRun({
    runId: "zh-1", prompt: "use xdr-query", senderId: "wx-1",
  }, context({ runId: "zh-1" }));
  const zhRead = await zh.hooks.beforeToolCall({
    runId: "zh-1", toolName: "read", params: { path: join(zh.skillDir, "SKILL.md") },
  }, context({ runId: "zh-1" }));
  const zhStub = readFileSync(zhRead.params.path, "utf8");
  assert.match(zhStub, /任务已提交：xdr-query/u);
  assert.ok(zhStub.includes(`任务ID：${zh.submissions[0].taskId}`));

  const en = setupHooks({ config: { locale: "en" } });
  await en.hooks.beforeAgentRun({
    runId: "en-1", prompt: "use xdr-query", senderId: "wx-1",
  }, context({ runId: "en-1" }));
  const enRead = await en.hooks.beforeToolCall({
    runId: "en-1", toolName: "read", params: { path: join(en.skillDir, "SKILL.md") },
  }, context({ runId: "en-1" }));
  const enStub = readFileSync(enRead.params.path, "utf8");
  assert.match(enStub, /Task submitted: xdr-query/u);
  assert.ok(enStub.includes(`Task ID: ${en.submissions[0].taskId}`));
  assert.match(enStub, /Queued: 0 \| Running: 1/u);
});

test("before_dispatch confirmation follows the guard locale", async () => {
  const en = setupHooks({ config: { locale: "en" } });
  const result = await en.hooks.beforeDispatch({
    prompt: "/skill:xdr-query check alerts",
    sessionKey: "agent:alice:openclaw-weixin:direct:wx-1",
    channelId: "openclaw-weixin",
    senderId: "openclaw-weixin:wx-1",
  }, context());
  assert.equal(result.handled, true);
  assert.match(result.text, /Task submitted: xdr-query/u);
  assert.match(result.text, /Queued: 0 \| Running: 1/u);
});

test("reply_payload_sending rewrite follows the guard locale", async () => {
  const en = setupHooks({ config: { locale: "en" } });
  await en.hooks.beforeAgentRun({
    runId: "en-1", prompt: "use xdr-query", senderId: "wx-1",
  }, context({ runId: "en-1" }));
  await en.hooks.beforeToolCall({
    runId: "en-1", toolName: "read", params: { path: join(en.skillDir, "SKILL.md") },
  }, context({ runId: "en-1" }));
  await en.hooks.agentEnd({ runId: "en-1" }, context({ runId: "en-1" }));

  const rewritten = await en.hooks.replyPayloadSending({
    runId: "en-1",
    sessionKey: "agent:alice:wecom:direct:wx-1",
    payload: { text: "ok" },
  }, context({ runId: "en-1" }));
  assert.ok(rewritten);
  assert.match(rewritten.payload.text, /Task submitted: xdr-query/u);
  assert.ok(rewritten.payload.text.includes(`Task ID: ${en.submissions[0].taskId}`));
  assert.match(rewritten.payload.text, /Queued: 0 \| Running: 1/u);
});

test("long task hooks sweep stale submit stubs at plugin startup but keep fresh ones", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-sweep-"));
  const workspace = join(root, "workspace-alice");
  const tmpDir = join(workspace, ".openclaw", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const staleStub = join(tmpDir, "_longtask_submit_stale-task.md");
  const freshStub = join(tmpDir, "_longtask_submit_fresh-task.md");
  const otherFile = join(tmpDir, "notes.txt");
  writeFileSync(staleStub, "# stale");
  writeFileSync(freshStub, "# fresh");
  writeFileSync(otherFile, "notes");
  // 崩溃残留桩：mtime 超过 24h。
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(staleStub, old, old);

  setupHooks({ resolveWorkspace: () => workspace });

  assert.equal(existsSync(staleStub), false, "stale stub swept at startup");
  assert.equal(existsSync(freshStub), true, "fresh stub kept (running task)");
  assert.equal(existsSync(otherFile), true, "non-stub files untouched");
});

test("long task hooks sweep tolerates a missing tmp directory", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-sweep-missing-"));
  const workspace = join(root, "workspace-alice");
  assert.doesNotThrow(() => setupHooks({ resolveWorkspace: () => workspace }));
});

function setupHooks(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "muad-long-task-hook-"));
  const workspace = join(root, "workspace-alice");
  const skillDir = join(root, "xdr-query");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# XDR\n");
  writeFileSync(join(skillDir, "muad.skill.json"), JSON.stringify({ name: "xdr-query", longTask: true }));
  mkdirSync(workspace, { recursive: true });
  const submissions = [];
  const manager = {
    submit(input) {
      submissions.push(input);
      const taskId = input.taskId || `task-${submissions.length}`;
      return {
        task: {
          status: submissions.length === 1 ? "running" : "queued",
          taskId,
        },
        queuedAhead: Math.max(0, submissions.length - 1),
        queued: Math.max(0, submissions.length - 1),
        active: 1,
        limit: 2,
      };
    },
  };
  const { config: configOverrides = {}, ...hookOverrides } = overrides;
  const hooks = createLongTaskHooks({
    config: {
      longTaskSkillGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: skillDir },
      ],
      ...configOverrides,
    },
    manager,
    resolveWorkspace: () => workspace,
    ...hookOverrides,
  });
  return { hooks, skillDir, workspace, submissions };
}

function context(overrides = {}) {
  return {
    runId: "run-0",
    agentId: "alice",
    sessionKey: "agent:alice:wx-1",
    channel: "wecom",
    ...overrides,
  };
}

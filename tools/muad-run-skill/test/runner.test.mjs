import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSkill } from "../src/runner.mjs";
import { toToolUpdate } from "../src/progress-format.mjs";
import { deliverProgressToCurrentConversation } from "../src/delivery.mjs";

async function createTempSkill() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-runner-test-"));
  const skillDir = path.join(root, "example-long-task");
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  return { root, skillDir };
}

test("runs steps and emits automatic progress", async () => {
  const { skillDir } = await createTempSkill();
  await fs.writeFile(path.join(skillDir, "scripts", "auth.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const events = [];
  const result = await runSkill({
    manifest: {
      name: "example-long-task",
      runtime: "script",
      mode: "steps",
      skillDir,
      steps: [{ id: "auth", title: "鉴权", command: ["bash", "scripts/auth.sh"] }],
    },
    stateDir: os.tmpdir(),
    deliver: async (event) => events.push(event),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map((event) => `${event.stage}:${event.type}`),
    ["accepted:progress", "auth:progress", "auth:done", "done:done"],
  );
});

test("receives muad-progress events from entrypoint scripts", async () => {
  const { skillDir } = await createTempSkill();
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "muad-progress-bin-"));
  const fakeProgress = path.join(fakeBin, "muad-progress");
  await fs.writeFile(
    fakeProgress,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cmd=\"$1\"; shift",
      "stage=\"\"; text=\"\"",
      "while [[ $# -gt 0 ]]; do",
      "  case \"$1\" in",
      "    --stage) stage=\"$2\"; shift 2 ;;",
      "    --text) text=\"$2\"; shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      "if [[ \"$cmd\" == \"done\" && -z \"$stage\" ]]; then stage=\"done\"; fi",
      "printf '{\"type\":\"%s\",\"skill\":\"example-long-task\",\"stage\":\"%s\",\"text\":\"%s\"}\\n' \"$([[ \"$cmd\" == \"stage\" ]] && echo progress || echo \"$cmd\")\" \"$stage\" \"$text\" >> \"$MUAD_PROGRESS_EVENTS_FILE\"",
    ].join("\n"),
  );
  await fs.chmod(fakeProgress, 0o755);
  await fs.writeFile(
    path.join(skillDir, "scripts", "run.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "muad-progress stage --stage query --text 正在查询 >/dev/null",
      "muad-progress done --text 完成 >/dev/null",
    ].join("\n"),
  );
  const events = [];
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath ?? ""}`;
  const result = await runSkill({
    manifest: {
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      skillDir,
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "query", title: "查询" }],
    },
    stateDir: os.tmpdir(),
    deliver: async (event) => events.push(event),
  });
  process.env.PATH = oldPath;
  assert.equal(result.ok, true);
  assert(events.some((event) => event.stage === "query" && event.text === "正在查询"));
  assert(events.some((event) => event.stage === "done" && event.text === "完成"));
});

test("manual progress entrypoints do not emit automatic accepted and done events", async () => {
  const { skillDir } = await createTempSkill();
  await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const events = [];
  const result = await runSkill({
    manifest: {
      name: "example-long-task",
      runtime: "script",
      mode: "entrypoint",
      progress: { source: "manual" },
      skillDir,
      entrypoint: ["bash", "scripts/run.sh"],
      steps: [{ id: "query", title: "查询" }],
    },
    stateDir: os.tmpdir(),
    deliver: async (event) => events.push(event),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, []);
});

test("formats progress as OpenClaw AgentToolResult progress", () => {
  const update = toToolUpdate({
    type: "progress",
    skill: "example-long-task",
    stage: "query",
    text: "正在查询",
    ts: "2026-07-09T05:27:19Z",
  });

  assert.deepEqual(update.content, []);
  assert.equal(update.progress.visibility, "channel");
  assert.equal(update.progress.privacy, "public");
  assert.equal(update.progress.id, "example-long-task:query");
  assert.equal(update.progress.text, "example-long-task 「query」进行中: 正在查询");
  assert.equal(update.details.muadProgress, true);
});

test("delivers progress through OpenClaw outbound SDK", async () => {
  const sent = [];
  const delivered = await deliverProgressToCurrentConversation({
    toolContext: {
      runtimeConfig: {},
      sessionKey: "agent:main:openclaw-weixin:direct:user",
      messageChannel: "openclaw-weixin",
      agentAccountId: "acct-1",
    },
    event: {
      type: "progress",
      skill: "example-long-task",
      stage: "auth",
      text: "正在检查登录态",
    },
    buildSession: (params) => ({ key: params.sessionKey, policyKey: params.policySessionKey }),
    sendBatch: async (params) => {
      sent.push(params);
      return { status: "sent", results: [{}], receipt: {} };
    },
  });

  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "openclaw-weixin");
  assert.equal(sent[0].to, "user");
  assert.equal(sent[0].accountId, "acct-1");
  assert.equal(sent[0].bestEffort, true);
  assert.equal(sent[0].skipQueue, true);
  assert.deepEqual(sent[0].payloads, [
    { text: "example-long-task 「auth」进行中: 正在检查登录态" },
  ]);
  assert.deepEqual(sent[0].session, {
    key: "agent:main:openclaw-weixin:direct:user",
    policyKey: "agent:main:openclaw-weixin:direct:user",
  });
});

test("falls back when current conversation cannot be resolved", async () => {
  let called = false;
  const delivered = await deliverProgressToCurrentConversation({
    toolContext: { runtimeConfig: {} },
    event: {
      type: "progress",
      skill: "example-long-task",
      stage: "auth",
      text: "正在检查登录态",
    },
    buildSession: () => ({}),
    sendBatch: async () => {
      called = true;
      return { status: "sent", results: [{}], receipt: {} };
    },
  });

  assert.equal(delivered, false);
  assert.equal(called, false);
});

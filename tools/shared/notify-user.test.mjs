import assert from "node:assert/strict";
import test from "node:test";

import { notifyUser } from "./notify-user.mjs";

function fakeSpawn(overrides = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const handlers = { stdout: [], stderr: [], error: null, exit: null };
    const child = {
      stdout: { on: (ev, fn) => { handlers.stdout.push({ ev, fn }); } },
      stderr: { on: (ev, fn) => { handlers.stderr.push({ ev, fn }); } },
      on: (ev, fn) => {
        if (ev === "error") handlers.error = fn;
        if (ev === "exit") handlers.exit = fn;
      },
      kill: () => {},
    };
    // 默认成功：下一轮微任务后触发 exit 0（emitError 时走 error 分支，不 exit）
    if (overrides.autoExit !== false && !overrides.emitError) {
      queueMicrotask(() => handlers.exit?.(overrides.exitCode ?? 0));
    }
    if (overrides.emitStdout) {
      queueMicrotask(() => handlers.stdout.forEach(({ fn }) => fn(overrides.emitStdout)));
    }
    if (overrides.emitStderr) {
      queueMicrotask(() => handlers.stderr.forEach(({ fn }) => fn(overrides.emitStderr)));
    }
    if (overrides.emitError) {
      queueMicrotask(() => handlers.error?.(overrides.emitError));
    }
    return child;
  };
  return { spawn, calls };
}

test("notifyUser spawns openclaw message send with the shared contract", async () => {
  const { spawn, calls } = fakeSpawn();
  const result = await notifyUser({
    channel: "mattermost",
    peerId: "hqskp3r8ktdgjy9ra3fm5htdwc",
    text: "任务失败：xxx",
    spawn,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "openclaw");
  assert.deepEqual(calls[0].args, [
    "message", "send",
    "--channel", "mattermost",
    "--target", "hqskp3r8ktdgjy9ra3fm5htdwc",
    "--message", "任务失败：xxx",
    "--json",
  ]);
});

test("B-04 keeps multilingual text intact in WeCom and Mattermost argv", async () => {
  const samples = [
    { channel: "wecom", peerId: "wecom-test-user", text: "进度 😀\n**已完成** `128 条`" },
    { channel: "mattermost", peerId: "mattermost-test-user", text: "Progress 😀\n**Done** `128 rows`" },
  ];

  for (const sample of samples) {
    const { spawn, calls } = fakeSpawn();
    const result = await notifyUser({ ...sample, spawn });
    const args = calls[0]?.args ?? [];
    const messageIndex = args.indexOf("--message");

    assert.equal(result.ok, true);
    assert.deepEqual(args.slice(0, 6), [
      "message", "send", "--channel", sample.channel, "--target", sample.peerId,
    ]);
    assert.equal(args[messageIndex + 1], sample.text);
    assert.equal(args.at(-1), "--json");
    assert.equal(sample.text.startsWith("{"), false);
  }
});

test("notifyUser rejects empty channel/peerId/text", async () => {
  const { spawn } = fakeSpawn();
  for (const bad of [
    { channel: "", peerId: "p", text: "t" },
    { channel: "mattermost", peerId: "", text: "t" },
    { channel: "mattermost", peerId: "p", text: "" },
  ]) {
    const result = await notifyUser({ ...bad, spawn });
    assert.equal(result.ok, false);
  }
});

test("notifyUser reports spawn failure", async () => {
  const { spawn } = fakeSpawn({ emitError: new Error("ENOENT") });
  const result = await notifyUser({ channel: "mattermost", peerId: "p", text: "t", spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn openclaw failed/);
});

test("notifyUser reports non-zero exit without leaking full stderr", async () => {
  const { spawn } = fakeSpawn({ exitCode: 1, emitStderr: "sensitive internal detail" });
  const result = await notifyUser({ channel: "mattermost", peerId: "p", text: "t", spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /message send failed/);
});

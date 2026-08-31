import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installSkillProgressManager } from "../src/index.mjs";
import { SkillProgressManager } from "../src/skill-progress-manager.mjs";
import { renderProgressText } from "../src/skill-progress-policy.mjs";

test("SkillProgressManager S-03 sends stage then done in order with trusted context", async () => {
  const bridge = createBridge();
  const delivery = controlledNotify();
  const manager = createManager({ bridge, notify: delivery.notify });
  const registration = manager.registerBackground(backgroundInput());

  assert.equal(manager.reportProgress(registration.executionKey, event({
    skill: "forged-skill", text: "正在查询",
  })).accepted, true);
  assert.equal(manager.reportProgress(registration.executionKey, event({
    type: "done", skill: "forged-skill", text: "已获取 128 条",
  })).accepted, true);
  await waitFor(() => delivery.calls.length === 1);
  assert.equal(delivery.calls[0].text, "进度 · report-skill\n⏳ query：正在查询");
  delivery.resolveNext({ ok: true });
  await waitFor(() => delivery.calls.length === 2);
  assert.equal(delivery.calls[1].text, "进度 · report-skill\n✅ query：已获取 128 条");
  delivery.resolveNext({ ok: true });

  await manager.finish(registration.executionKey);
  assert.deepEqual(bridge.finished, [registration.executionKey]);
  manager.close();
});

test("SkillProgressManager B-02 delivers identical valid events twice", async () => {
  const calls = [];
  const manager = createManager({ notify: async (input) => {
    calls.push(input);
    return { ok: true };
  } });
  const registration = manager.registerBackground(backgroundInput());
  const duplicate = event({ text: "相同消息" });

  assert.equal(manager.reportProgress(registration.executionKey, duplicate).accepted, true);
  assert.equal(manager.reportProgress(registration.executionKey, duplicate).accepted, true);
  await manager.finish(registration.executionKey);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, calls[1].text);
  manager.close();
});

test("SkillProgressManager E-01 rejects forged routes and sensitive content without leaks", () => {
  const calls = [];
  const logs = [];
  const manager = createManager({
    notify: async (input) => { calls.push(input); return { ok: true }; },
    log: (message) => logs.push(message),
  });
  const registration = manager.registerBackground(backgroundInput());
  const sensitiveSamples = [
    "token=must-not-leak",
    "Cookie: session=must-not-leak",
    "Authorization: Bearer must-not-leak",
    "password=must-not-leak",
    "访问 http://127.0.0.1:8080/private",
    "SELECT name FROM users",
    "at service.mjs:42:13",
  ];

  const forged = manager.reportProgress(registration.executionKey, event({ target: "other-user" }));
  const sensitive = sensitiveSamples.map((text) =>
    manager.reportProgress(registration.executionKey, event({ text })));

  assert.deepEqual(forged, { accepted: false, reason: "schema_invalid" });
  assert.equal(sensitive.every((result) =>
    result.accepted === false && result.reason === "sensitive_content"), true);
  assert.equal(calls.length, 0);
  assert.equal(logs.every((line) => line.startsWith("[muad-runtime-guard][skill-progress]")), true);
  assert.equal(logs.some((line) =>
    sensitiveSamples.some((secret) => line.includes(secret)) || line.includes("other-user")), false);
  manager.close();
});

test("SkillProgressManager E-03 isolates timeout and rejection between executions", async () => {
  const calls = [];
  const manager = createManager({
    notifyTimeoutMs: 20,
    finishTimeoutMs: 80,
    notify: ({ peerId }) => {
      calls.push(peerId);
      if (peerId === "slow-user") return new Promise(() => {});
      if (peerId === "reject-user") return Promise.reject(new Error("private failure"));
      return Promise.resolve({ ok: true });
    },
  });
  const slow = manager.registerBackground(backgroundInput({ taskId: "slow", peerId: "slow-user" }));
  const fast = manager.registerBackground(backgroundInput({ taskId: "fast", peerId: "fast-user" }));
  const reject = manager.registerBackground(backgroundInput({ taskId: "reject", peerId: "reject-user" }));

  manager.reportProgress(slow.executionKey, event());
  manager.reportProgress(fast.executionKey, event());
  manager.reportProgress(reject.executionKey, event());
  manager.reportProgress(reject.executionKey, event({ text: "after rejection" }));
  await waitFor(() => calls.includes("fast-user"));
  assert.equal(calls.includes("slow-user"), true);
  assert.equal(calls.includes("reject-user"), true);
  await Promise.all([manager.finish(slow.executionKey), manager.finish(fast.executionKey), manager.finish(reject.executionKey)]);
  assert.equal(calls.filter((peerId) => peerId === "reject-user").length, 2);
  manager.close();
});

test("SkillProgressManager uses a hard pending queue bound, not cumulative rate limiting", async () => {
  const delivery = controlledNotify();
  const manager = createManager({ notify: delivery.notify, maxPendingPerExecution: 1 });
  const registration = manager.registerBackground(backgroundInput());

  assert.equal(manager.reportProgress(registration.executionKey, event({ text: "first" })).accepted, true);
  assert.deepEqual(manager.reportProgress(registration.executionKey, event({ text: "second" })), {
    accepted: false, reason: "queue_capacity",
  });
  await waitFor(() => delivery.calls.length === 1);
  delivery.resolveNext({ ok: true });
  await waitFor(() => manager.reportProgress(registration.executionKey, event({ text: "third" })).accepted);
  await waitFor(() => delivery.calls.length === 2);
  delivery.resolveNext({ ok: true });
  await manager.finish(registration.executionKey);
  manager.close();
});

test("SkillProgressManager foreground route is direct, identity-bound, and env-scoped", () => {
  const manager = createManager();
  const input = {
    runId: "run-1", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:user-1",
    skillName: "report-skill", locale: "en",
  };
  const registration = manager.registerForeground(input);

  assert.equal(registration.registered, true);
  assert.deepEqual(manager.progressEnvForExec(input), registration.env);
  assert.deepEqual(manager.progressEnvForExec({ ...input, runId: "other" }), {});
  assert.deepEqual(manager.registerForeground({
    ...input, sessionKey: "agent:alice:mattermost:channel:group-1",
  }), { registered: false, reason: "route_invalid" });
  assert.deepEqual(manager.registerForeground({
    ...input, sessionKey: "agent:bob:mattermost:direct:user-1",
  }), { registered: false, reason: "identity_mismatch" });
  manager.close();
});

test("SkillProgressManager foreground route prefers the trusted senderId over the session key segment", async () => {
  const calls = [];
  const manager = createManager({
    notify: async (input) => { calls.push(input); return { ok: true }; },
  });
  // 多用户网关下的真实形态：session key 的 direct 段是 agent id 而非 IM 用户 id。
  const registration = manager.registerForeground({
    runId: "run-1", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:alice",
    senderId: "hqskp3r8ktdgjy9ra3fm5htdwc",
    skillName: "report-skill", locale: "zh",
  });

  manager.reportProgress(registration.executionKey, event());
  await manager.finish(registration.executionKey);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "mattermost");
  assert.equal(calls[0].peerId, "hqskp3r8ktdgjy9ra3fm5htdwc");
  manager.close();
});

test("SkillProgressManager applies a trusted exec-time sender to an existing route", async () => {
  const calls = [];
  const manager = createManager({
    notify: async (input) => { calls.push(input); return { ok: true }; },
  });
  const registration = manager.registerForeground({
    runId: "run-1", agentId: "alice",
    sessionKey: "agent:alice:mattermost:direct:alice",
    skillName: "report-skill", locale: "zh",
  });

  assert.equal(manager.applyTrustedSender(registration.executionKey, "user-9"), true);
  assert.equal(manager.applyTrustedSender(registration.executionKey, "user-9"), false);
  assert.equal(manager.applyTrustedSender(registration.executionKey, "bad\npeer"), false);
  assert.equal(manager.applyTrustedSender(registration.executionKey, ""), false);
  manager.reportProgress(registration.executionKey, event());
  await manager.finish(registration.executionKey);

  assert.equal(calls[0].peerId, "user-9");
  manager.close();
});

test("SkillProgressManager logs CLI diagnostic events without delivering them", async () => {
  const calls = [];
  const logs = [];
  const manager = createManager({
    notify: async (input) => { calls.push(input); return { ok: true }; },
    log: (message) => logs.push(message),
  });
  const registration = manager.registerBackground(backgroundInput());

  assert.equal(manager.reportProgress(registration.executionKey, event({
    type: "log", stage: "stage", text: "error=invalid_event",
  })).accepted, true);
  await manager.finish(registration.executionKey);

  assert.equal(calls.length, 0);
  assert.equal(logs.some((line) =>
    line.includes("action=cli outcome=logged reason=error=invalid_event")), true);
  manager.close();
});

test("SkillProgressManager deliver failure logs the notify error detail", async () => {
  const logs = [];
  const manager = createManager({
    notify: async () => ({ ok: false, error: 'Unknown target "jahan-e542bd0d" for Mattermost' }),
    log: (message) => logs.push(message),
  });
  const registration = manager.registerBackground(backgroundInput());

  manager.reportProgress(registration.executionKey, event());
  await manager.finish(registration.executionKey);

  assert.equal(logs.some((line) =>
    line.includes('deliver outcome=notify_failed reason=Unknown target "jahan-e542bd0d" for Mattermost')), true);
  manager.close();
});

test("B-04 renderer preserves Chinese, English, emoji, newlines, and Markdown as text", () => {
  const text = "第一行 😀\n**第二行** `value`";
  const chinese = renderProgressText(
    event({ type: "error", text }), { skillName: "report-skill", locale: "zh" },
  );
  const english = renderProgressText(
    event({ type: "progress", text }), { skillName: "report-skill", locale: "en" },
  );

  assert.equal(chinese, `进度 · report-skill\n❌ query：${text}`);
  assert.equal(english, `Progress · report-skill\n⏳ query: ${text}`);
  assert.equal(chinese.startsWith("{"), false);
  assert.equal(english.startsWith("{"), false);
});

test("SkillProgressManager installer reuses one shared bridge and injects stable logging", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "muad-progress-manager-install-"));
  const globals = {};
  const logs = [];
  const options = { rootDir: path.join(root, "events"), notify: async () => ({ ok: true }) };
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = installSkillProgressManager(globals, (message) => logs.push(message), options);
  const second = installSkillProgressManager(globals, () => {}, options);
  assert.equal(first, second);
  const registration = first.registerBackground(backgroundInput());
  first.reportProgress(registration.executionKey, event());
  await first.finish(registration.executionKey);
  assert.equal(logs.length > 0, true);
  assert.equal(logs.every((line) => line.startsWith("[muad-runtime-guard][skill-progress]")), true);
  const sources = ["../src/skill-progress-manager.mjs", "../src/skill-progress-policy.mjs"];
  for (const source of sources) {
    assert.equal(readFileSync(new URL(source, import.meta.url), "utf8").includes("console."), false);
  }

  first.close();
  const replacement = installSkillProgressManager(globals, () => {}, options);
  assert.notEqual(replacement, first);
  replacement.close();
});

function createManager(options = {}) {
  return new SkillProgressManager({
    bridge: options.bridge ?? createBridge(),
    notify: options.notify ?? (async () => ({ ok: true })),
    log: options.log,
    notifyTimeoutMs: options.notifyTimeoutMs ?? 50,
    finishTimeoutMs: options.finishTimeoutMs ?? 100,
    maxPendingPerExecution: options.maxPendingPerExecution ?? 8,
  });
}

function createBridge() {
  const registrations = new Map();
  const finished = [];
  return {
    registrations,
    finished,
    register({ executionKey }) {
      const value = { eventsFile: `/tmp/${executionKey}/events.jsonl` };
      registrations.set(executionKey, value);
      return value;
    },
    async finish(executionKey) { finished.push(executionKey); return { finished: true }; },
    close() {},
  };
}

function controlledNotify() {
  const calls = [];
  const resolvers = [];
  return {
    calls,
    notify: (input) => new Promise((resolve) => { calls.push(input); resolvers.push(resolve); }),
    resolveNext: (result) => resolvers.shift()?.(result),
  };
}

function backgroundInput(overrides = {}) {
  return {
    taskId: "task-1", agentId: "alice", skillName: "report-skill",
    replyChannel: "mattermost", peerId: "user-1", locale: "zh",
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    type: "progress", stage: "query", text: "正在查询",
    visibility: "channel", privacy: "public", ts: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

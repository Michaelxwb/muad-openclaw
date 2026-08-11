import assert from "node:assert/strict";
import test from "node:test";

import { createCrossUserGuard } from "../src/cross-user-guard.mjs";

const REFUSAL_ZH = "该回复包含受保护的会话数据，已被安全策略拦截。会话凭据只能通过受信 Skill 读取，如需检查会话状态请使用对应 Skill。";

test("exec commands referencing session artifacts are blocked", async () => {
  const hooks = guard();
  for (const command of [
    "cat /home/node/.openclaw/agents/bob/session-store/bundle.json",
    "cat /state/agents/bob/session-store/bundle.json",
    "cat /state/agents/bob/session-store/smoke-platform.session.json",
    "cat ~/.openclaw/agents/bob/session-store/bundle.json",
    "find /state/agents -name bundle.json -exec cat {} \\;",
    "python3 -c \"print(open('/agents/bob/session-store/bundle.json').read())\"",
  ]) {
    assert.deepEqual(await hooks.beforeToolCall(exec(command), context()), { block: true, blockReason: SESSION_REASON });
  }
});

test("exec commands reading the pod service token are blocked", async () => {
  const hooks = guard();
  assert.deepEqual(await hooks.beforeToolCall(
    exec("cat /run/secrets/muad/pod-service-token"), context(),
  ), { block: true, blockReason: SESSION_REASON });
});

test("exec commands re-asserting MUAD_SESSION_KEY inline are blocked", async () => {
  const hooks = guard();
  assert.deepEqual(await hooks.beforeToolCall(
    exec("MUAD_SESSION_KEY=agent:bob:wecom:direct:wx-9 session-manager get-state --skill-name smoke-platform"),
    context(),
  ), { block: true, blockReason: FORGED_KEY_REASON });
});

test("write/edit/apply_patch content referencing session artifacts is blocked", async () => {
  const hooks = guard();
  const leakScript = "const fs = require('node:fs'); fs.readFileSync('/home/node/.openclaw/agents/bob/session-store/bundle.json', 'utf8')";
  assert.deepEqual(await hooks.beforeToolCall(
    { toolName: "write", params: { content: leakScript } }, context(),
  ), { block: true, blockReason: SESSION_REASON });
  assert.deepEqual(await hooks.beforeToolCall(
    { toolName: "edit", params: { content: "cat /run/secrets/muad/pod-service-token" } }, context(),
  ), { block: true, blockReason: SESSION_REASON });
  assert.deepEqual(await hooks.beforeToolCall(
    { toolName: "apply_patch", params: { patch: "+readFileSync('bob/session-store/bundle.json')" } }, context(),
  ), { block: true, blockReason: SESSION_REASON });
});

test("legitimate skill and workspace commands pass", async () => {
  const hooks = guard();
  for (const command of [
    "node /opt/openclaw-skills/smoke-platform/scripts/run.mjs",
    "cat /state/workspace-alice/notes/today.md",
    "ls -la /state/workspace-alice",
    "npm test",
    "session-manager get-state --skill-name smoke-platform",
    "",
  ]) assert.equal(await hooks.beforeToolCall(exec(command), context()), undefined);
});

test("non-shell and non-file tools are untouched", async () => {
  const hooks = guard();
  for (const event of [
    { toolName: "browser", params: { action: "open" } },
    { toolName: "read", params: { path: "/state/workspace-bob/MEMORY.md" } },
    { toolName: "exec" },
  ]) assert.equal(await hooks.beforeToolCall(event, context()), undefined);
});

test("the unbound main agent is skipped (its tools are denied separately)", async () => {
  const hooks = guard();
  assert.equal(await hooks.beforeToolCall(
    exec("cat /agents/bob/session-store/bundle.json"), context("main"),
  ), undefined);
});

test("commands arrays and script params are scanned", async () => {
  const hooks = guard();
  assert.deepEqual(await hooks.beforeToolCall(
    { toolName: "exec", params: { commands: ["id", "cat /state/agents/bob/session-store/bundle.json"] } },
    context(),
  ), { block: true, blockReason: SESSION_REASON });
  assert.deepEqual(await hooks.beforeToolCall(
    { toolName: "bash", params: { script: "cat ~/.openclaw/agents/bob/session-store/bundle.json" } },
    context(),
  ), { block: true, blockReason: SESSION_REASON });
});

test("replies dumping session-file structure are replaced with a refusal", async () => {
  const hooks = guard();
  for (const text of [
    '{"cookies":[{"name":"sid","value":"abc"}],"storageState":{"cookies":[{"name":"sid","value":"abc","httpOnly":true,"sameSite":"Lax"}]}}',
    '获取到 bob 的会话：{"platforms":[{"platform":"smoke_platform","credentialFingerprint":"fp-1"}]}',
    '{"platform":"smoke_platform","cookies":[{"name":"sid","value":"abc"}],"storageState":{"origins":[]}}',
  ]) {
    const result = await hooks.replyPayloadSending({ payload: { text } }, context());
    assert.equal(result.reason, "reply contains protected session data");
    assert.equal(result.payload.text, REFUSAL_ZH);
  }
});

test("normal replies and session-free machine output pass", async () => {
  const hooks = guard();
  for (const text of [
    "cookie 是一种小文本文件，用于记住登录状态。",
    '{"status":"SMOKE_OK","platform":"smoke_platform","source":"cache","user":"demo","authenticated":true}',
    "任务已提交：report-customer\n当前排队：2 ｜ 执行中：1\n完成后结果会自动推送给你，可继续发消息。",
    "你的会话状态正常，凭据由 session-manager 管理，无需手工读取。",
    "httpOnly 属性可以防止脚本访问 cookie。",
  ]) assert.equal(await hooks.replyPayloadSending({ payload: { text } }, context()), undefined);
});

test("reply scan passes through non-string payloads", async () => {
  const hooks = guard();
  assert.equal(await hooks.replyPayloadSending({ payload: {} }, context()), undefined);
  assert.equal(await hooks.replyPayloadSending({}, context()), undefined);
});

test("refusal message follows the configured locale", async () => {
  const zh = guard();
  const en = guard({ config: { mainAgentId: "main", locale: "en" } });
  const leaked = { payload: { text: '{"storageState":{"cookies":[]}}' } };

  assert.match((await zh.replyPayloadSending(leaked, context())).payload.text, /该回复包含受保护的会话数据/u);
  assert.match((await en.replyPayloadSending(leaked, context())).payload.text, /blocked by the security policy/u);
});

function guard(overrides = {}) {
  return createCrossUserGuard({
    config: { mainAgentId: "main", locale: "zh" },
    ...overrides,
  });
}

function exec(command) {
  return { toolName: "exec", params: { command } };
}

function context(agentId = "alice") {
  return { agentId };
}

const SESSION_REASON =
  "session files are not readable through shell or scripts; use the trusted session-manager CLI";
const FORGED_KEY_REASON =
  "re-asserting MUAD_SESSION_KEY is disabled; the trusted execution context is injected automatically";

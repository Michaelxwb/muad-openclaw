import assert from "node:assert/strict";
import test from "node:test";

import { createBindCommand } from "../src/bind-command.mjs";
import { BindingClientError } from "../src/binding-client.mjs";

test("/bind consumes WeCom direct messages and sends scoped context to Console", async () => {
  const requests = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async (request) => { requests.push(request); return { identityBound: true }; } },
  });
  const result = await command.handler(commandContext({
    channel: "wecom",
    channelId: "wecom",
    senderId: "wojmppEQAA1lYfixAU-eb0rhEmcVD2gg",
    sessionKey: "agent:main:wecom:direct:wojmppeqaA1lyfixau-eb0rhemcvd2gg".toLowerCase(),
  }));

  assert.equal(command.acceptsArgs, true);
  assert.equal(command.requireAuth, false);
  assert.deepEqual(result, { text: "绑定成功，配置正在应用，请稍后重新发送业务消息。", continueAgent: false });
  assert.deepEqual(requests, [{
    code: "MUAD-23456789",
    channel: "wecom",
    openclawChannel: "wecom",
    accountId: "default",
    externalId: "wojmppEQAA1lYfixAU-eb0rhEmcVD2gg",
    externalIdType: "wecom_userid",
    peerKind: "direct",
  }]);
});

test("/bind accepts the channel-scoped sender emitted by WeCom command context", async () => {
  const requests = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async (request) => { requests.push(request); } },
  });
  const result = await command.handler(commandContext({
    senderId: "wecom:XuWenBin",
    from: "wecom:XuWenBin",
    sessionKey: "agent:main:wecom:direct:xuwenbin",
  }));

  assert.equal(result.text, "绑定成功，配置正在应用，请稍后重新发送业务消息。");
  assert.equal(requests[0].externalId, "XuWenBin");
});

test("/bind accepts codes generated from the shared binding-code alphabet", async () => {
  const requests = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async (request) => { requests.push(request); } },
  });

  const result = await command.handler(commandContext({ args: "MUAD-X1GD78W5" }));

  assert.equal(result.text, "绑定成功，配置正在应用，请稍后重新发送业务消息。");
  assert.equal(requests[0].code, "MUAD-X1GD78W5");
});

test("/bind resolves main agent from the trusted session key when command agentId is absent", async () => {
  const requests = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async (request) => { requests.push(request); } },
  });
  const result = await command.handler(commandContext({
    agentId: undefined,
    senderId: "wecom:XuWenBin",
    from: "wecom:XuWenBin",
    sessionKey: "agent:main:wecom:direct:xuwenbin",
  }));

  assert.equal(result.text, "绑定成功，配置正在应用，请稍后重新发送业务消息。");
  assert.equal(requests.length, 1);
});

test("/bind maps WeChat to openclaw-weixin without producing a model reply", async () => {
  const requests = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async (request) => { requests.push(request); } },
  });
  const senderId = "o9cq804HgKSer0_xAOY8nQB7lye4@im.wechat";
  const result = await command.handler(commandContext({
    channel: "openclaw-weixin", channelId: "openclaw-weixin", senderId,
    sessionKey: `agent:main:openclaw-weixin:direct:${senderId}`,
  }));

  assert.equal(result.continueAgent, false);
  assert.equal("suppressReply" in result, false);
  assert.equal(requests[0].channel, "wechat");
  assert.equal(requests[0].openclawChannel, "openclaw-weixin");
  assert.equal(requests[0].externalIdType, "wechat_peer_id");
});

test("/bind rejects missing senders, group sessions, unsupported channels, and non-main agents", async () => {
  let calls = 0;
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async () => { calls += 1; } },
  });
  const cases = [
    commandContext({ senderId: "", sessionKey: "agent:main:wecom:direct:user" }),
    commandContext({ senderId: "user", sessionKey: "agent:main:wecom:group:user" }),
    commandContext({ channel: "feishu", channelId: "feishu", senderId: "user", sessionKey: "agent:main:feishu:direct:user" }),
    commandContext({ agentId: "alice", senderId: "user", sessionKey: "agent:alice:wecom:direct:user" }),
    commandContext({
      senderId: "wecom:group:room-1",
      from: "wecom:group:room-1",
      sessionKey: "agent:main:wecom:group:room-1",
    }),
    commandContext({
      senderId: "wecom:XuWenBin",
      from: "wecom:AnotherUser",
      sessionKey: "agent:main:wecom:direct:xuwenbin",
    }),
  ];
  for (const context of cases) {
    const result = await command.handler(context);
    assert.equal(result.continueAgent, false);
  }
  assert.equal(calls, 0);
});

test("/bind returns stable text without exposing code or internal errors", async () => {
  const code = "MUAD-23456789";
  for (const clientError of [
    new BindingClientError("invalid_binding"),
    new BindingClientError("rate_limited", true),
    new BindingClientError("service_unavailable", true),
  ]) {
    const command = createBindCommand({
      mainAgentId: "main",
      client: { activate: async () => { throw clientError; } },
    });
    const result = await command.handler(commandContext({ args: code }));
    assert.equal(result.continueAgent, false);
    assert.equal(result.text.includes(code), false);
    assert.equal(result.text.includes("BindingClientError"), false);
  }
});

test("/bind reports only stable non-sensitive context rejection reasons", async () => {
  const rejected = [];
  const command = createBindCommand({
    mainAgentId: "main",
    client: { activate: async () => {} },
    onRejected: (event) => { rejected.push(event); },
  });

  await command.handler(commandContext({
    args: "MUAD-23456789",
    senderId: "wecom:XuWenBin",
    from: "wecom:XuWenBin",
    sessionKey: "agent:main:wecom:group:room-1",
  }));

  assert.deepEqual(rejected, [{ code: "direct_context_required", reason: "session_not_direct" }]);
  assert.equal(JSON.stringify(rejected).includes("XuWenBin"), false);
  assert.equal(JSON.stringify(rejected).includes("MUAD-23456789"), false);
});

function commandContext(overrides = {}) {
  const senderId = overrides.senderId ?? "wecom-user";
  return {
    args: "muad-2345 6789",
    channel: "wecom",
    channelId: "wecom",
    accountId: "default",
    agentId: "main",
    senderId,
    sessionKey: `agent:main:wecom:direct:${senderId}`,
    ...overrides,
  };
}

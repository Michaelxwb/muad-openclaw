import assert from "node:assert/strict";
import test from "node:test";

import {
  createMainBindingReply,
  MAIN_BINDING_REPLY,
} from "../src/main-binding-reply.mjs";

test("main agent claims normal messages with binding guidance before model execution", () => {
  const handler = createMainBindingReply({ mainAgentId: "main" });
  const result = handler(
    { cleanedBody: "帮我查询 XDR 告警" },
    { agentId: "main", channel: "wecom", senderId: "unknown-user" },
  );

  assert.deepEqual(result, {
    handled: true,
    reply: { text: MAIN_BINDING_REPLY },
    reason: "muad-unbound-main",
  });
});

test("business agents continue through the normal model path", () => {
  const handler = createMainBindingReply({ mainAgentId: "main" });

  assert.equal(handler({ cleanedBody: "hello" }, { agentId: "alice" }), undefined);
});

test("binding guidance never echoes inbound content, sender identity, or secrets", () => {
  const handler = createMainBindingReply({ mainAgentId: "main" });
  const sensitiveValues = ["MUAD-23456789", "unknown-user", "sk-sensitive-value"];
  const result = handler(
    { cleanedBody: sensitiveValues.join(" ") },
    { agentId: "main", senderId: sensitiveValues[1] },
  );
  const serialized = JSON.stringify(result);

  for (const value of sensitiveValues) assert.equal(serialized.includes(value), false);
});

test("main agent fails closed when optional event and channel context are absent", () => {
  const handler = createMainBindingReply({ mainAgentId: "main" });

  assert.equal(handler(undefined, { agentId: "main" })?.handled, true);
  assert.equal(handler(undefined, undefined), undefined);
});

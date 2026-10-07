import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelConfigDispatch,
  MODEL_CONFIG_REPLY,
  resolveModelState,
} from "../src/model-config-reply.mjs";

test("business agents are blocked before dispatch when model config is missing", () => {
  const rejected = [];
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "alice" }] }, models: { providers: {} } },
    onInvalid: (event) => rejected.push(event),
  });

  assert.deepEqual(handler({ content: "hello sk-secret" }, { agentId: "alice" }), {
    handled: true,
    text: MODEL_CONFIG_REPLY,
    reason: "muad-model-config-unavailable",
  });
  assert.deepEqual(rejected, [{ agentId: "alice", reason: "agent_model_missing" }]);
});

test("before dispatch resolves business agent from OpenClaw session key", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "alice" }] }, models: { providers: {} } },
  });

  assert.equal(
    handler(
      { content: "hello", sessionKey: "session:agent:alice:wecom:direct:alice" },
      {},
    )?.text,
    MODEL_CONFIG_REPLY,
  );
});

test("before dispatch resolves the agent from a prefix-less agent: session key (long task form)", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "alice" }] }, models: { providers: {} } },
  });

  const result = handler(
    { content: "hello", sessionKey: "agent:alice:longtask:task-1" },
    {},
  );
  assert.equal(result?.text, MODEL_CONFIG_REPLY);
  assert.equal(result?.reason, "muad-model-config-unavailable");
});

test("before dispatch fails closed when the caller identity cannot be resolved", () => {
  const rejected = [];
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "alice" }] }, models: { providers: {} } },
    onInvalid: (event) => rejected.push(event),
  });

  assert.deepEqual(handler({ content: "hello" }, {}), {
    handled: true,
    text: MODEL_CONFIG_REPLY,
    reason: "muad-model-config-unavailable",
  });
  assert.deepEqual(rejected, [{ agentId: "invalid", reason: "agent_identity_unresolved" }]);
});

test("before dispatch passes when provider and model reference are valid", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: validModelConfig(),
  });

  assert.equal(
    handler(
      { content: "hello", sessionKey: "session:agent:alice:wecom:direct:alice" },
      {},
    ),
    undefined,
  );
});

test("main agent is left for binding guidance", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "main" }] }, models: { providers: {} } },
  });

  assert.equal(handler({ content: "hello" }, { agentId: "main" }), undefined);
});

test("model state checks provider and model references", () => {
  const state = resolveModelState({
    agents: { list: [{ id: "alice", model: { primary: "pod-default/deepseek-chat" } }] },
    models: { providers: { "pod-default": { models: [{ id: "deepseek-chat" }] } } },
  });

  assert.equal(state.agents.get("alice"), "pod-default/deepseek-chat");
  assert.equal(state.providers.get("pod-default").has("deepseek-chat"), true);
});

test("9.8 agents.entries shape resolves agent models (pod02 rehearsal regression)", () => {
  const state = resolveModelState({
    agents: {
      entries: {
        alice: { model: { primary: "user-alice-deepseek/deepseek-flash" } },
      },
    },
    models: {
      providers: { "user-alice-deepseek": { models: [{ id: "deepseek-flash" }] } },
    },
  });

  assert.equal(state.agents.get("alice"), "user-alice-deepseek/deepseek-flash");
  assert.equal(state.providers.get("user-alice-deepseek").has("deepseek-flash"), true);
});

test("9.8 entries shape passes dispatch for a valid business agent", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: {
      agents: {
        entries: {
          alice: { model: { primary: "user-alice-deepseek/deepseek-flash" } },
          main: { model: { primary: "user-main-deepseek/deepseek-flash" } },
        },
      },
      models: {
        providers: { "user-alice-deepseek": { models: [{ id: "deepseek-flash" }] } },
      },
    },
  });

  assert.equal(
    handler(
      { content: "hello", sessionKey: "session:agent:alice:wecom:direct:alice" },
      {},
    ),
    undefined,
  );
});

test("9.8 entries shape fails closed when the agent entry lacks a model", () => {
  const rejected = [];
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: {
      agents: { entries: { alice: { workspace: "/w" } } },
      models: { providers: {} },
    },
    onInvalid: (event) => rejected.push(event),
  });

  assert.equal(
    handler({ content: "hello" }, { agentId: "alice" })?.reason,
    "muad-model-config-unavailable",
  );
  assert.deepEqual(rejected, [{ agentId: "alice", reason: "agent_model_missing" }]);
});

test("standard reply does not echo secrets or internal model details", () => {
  const handler = createModelConfigDispatch({
    mainAgentId: "main",
    config: { agents: { list: [{ id: "alice" }] }, models: { providers: {} } },
  });
  const result = handler({ content: "sk-sensitive openai/gpt-5.5" }, { agentId: "alice" });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("sk-sensitive"), false);
  assert.equal(serialized.includes("openai/gpt-5.5"), false);
});

function validModelConfig() {
  return {
    agents: {
      list: [
        { id: "main" },
        { id: "alice", model: { primary: "pod-default/deepseek-chat" } },
      ],
    },
    models: {
      providers: {
        "pod-default": {
          models: [{ id: "deepseek-chat", name: "deepseek-chat" }],
        },
      },
    },
  };
}

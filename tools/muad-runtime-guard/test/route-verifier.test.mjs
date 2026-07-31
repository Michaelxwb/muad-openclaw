import assert from "node:assert/strict";
import test from "node:test";

import { createRouteVerifier, verifyRoutes } from "../src/route-verifier.mjs";

test("route verifier checks expected routes through runtime resolver", async () => {
  const calls = [];
  const result = verifyRoutes(routeRequest(), {
    config: configWithGeneration(9),
    resolver: (input) => {
      calls.push(input);
      return {
        agentId: input.peer.id === "mm-user-1" ? "alice" : "bob",
        sessionKey: `agent:${input.peer.id === "mm-user-1" ? "alice" : "bob"}:mattermost:direct:${input.peer.id}`,
        matchedBy: "binding.peer",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.generation, 9);
  assert.equal(result.checked, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cfg.plugins.entries["muad-runtime-guard"].config.generation, 9);
  assert.deepEqual(calls[0].peer, { kind: "direct", id: "mm-user-1" });
});

test("route verifier accepts session-prefixed or missing session keys", () => {
  const result = verifyRoutes(routeRequest(), {
    config: configWithGeneration(9),
    resolver: (input) => ({
      agentId: input.peer.id === "mm-user-1" ? "alice" : "bob",
      sessionKey: input.peer.id === "mm-user-1" ?
        "session:agent:alice:mattermost:direct:mm-user-1" : undefined,
      matchedBy: "binding.peer",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.checked, 2);
});

test("route verifier rejects present session keys that resolve to another agent", () => {
  const result = verifyRoutes(routeRequest(), {
    config: configWithGeneration(9),
    resolver: (input) => ({
      agentId: input.peer.id === "mm-user-1" ? "alice" : "bob",
      sessionKey: input.peer.id === "mm-user-1" ?
        "session:agent:bob:mattermost:direct:mm-user-1" : undefined,
      matchedBy: "binding.peer",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{
    index: 0,
    reason: "session_agent_mismatch",
    expectedAgentId: "alice",
  }]);
});

test("route verifier fails closed on generation mismatch or missing resolver", () => {
  assert.deepEqual(
    verifyRoutes(routeRequest(10), {
      config: configWithGeneration(9),
      resolver: () => ({ agentId: "alice", sessionKey: "agent:alice:main" }),
    }),
    { ok: false, generation: 9, checked: 2, failed: 2, error: "generation_mismatch", failures: [] },
  );
  assert.deepEqual(
    verifyRoutes(routeRequest(), { config: configWithGeneration(9) }),
    {
      ok: false,
      generation: 9,
      checked: 2,
      failed: 2,
      error: "route_resolver_unavailable",
      failures: [],
    },
  );
});

test("route verifier rejects default or wrong-agent resolutions without echoing peer ids", () => {
  const result = verifyRoutes(routeRequest(), {
    config: configWithGeneration(9),
    resolver: (input) => ({
      agentId: input.peer.id === "mm-user-1" ? "main" : "bob",
      sessionKey: input.peer.id === "mm-user-1" ? "agent:main:mattermost:direct:mm-user-1" : undefined,
      matchedBy: input.peer.id === "mm-user-1" ? "default" : "binding.peer",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures, [{
    index: 0,
    reason: "agent_mismatch",
    expectedAgentId: "alice",
    actualAgentId: "main",
    matchedBy: "default",
  }]);
  assert.equal(JSON.stringify(result).includes("mm-user-1"), false);
});

test("route verifier handler reads the current in-memory config", async () => {
  const handler = createRouteVerifier({
    config: configWithGeneration(7),
    runtime: {
      config: { current: () => configWithGeneration(9) },
      channel: { routing: {
        resolveAgentRoute: (input) => ({
          agentId: input.peer.id === "mm-user-1" ? "alice" : "bob",
          sessionKey: `agent:${input.peer.id === "mm-user-1" ? "alice" : "bob"}:mattermost:direct:${input.peer.id}`,
          matchedBy: "binding.peer",
        }),
      } },
    },
  });

  const result = await handler({ params: routeRequest() });
  assert.equal(result.ok, true);
  assert.equal(result.generation, 9);
});

function routeRequest(generation = 9) {
  return {
    generation,
    routes: [
      {
        agentId: "alice",
        channel: "mattermost",
        accountId: "default",
        peerKind: "direct",
        externalId: "mm-user-1",
      },
      {
        agentId: "bob",
        channel: "wecom",
        accountId: "default",
        peerKind: "dm",
        externalId: "wx-user-2",
      },
    ],
  };
}

function configWithGeneration(generation) {
  return {
    plugins: {
      entries: {
        "muad-runtime-guard": { config: { generation } },
      },
    },
  };
}

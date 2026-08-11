import assert from "node:assert/strict";
import test from "node:test";

import {
  ResolverClient,
  SERVICE_TOKEN_FILE,
  SessionManagerError,
  makeResolveRequest,
} from "../dist/index.js";

test("Resolver client reads the fixed token file and retries one transient failure", async () => {
  let calls = 0;
  const delays = [];
  const tokenPaths = [];
  const client = new ResolverClient({
    baseURL: "http://console:8080",
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "http://console:8080/internal/v1/session-credentials/resolve");
      assert.equal(options.headers.Authorization, "Bearer service-token");
      assert.equal(JSON.parse(options.body).platform, undefined);
      assert.equal(JSON.parse(options.body).purpose, "session_get_state");
      if (calls === 1) throw new TypeError("network unavailable");
      return successResponse("internal-api-key", "mssw");
    },
    readToken: async (path) => {
      tokenPaths.push(path);
      return " service-token\n";
    },
    sleep: async (duration) => delays.push(duration),
    random: () => 0.5,
    retryBaseMs: 10,
    retryJitterMs: 20,
  });

  const result = await client.resolve(makeResolveRequest("alice", "xdr-query"));
  assert.equal(result.platforms.length, 1);
  assert.equal(result.platforms[0].platform, "mssw");
  assert.equal(result.platforms[0].credentials.apiKey, "internal-api-key");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [20]);
  assert.deepEqual(tokenPaths, [SERVICE_TOKEN_FILE]);
});

test("Resolver maps multi-platform selection errors to stable session errors", async () => {
  for (const [code, expected] of [[40514, "platform_not_bound"], [40527, "invalid_skill"], [40606, "not_configured"], [40605, "platform_disabled"], [40901, "agent_not_active"]]) {
    const client = new ResolverClient({
      baseURL: "http://console:8080",
      readToken: async () => "service-token",
      fetch: async () => new Response(JSON.stringify({ code, message: "domain error" }), { status: 400 }),
    });
    await assert.rejects(
      () => client.resolve(makeResolveRequest("alice", "xdr-query")),
      (error) => error instanceof SessionManagerError && error.code === expected,
    );
  }
});

test("Resolver client applies the timeout to both bounded attempts", async () => {
  let calls = 0;
  const client = new ResolverClient({
    baseURL: "http://console:8080/internal/v1",
    timeoutMs: 5,
    retryBaseMs: 0,
    retryJitterMs: 0,
    readToken: async () => "service-token",
    sleep: async () => {},
    fetch: async (url, options) => {
      calls += 1;
      assert.equal(String(url), "http://console:8080/internal/v1/session-credentials/resolve");
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
  });

  await assert.rejects(
    () => client.resolve(makeResolveRequest("alice", "xdr-query")),
    (error) => error instanceof SessionManagerError && error.code === "credential_service_unavailable",
  );
  assert.equal(calls, 2);
});

test("Resolver domain errors are stable and are not retried", async () => {
  let calls = 0;
  const client = new ResolverClient({
    baseURL: "http://console:8080",
    readToken: async () => "service-token",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 40605, message: "platform is disabled" }), { status: 409 });
    },
  });

  await assert.rejects(
    () => client.resolve(makeResolveRequest("alice", "xdr-query")),
    (error) => error instanceof SessionManagerError && error.code === "platform_disabled" && error.exitCode === 11,
  );
  assert.equal(calls, 1);
});

test("Resolver rejects responses missing platforms or carrying mismatched agent", async () => {
  const client = new ResolverClient({
    baseURL: "http://console:8080",
    readToken: async () => "service-token",
    fetch: async (_url, _options) => new Response(JSON.stringify({
      code: 0,
      data: {
        humanUserId: "user-a",
        podId: "pod-a",
        agentId: "bob",
        skillName: "xdr-query",
        platforms: [{ platform: "xdr", credentialFingerprint: "sha256:x", credentials: { apiKey: "k" } }],
      },
    }), { status: 200 }),
  });

  await assert.rejects(
    () => client.resolve(makeResolveRequest("alice", "xdr-query")),
    (error) => error instanceof SessionManagerError && error.code === "credential_service_unavailable",
  );
});

function successResponse(apiKey, platform = "xdr") {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      humanUserId: "user-a",
      podId: "pod-a",
      agentId: "alice",
      skillName: "xdr-query",
      platforms: [{
        platform,
        credentialFingerprint: "sha256:credential",
        credentials: { apiKey, baseUrl: "https://xdr.internal", sessionMode: "storage_state" },
      }],
    },
  }), { status: 200 });
}

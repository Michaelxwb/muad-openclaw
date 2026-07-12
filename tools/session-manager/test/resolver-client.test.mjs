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
      if (calls === 1) throw new TypeError("network unavailable");
      return successResponse("internal-api-key");
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

  const result = await client.resolve(makeResolveRequest("alice", "xdr"));
  assert.equal(result.apiKey, "internal-api-key");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [20]);
  assert.deepEqual(tokenPaths, [SERVICE_TOKEN_FILE]);
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
    () => client.resolve(makeResolveRequest("alice", "xdr")),
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
      return new Response(JSON.stringify({ code: 40905, message: "platform is disabled" }), { status: 409 });
    },
  });

  await assert.rejects(
    () => client.resolve(makeResolveRequest("alice", "xdr")),
    (error) => error instanceof SessionManagerError && error.code === "platform_disabled" && error.exitCode === 11,
  );
  assert.equal(calls, 1);
});

function successResponse(apiKey) {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      humanUserId: "user-a",
      podId: "pod-a",
      agentId: "alice",
      platform: "xdr",
      credentialFingerprint: "sha256:credential",
      platformConfigFingerprint: "sha256:platform",
      apiKey,
      sessionMode: "storage_state",
      adapter: "xdr",
      platformConfig: { baseUrl: "https://xdr.internal" },
    },
  }), { status: 200 });
}

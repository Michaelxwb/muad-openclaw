import assert from "node:assert/strict";
import test from "node:test";

import {
  createInstalledAdapterRegistry,
  HTTPSessionAdapter,
  PlatformAdapterError,
} from "../dist/index.js";

test("installed adapter registry exchanges API key without returning it", async () => {
  const requests = [];
  const registry = createInstalledAdapterRegistry(async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization, body: options.body });
    return new Response(JSON.stringify({
      data: {
        cookies: [{ name: "sid", value: "session-cookie", domain: ".internal", path: "/" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }), { status: 200 });
  });

  assert.deepEqual(registry.installed(), []);
  const state = await registry.get("custom_platform").refresh({
    credential: credential("custom_platform"),
    signal: new AbortController().signal,
  });
  assert.deepEqual(registry.installed(), ["custom_platform"]);
  assert.equal(requests[0].url, "https://custom-platform.internal/custom/session");
  assert.equal(requests[0].authorization, "Bearer api-key-memory-only");
  assert.equal(String(requests[0].body).includes("api-key-memory-only"), false);
  assert.equal(JSON.stringify(state).includes("api-key-memory-only"), false);
  assert.equal(state.storageState.cookies[0].value, "session-cookie");
});

test("adapter registry rejects invalid adapter names and marks authentication failures", async () => {
  const registry = createInstalledAdapterRegistry(async () => new Response("{}", { status: 401 }));
  assert.throws(() => registry.get("invalid-platform"), PlatformAdapterError);
  await assert.rejects(
    () => registry.get("custom_platform").refresh({
      credential: credential("custom_platform"), signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError && error.authenticationFailed,
  );
});

test("HTTP adapter supports AK/SK login responses that set cookies in headers", async () => {
  const requests = [];
  const registry = createInstalledAdapterRegistry(async (url, options) => {
    requests.push({
      url: String(url),
      accessKey: options.headers["X-Access-Key"],
      secretKey: options.headers["X-Secret-Key"],
      body: String(options.body),
    });
    return new Response("", {
      status: 200,
      headers: { "set-cookie": "sid=session-cookie; Path=/; HttpOnly; SameSite=Lax" },
    });
  });
  const current = credential("mssw");
  current.credentials = {
    baseUrl: "https://mssw.internal",
    sessionEndpoint: "/login",
    sessionTtlSeconds: 120,
    ak: "ak-memory-only",
    sk: "sk-memory-only",
  };

  const state = await registry.get("mssw").refresh({
    credential: current,
    signal: new AbortController().signal,
  });

  assert.equal(requests[0].url, "https://mssw.internal/login");
  assert.equal(requests[0].accessKey, "ak-memory-only");
  assert.equal(requests[0].secretKey, "sk-memory-only");
  assert.equal(requests[0].body.includes("ak-memory-only"), true);
  assert.equal(requests[0].body.includes("sk-memory-only"), true);
  assert.equal(state.cookies[0].domain, "mssw.internal");
  assert.equal(state.cookies[0].httpOnly, true);
  assert.equal(state.cookies[0].sameSite, "Lax");
  assert.equal(JSON.stringify(state).includes("ak-memory-only"), false);
  assert.equal(JSON.stringify(state).includes("sk-memory-only"), false);
});

test("HTTP adapter validates cached cookies with an optional health endpoint", async () => {
  const requests = [];
  const adapter = new HTTPSessionAdapter("mssw", async (url, options) => {
    requests.push({ url: String(url), cookie: options.headers.Cookie });
    return new Response("ok", { status: requests.length === 1 ? 200 : 401 });
  });
  const current = credential("mssw");
  current.credentials = {
    baseUrl: "https://mssw.internal",
    healthEndpoint: "/health",
  };
  const input = {
    credential: current,
    signal: new AbortController().signal,
    state: {
      cookies: [{ name: "sid", value: "session-cookie", domain: "mssw.internal", path: "/" }],
      storageState: { cookies: [], origins: [] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };

  assert.equal(await adapter.validate(input), true);
  assert.equal(await adapter.validate(input), false);
  assert.equal(requests[0].url, "https://mssw.internal/health");
  assert.equal(requests[0].cookie, "sid=session-cookie");
});

test("adapter marks transport failures as retryable without exposing the cause", async () => {
  const registry = createInstalledAdapterRegistry(async () => {
    throw new TypeError("network unavailable for api-key-memory-only");
  });

  await assert.rejects(
    () => registry.get("custom_platform").refresh({
      credential: credential("custom_platform"), signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError && error.retryable &&
      !error.authenticationFailed && !error.message.includes("api-key-memory-only"),
  );
});

function credential(platform) {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "custom-query",
    platform,
    credentialFingerprint: "sha256:credential",
    credentials: {
      apiKey: "api-key-memory-only",
      sessionMode: "storage_state",
      baseUrl: "https://custom-platform.internal",
      sessionEndpoint: "/custom/session",
    },
  };
}

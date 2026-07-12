import assert from "node:assert/strict";
import test from "node:test";

import {
  createInstalledAdapterRegistry,
  INSTALLED_ADAPTERS,
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

  assert.deepEqual(registry.installed(), [...INSTALLED_ADAPTERS]);
  const state = await registry.get("xdr").refresh({
    credential: credential(),
    signal: new AbortController().signal,
  });
  assert.equal(requests[0].url, "https://xdr.internal/custom/session");
  assert.equal(requests[0].authorization, "Bearer api-key-memory-only");
  assert.equal(String(requests[0].body).includes("api-key-memory-only"), false);
  assert.equal(JSON.stringify(state).includes("api-key-memory-only"), false);
  assert.equal(state.storageState.cookies[0].value, "session-cookie");
});

test("adapter registry rejects unknown adapters and marks authentication failures", async () => {
  const registry = createInstalledAdapterRegistry(async () => new Response("{}", { status: 401 }));
  assert.throws(() => registry.get("unknown"), PlatformAdapterError);
  await assert.rejects(
    () => registry.get("xdr").refresh({
      credential: credential(), signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError && error.authenticationFailed,
  );
});

test("adapter marks transport failures as retryable without exposing the cause", async () => {
  const registry = createInstalledAdapterRegistry(async () => {
    throw new TypeError("network unavailable for api-key-memory-only");
  });

  await assert.rejects(
    () => registry.get("xdr").refresh({
      credential: credential(), signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError && error.retryable &&
      !error.authenticationFailed && !error.message.includes("api-key-memory-only"),
  );
});

function credential() {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    platform: "xdr",
    credentialFingerprint: "sha256:credential",
    platformConfigFingerprint: "sha256:platform",
    apiKey: "api-key-memory-only",
    sessionMode: "storage_state",
    adapter: "xdr",
    platformConfig: {
      baseUrl: "https://xdr.internal",
      sessionEndpoint: "/custom/session",
    },
  };
}

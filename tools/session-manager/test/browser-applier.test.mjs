import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserSessionApplier,
  SessionManagerError,
} from "../dist/index.js";

test("browser applier writes cookies to the mapped OpenClaw profile", async () => {
  const calls = [];
  const applier = createBrowserSessionApplier({
    request: async (method, params, options) => {
      calls.push({ method, params, options });
      return { ok: true };
    },
    profileForAgent: (agentId) => agentId === "alice" ? "profile-alice" : undefined,
  });

  const result = await applier.apply(input({
    cookies: [{
      name: "sid",
      value: "cookie-value",
      domain: ".internal",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }],
  }));

  assert.deepEqual(result, { applied: true, profile: "profile-alice" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "browser.request",
    params: {
      method: "POST",
      path: "/cookies/set",
      query: { profile: "profile-alice" },
      body: {
        cookie: {
          name: "sid",
          value: "cookie-value",
          domain: ".internal",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      },
      timeoutMs: 20_000,
    },
    options: { timeoutMs: 20_000, scopes: ["operator.admin"] },
  });
});

test("browser applier rejects unsupported storageState origins with platform attribution", async () => {
  const applier = createBrowserSessionApplier({
    request: async () => {
      throw new Error("request must not be called");
    },
    profileForAgent: () => "profile-alice",
  });

  await assert.rejects(
    () => applier.apply(input({
      storageState: {
        cookies: [],
        origins: [{
          origin: "https://platform.internal",
          localStorage: [{ name: "token", value: "storage-token" }],
        }],
      },
    })),
    (error) => error instanceof SessionManagerError &&
      error.code === "browser_apply_failed" &&
      error.platform === "xdr" &&
      error.message === "storageState origins require a browser context-level import route",
  );
});

function input(update = {}) {
  const cookies = update.cookies ?? [];
  return {
    context: { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" },
    credential: {
      humanUserId: "user-a",
      podId: "pod-a",
      agentId: "alice",
      skillName: "xdr-query",
      platform: "xdr",
      credentialFingerprint: "sha256:credential",
      credentials: { apiKey: "api-key-memory-only" },
    },
    state: {
      cookies,
      storageState: update.storageState ?? { cookies, origins: [] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    source: "refresh",
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  SmokePlatformSessionAdapter,
  PlatformAdapterError,
} from "../dist/index.js";

const BASE = {
  humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "smoke-platform",
  platform: "smoke_platform", credentialFingerprint: "sha256:credential",
};

function credential(credentials) {
  return {
    ...BASE,
    credentials: {
      baseUrl: "https://smoke.internal",
      sessionEndpoint: "/login",
      username: "demo",
      password: "demo-pass",
      ...credentials,
    },
  };
}

function rejectPredicate(expected) {
  return (error) => error instanceof PlatformAdapterError
    && error.authenticationFailed === expected.authenticationFailed
    && error.retryable === expected.retryable
    && error.reason === expected.reason
    && error.businessCode === expected.businessCode
    && error.message === expected.message;
}

test("smoke_platform adapter logs in with username/password and keeps them out of session state", async () => {
  const requests = [];
  const adapter = new SmokePlatformSessionAdapter(async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: String(options.body) });
    return new Response("", {
      status: 200,
      headers: { "set-cookie": "fake_session=token-value; Path=/; HttpOnly; SameSite=Lax" },
    });
  });

  const state = await adapter.refresh({ credential: credential({}), signal: new AbortController().signal });

  assert.equal(requests[0].url, "https://smoke.internal/login");
  assert.equal(requests[0].method, "POST");
  assert.equal(JSON.parse(requests[0].body).username, "demo");
  assert.equal(JSON.parse(requests[0].body).password, "demo-pass");
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].name, "fake_session");
  assert.equal(state.cookies[0].value, "token-value");
  assert.equal(state.cookies[0].httpOnly, true);
  assert.equal(state.cookies[0].sameSite, "Lax");
  assert.equal(state.storageState.origins.length, 0);
  // The password must never appear in the persisted session state.
  assert.equal(JSON.stringify(state).includes("demo-pass"), false);
});

test("smoke_platform adapter accepts a success body with code 0 and a cookie", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 0, msg: "ok", authenticated: true, user: "demo" }), {
      status: 200,
      headers: { "set-cookie": "fake_session=token-value; Path=/; HttpOnly" },
    }));

  const state = await adapter.refresh({ credential: credential({}), signal: new AbortController().signal });
  assert.equal(state.cookies[0].value, "token-value");
});

// /login 永远返回 HTTP 200，业务错误码在 JSON body 的 code 字段。下面用例覆盖
// 各业务码 → PlatformAdapterError(authenticationFailed, retryable, reason, message, businessCode)
// 映射，message 必须原样透传服务端 body 的 msg 字段。
test("smoke_platform adapter treats body code:1002 (AuthFailed) as authentication failure", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 1002, msg: "invalid credentials", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: true, retryable: false, reason: "auth_failed",
      businessCode: 1002, message: "invalid credentials",
    }),
  );
});

test("smoke_platform adapter treats body code:1001 (ParamsErr) as authentication failure", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 1001, msg: "username and password are required", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: true, retryable: false, reason: "params_error",
      businessCode: 1001, message: "username and password are required",
    }),
  );
});

test("smoke_platform adapter treats body code:1003 (AccountLocked) as retryable", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 1003, msg: "account locked", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: false, retryable: true, reason: "account_locked",
      businessCode: 1003, message: "account locked",
    }),
  );
});

test("smoke_platform adapter treats body code:1004 (RateLimited) as retryable", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 1004, msg: "rate limited", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: false, retryable: true, reason: "rate_limited",
      businessCode: 1004, message: "rate limited",
    }),
  );
});

test("smoke_platform adapter treats body code:1005 (ServiceErr) as retryable", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 1005, msg: "service error", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: false, retryable: true, reason: "service_error",
      businessCode: 1005, message: "service error",
    }),
  );
});

test("smoke_platform adapter treats unknown body code as retryable unknown failure and forwards server msg", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 99999, msg: "unknown failure", authenticated: false }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    rejectPredicate({
      authenticationFailed: false, retryable: true, reason: "unknown",
      businessCode: 99999, message: "unknown failure",
    }),
  );
});

test("smoke_platform adapter marks HTTP 401 as authentication failure", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () => new Response("{}", { status: 401 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === true && error.reason === "auth_failed",
  );
});

test("smoke_platform adapter treats a successful login without cookies as service error", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 0, msg: "ok", authenticated: true, user: "demo" }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({}), signal: new AbortController().signal }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === false
      && error.retryable === false
      && error.reason === "service_error",
  );
});

test("smoke_platform adapter validates cached cookies with the health endpoint", async () => {
  const requests = [];
  const adapter = new SmokePlatformSessionAdapter(async (url, options) => {
    requests.push({ url: String(url), cookie: options.headers.Cookie });
    return new Response("ok", { status: requests.length === 1 ? 200 : 401 });
  });
  const current = credential({ healthEndpoint: "/health/session" });
  const input = {
    credential: current,
    signal: new AbortController().signal,
    state: {
      cookies: [{ name: "fake_session", value: "token-value", domain: "smoke.internal", path: "/" }],
      storageState: { cookies: [], origins: [] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };

  assert.equal(await adapter.validate(input), true);
  assert.equal(await adapter.validate(input), false);
  assert.equal(requests[0].url, "https://smoke.internal/health/session");
  assert.equal(requests[0].cookie, "fake_session=token-value");
});

test("smoke_platform adapter rejects credentials missing username/password/sessionEndpoint", async () => {
  const adapter = new SmokePlatformSessionAdapter(async () => new Response("{}", { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({ credential: credential({ username: "", password: "" }), signal: new AbortController().signal }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === true
      && error.retryable === false
      && error.reason === "missing_credential",
  );
});

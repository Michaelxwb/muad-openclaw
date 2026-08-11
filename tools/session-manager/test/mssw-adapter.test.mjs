import assert from "node:assert/strict";
import test from "node:test";

import {
  MSSWSessionAdapter,
  makeCanonicalRequest,
  makeSignStr,
  computeSignature,
  stripGatewayPrefix,
  PlatformAdapterError,
} from "../dist/index.js";

test("stripGatewayPrefix removes the /gateway/<service>/ segment for signing path", () => {
  assert.equal(stripGatewayPrefix("/gateway/mss-auth-acl-service/v1/certification/login_agent"), "/v1/certification/login_agent");
  assert.equal(stripGatewayPrefix("/v1/certification/login_agent"), "/v1/certification/login_agent");
  assert.equal(stripGatewayPrefix("/gateway/mss-auth-acl-service/"), "/");
});

test("mssw adapter builds SigV4-style Authorization header with HMAC-SHA256 signature", async () => {
  const requests = [];
  const adapter = new MSSWSessionAdapter(async (url, options) => {
    requests.push({
      url: String(url),
      method: options.method,
      authorization: options.headers.Authorization,
      agentNonce: options.headers["Agent-Nonce"],
      contentType: options.headers["Content-Type"],
      branchTag: options.headers["X-Branch-Tag"],
    });
    return new Response("", {
      status: 200,
      headers: { "set-cookie": "soc-token=jwt-value; Path=/; HttpOnly; Secure; SameSite=Strict" },
    });
  }, () => 1786361604);

  const credential = {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
    platform: "mssw", credentialFingerprint: "sha256:credential",
    credentials: {
      baseUrl: "https://sitmssw.soar.sangfor.com",
      sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
      ak: "agent_ak_test", sk: "secret-sk-value",
    },
  };

  const state = await adapter.refresh({
    credential,
    signal: new AbortController().signal,
  });

  assert.equal(requests[0].url, "https://sitmssw.soar.sangfor.com/gateway/mss-auth-acl-service/v1/certification/login_agent");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].contentType, "application/json");
  assert.equal(requests[0].branchTag, "MSSW-ADAPTER");
  assert.match(requests[0].agentNonce, /^[0-9a-f]{32}$/u);
  assert.match(
    requests[0].authorization,
    /^algorithm=HMAC-SHA256,Access=agent_ak_test,SignedHeaders=content-type;sign-date,Signature=[0-9A-F]+,sign-date=1786361604$/u,
  );

  // Verify signature matches the documented algorithm.
  const expectedCanonical = makeCanonicalRequest(
    "POST",
    "/v1/certification/login_agent",
    "",
    { "content-type": "application/json", "sign-date": "1786361604" },
    "",
  );
  const expectedSignStr = makeSignStr("HMAC-SHA256", "1786361604", expectedCanonical);
  const expectedSignature = computeSignature(expectedSignStr, "secret-sk-value");
  assert.equal(requests[0].authorization.includes(`Signature=${expectedSignature},`), true);

  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].name, "soc-token");
  assert.equal(state.cookies[0].value, "jwt-value");
  assert.equal(state.cookies[0].httpOnly, true);
  assert.equal(state.cookies[0].secure, true);
  assert.equal(state.cookies[0].sameSite, "Strict");
  assert.equal(state.storageState.cookies.length, 1);
  assert.equal(state.storageState.origins.length, 0);
  assert.equal(JSON.stringify(state).includes("secret-sk-value"), false);
});

test("mssw adapter fetches CSRF token before login when csrfEnabled is true", async () => {
  const requests = [];
  const adapter = new MSSWSessionAdapter(async (url, options) => {
    requests.push({ url: String(url), method: options.method, headers: options.headers, signal: options.signal });
    if (String(url).endsWith("/v1/certification/get_token")) {
      return new Response("", {
        status: 200,
        headers: { "set-cookie": "csrf_token=csrf-value; Path=/; HttpOnly" },
      });
    }
    return new Response("", {
      status: 200,
      headers: { "set-cookie": "soc-token=jwt-value; Path=/; HttpOnly" },
    });
  }, () => 1786361604);

  const credential = {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
    platform: "mssw", credentialFingerprint: "sha256:credential",
    credentials: {
      baseUrl: "https://sitmssw.soar.sangfor.com",
      sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
      ak: "agent_ak_test", sk: "secret-sk-value",
      csrfEnabled: true,
    },
  };

  const controller = new AbortController();
  await adapter.refresh({ credential, signal: controller.signal });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://sitmssw.soar.sangfor.com/v1/certification/get_token");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(requests[1].url, "https://sitmssw.soar.sangfor.com/gateway/mss-auth-acl-service/v1/certification/login_agent");
  assert.equal(requests[1].headers["x-csrftoken"], "csrf-value");
  assert.equal(requests[1].signal, controller.signal);
});

test("mssw adapter health validation returns false on 401 and clears cache for re-login", async () => {
  const requests = [];
  const adapter = new MSSWSessionAdapter(async (url, options) => {
    requests.push({ url: String(url), method: options.method, cookie: options.headers.Cookie });
    return new Response("ok", { status: requests.length === 1 ? 200 : 401 });
  });
  const credential = {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
    platform: "mssw", credentialFingerprint: "sha256:credential",
    credentials: {
      baseUrl: "https://sitmssw.soar.sangfor.com",
      sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
      healthEndpoint: "/v1/rtt",
      ak: "agent_ak_test", sk: "secret-sk-value",
    },
  };
  const state = {
    cookies: [{ name: "soc-token", value: "jwt-value", domain: "sitmssw.soar.sangfor.com", path: "/" }],
    storageState: { cookies: [], origins: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  assert.equal(await adapter.validate({ credential, signal: new AbortController().signal, state }), true);
  assert.equal(await adapter.validate({ credential, signal: new AbortController().signal, state }), false);
  assert.equal(requests[0].url, "https://sitmssw.soar.sangfor.com/v1/rtt");
  assert.equal(requests[0].cookie, "soc-token=jwt-value");
});

test("mssw adapter rejects 401 login as authentication failure", async () => {
  const adapter = new MSSWSessionAdapter(async () => new Response("", { status: 401 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed
      && error.reason === "auth_failed",
  );
});

test("mssw adapter reports a clear message when login returns no cookies", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.reason === "service_error"
      && error.message === "platform login succeeded without session cookies",
  );
});

test("mssw adapter rejects credentials missing ak/sk", async () => {
  const adapter = new MSSWSessionAdapter(async () => new Response("", { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: { baseUrl: "https://sitmssw.soar.sangfor.com", sessionEndpoint: "/login" },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === true
      && error.retryable === false
      && error.reason === "missing_credential",
  );
});

// MSSW login_agent handler 永远返回 HTTP 200，业务错误码在 JSON body 的 code 字段。
// 下面用例覆盖各业务码 → PlatformAdapterError(authenticationFailed, retryable, reason, message, businessCode) 映射，
// message 必须原样透传服务端 body 的 msg 字段。与 mss-auth/internal/types/constant.go 对齐。
test("mssw adapter treats body code:9348 as authentication failure (not retryable)", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 9348, msg: "认证失败", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === true
      && error.retryable === false
      && error.reason === "auth_failed"
      && error.businessCode === 9348
      && error.message === "认证失败",
  );
});

test("mssw adapter treats body code:9001 (ParamsErr) as authentication failure", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 9001, msg: "params error", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === true
      && error.retryable === false
      && error.reason === "params_error"
      && error.businessCode === 9001
      && error.message === "params error",
  );
});

test("mssw adapter treats body code:9000 (ServiceErr) as retryable", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 9000, msg: "service error", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === false
      && error.retryable === true
      && error.reason === "service_error"
      && error.businessCode === 9000
      && error.message === "service error",
  );
});

test("mssw adapter treats body code:12000 (AccountLocked) as retryable", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 12000, msg: "account locked", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === false
      && error.retryable === true
      && error.reason === "account_locked"
      && error.businessCode === 12000
      && error.message === "account locked",
  );
});

test("mssw adapter treats body code:12001 (RateLimited) as retryable", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 12001, msg: "rate limited", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === false
      && error.retryable === true
      && error.reason === "rate_limited"
      && error.businessCode === 12001
      && error.message === "rate limited",
  );
});

test("mssw adapter treats unknown body code as retryable service error and forwards server msg", async () => {
  const adapter = new MSSWSessionAdapter(async () =>
    new Response(JSON.stringify({ code: 99999, msg: "unknown failure", data: [] }), { status: 200 }));
  await assert.rejects(
    () => adapter.refresh({
      credential: {
        humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "mssw-query",
        platform: "mssw", credentialFingerprint: "sha256:credential",
        credentials: {
          baseUrl: "https://sitmssw.soar.sangfor.com",
          sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
          ak: "agent_ak_test", sk: "secret-sk-value",
        },
      },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof PlatformAdapterError
      && error.authenticationFailed === false
      && error.retryable === true
      && error.reason === "unknown"
      && error.businessCode === 99999
      && error.message === "unknown failure",
  );
});

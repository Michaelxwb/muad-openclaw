import assert from "node:assert/strict";
import test from "node:test";

import {
  postIngestBundle,
  formatConsoleError,
} from "../../../skills/skill-upload/scripts/upload-skill.mjs";

test("upload ingest uses the fixed contract path regardless of the baseURL prefix", async () => {
  const calls = [];
  const result = await postIngestBundle({
    consoleUrl: "http://console.internal:8080/internal/v1",
    token: "pod-token",
    agentId: "alice",
    skillName: "xdr-query",
    bundleBase64: "c3RhZ2luZw==",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://console.internal:8080/internal/v1/skills/private/ingest");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer pod-token");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.agentId, "alice");
  assert.equal(body.skillName, undefined); // skillName 不入请求体，仅用于打包
  assert.equal(body.bundle, "c3RhZ2luZw==");
});

test("upload ingest keeps the contract path when the baseURL carries no /internal/v1 prefix", async () => {
  const calls = [];
  await postIngestBundle({
    consoleUrl: "http://console.internal:8080",
    token: "t",
    agentId: "alice",
    skillName: "x",
    bundleBase64: "b64",
    fetch: async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(calls[0], "http://console.internal:8080/internal/v1/skills/private/ingest");
});

test("upload ingest rejects on fetch failure so the caller can emit a stable message", async () => {
  await assert.rejects(
    () => postIngestBundle({
      consoleUrl: "http://console.internal:8080",
      token: "t",
      agentId: "alice",
      skillName: "x",
      bundleBase64: "b64",
      fetch: async () => { throw new TypeError("fetch failed"); },
    }),
    (error) => error instanceof TypeError && /fetch failed/u.test(error.message),
  );
});

test("upload ingest aborts after the configured timeout", async () => {
  await assert.rejects(
    () => postIngestBundle({
      consoleUrl: "http://console.internal:8080",
      token: "t",
      agentId: "alice",
      skillName: "x",
      bundleBase64: "b64",
      timeoutMs: 20,
      fetch: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    }),
    (error) => error.name === "AbortError",
  );
});

test("upload ingest reports HTTP failures as a non-ok result with the console text", async () => {
  const result = await postIngestBundle({
    consoleUrl: "http://console.internal:8080",
    token: "t",
    agentId: "alice",
    skillName: "x",
    bundleBase64: "b64",
    fetch: async () => new Response('{"message":"skill already exists"}', { status: 409 }),
  });
  assert.equal(result.ok, false);
  assert.match(formatConsoleError(result.text), /skill already exists/u);
});

test("formatConsoleError extracts message/detail/requestId from the console envelope", () => {
  assert.equal(formatConsoleError('{"message":"bad","detail":"detail","requestId":"r-1"}'), "bad\n具体原因：detail\nrequestId: r-1");
  assert.equal(formatConsoleError("plain text"), "plain text");
  assert.equal(formatConsoleError(""), "控制台未返回错误详情");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  BindingClient,
  BindingClientError,
  POD_SERVICE_TOKEN_FILE,
} from "../src/binding-client.mjs";

test("binding client reads fixed Pod token and posts the activation context", async () => {
  const calls = [];
  const tokenPaths = [];
  const client = new BindingClient({
    baseURL: "http://console.internal:8080/internal/v1",
    readToken: async (filePath) => { tokenPaths.push(filePath); return " pod-token\n"; },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, { code: 0, data: { identityBound: true, configStatus: "applying" } });
    },
  });
  const request = activation();
  const result = await client.activate(request);

  assert.equal(result.identityBound, true);
  assert.deepEqual(tokenPaths, [POD_SERVICE_TOKEN_FILE]);
  assert.equal(calls[0].url, "http://console.internal:8080/internal/v1/bindings/activate");
  assert.equal(calls[0].options.headers.Authorization, "Bearer pod-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
});

test("binding client returns stable redacted errors", async () => {
  const code = "MUAD-23456789";
  const client = new BindingClient({
    baseURL: "http://console.internal:8080",
    readToken: async () => "pod-token",
    fetch: async () => response(409, { code: 40903, message: `${code} was used` }),
  });
  await assert.rejects(
    () => client.activate(activation()),
    (error) => error instanceof BindingClientError && error.code === "invalid_binding" &&
      !String(error).includes(code),
  );
  assert.throws(
    () => new BindingClient({ baseURL: "http://console", tokenFile: "/tmp/token" }),
    (error) => error instanceof BindingClientError && error.code === "service_unavailable",
  );
});

function activation() {
  return {
    code: "MUAD-23456789", channel: "wecom", openclawChannel: "wecom",
    accountId: "default", externalId: "sender", externalIdType: "wecom_userid",
    peerKind: "direct",
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), { status });
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createInsecureFetch, createSecureFetch } from "../dist/index.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Starts an HTTPS server backed by the throwaway self-signed fixture cert. The client
// (createInsecureFetch or the strict global fetch) verifies that certificate.
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(
      {
        key: readFileSync(path.join(fixtureDir, "insecure-fetch-test-key.pem")),
        cert: readFileSync(path.join(fixtureDir, "insecure-fetch-test-cert.pem")),
      },
      handler,
    );
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("insecure fetch accepts a self-signed cert and reassembles a fetch-shaped Response", async () => {
  let received = null;
  const server = await startServer((req, res) => {
    received = { headers: req.headers };
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": ["soc-token=a; Path=/; HttpOnly", "other=b; Path=/"],
    });
    res.end(JSON.stringify({ code: 0, msg: "ok" }));
  });
  try {
    const port = server.address().port;
    const res = await createInsecureFetch()(`https://127.0.0.1:${port}/gateway/x/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(await res.text(), '{"code":0,"msg":"ok"}');
    assert.deepEqual(res.headers.getSetCookie(), ["soc-token=a; Path=/; HttpOnly", "other=b; Path=/"]);
    // Empty string body mirrors the mssw login POST: length-delimited, not chunked.
    assert.equal(received.headers["content-length"], "0");
    assert.equal(received.headers["transfer-encoding"], undefined);
  } finally {
    server.close();
  }
});

test("insecure fetch sends Content-Length for a string body (no chunked transfer)", async () => {
  let received = null;
  const server = await startServer((req, res) => {
    received = { headers: req.headers, body: "" };
    req.on("data", (chunk) => { received.body += chunk; });
    req.on("end", () => { res.writeHead(200); res.end("ok"); });
  });
  try {
    const port = server.address().port;
    const res = await createInsecureFetch()(`https://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    assert.equal(res.status, 200);
    assert.equal(received.headers["content-length"], "7");
    assert.equal(received.headers["transfer-encoding"], undefined);
    assert.equal(received.body, '{"a":1}');
  } finally {
    server.close();
  }
});

test("the strict global fetch rejects the same self-signed cert", async () => {
  const server = await startServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const port = server.address().port;
    await assert.rejects(() => fetch(`https://127.0.0.1:${port}/`));
  } finally {
    server.close();
  }
});

test("createSecureFetch rejects the same self-signed cert (strict TLS kept)", async () => {
  const server = await startServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const port = server.address().port;
    await assert.rejects(() => createSecureFetch()(`https://127.0.0.1:${port}/`));
  } finally {
    server.close();
  }
});

// 真实环境走 http（mssw: http://mssp-nginx.mss-pro:8200, mssp: http://soar-inner.sangfor.com.cn:30001），
// 网关按 Host 头虚拟主机路由/鉴权。node fetch 必须能连 http:// 并把自定义 Host 头真实送达。
test("node fetch connects over plain http and transmits a custom Host header", async () => {
  let received = null;
  const server = createHttpServer((req, res) => {
    received = { headers: req.headers };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "ok" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const res = await createInsecureFetch()(`http://127.0.0.1:${port}/gateway/mssw/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "mssw.sangfor.com.cn" },
      body: "",
    });
    assert.equal(res.status, 200);
    assert.equal(received.headers.host, "mssw.sangfor.com.cn");
    assert.equal(received.headers["content-length"], "0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("node fetch transmits a custom Host header over https too", async () => {
  let received = null;
  const server = await startServer((req, res) => {
    received = { headers: req.headers };
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const port = server.address().port;
    const res = await createInsecureFetch()(`https://127.0.0.1:${port}/gateway/mssw/login`, {
      method: "POST",
      headers: { Host: "mssw.sangfor.com.cn" },
      body: "",
    });
    assert.equal(res.status, 200);
    assert.equal(received.headers.host, "mssw.sangfor.com.cn");
  } finally {
    server.close();
  }
});

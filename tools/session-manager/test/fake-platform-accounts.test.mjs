import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("fake business platform accepts every configured account at once", async (t) => {
  const python = process.env.PYTHON || "python3";
  const version = await spawnResult(python, ["--version"]);
  if (version.status !== 0) {
    t.skip(`${python} is required for fake business platform test`);
    return;
  }

  const script = fileURLToPath(new URL("../../fake-business-platform/server.py", import.meta.url));
  const server = await startFakePlatform(python, [script, "--host", "127.0.0.1", "--port", "0"]);
  t.after(() => stopServer(server.child));
  const baseUrl = server.baseUrl;

  const demoLogin = await login(baseUrl, { username: "demo", password: "demo-pass" });
  assert.equal(demoLogin.status, 200);
  assert.equal(demoLogin.body.code, 0);
  assert.equal(demoLogin.body.user, "demo");

  const michaelLogin = await login(baseUrl, { username: "michael", password: "michael-pass" });
  assert.equal(michaelLogin.status, 200);
  assert.equal(michaelLogin.body.code, 0);
  assert.equal(michaelLogin.body.user, "michael");

  // /login always answers 200; failures carry a business code in the body.
  const wrongPassword = await login(baseUrl, { username: "michael", password: "wrong" });
  assert.equal(wrongPassword.status, 200);
  assert.equal(wrongPassword.body.code, 1002);
  assert.equal(wrongPassword.setCookie, "");

  const unknownUser = await login(baseUrl, { username: "nobody", password: "demo-pass" });
  assert.equal(unknownUser.status, 200);
  assert.equal(unknownUser.body.code, 1002);

  // Account-state prefixes answer their own business code even with a valid password.
  const lockedLogin = await login(baseUrl, { username: "locked-alice", password: "demo-pass" });
  assert.equal(lockedLogin.body.code, 1003);
  const rateLimitedLogin = await login(baseUrl, { username: "ratelimited-bob", password: "demo-pass" });
  assert.equal(rateLimitedLogin.body.code, 1004);
  const serviceErrorLogin = await login(baseUrl, { username: "serviceerr-carol", password: "demo-pass" });
  assert.equal(serviceErrorLogin.body.code, 1005);

  // /api/me returns the session's owner, so a leaked session reveals its account.
  const demoMe = await me(baseUrl, demoLogin.setCookie);
  assert.equal(demoMe.body.user, "demo");
  const michaelMe = await me(baseUrl, michaelLogin.setCookie);
  assert.equal(michaelMe.body.user, "michael");
});

async function login(baseUrl, payload) {
  const response = await fetch(new URL("/login", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const body = await response.json();
  return { status: response.status, body, setCookie };
}

async function me(baseUrl, setCookie) {
  const response = await fetch(new URL("/api/me", baseUrl), {
    headers: { Cookie: cookieName(setCookie) },
  });
  return { status: response.status, body: await response.json() };
}

function cookieName(setCookie) {
  return setCookie.split(";", 1)[0];
}

function startFakePlatform(python, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`fake platform did not start: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      clearTimeout(timer);
      try {
        const value = JSON.parse(buffer.slice(0, lineEnd));
        if (value.status !== "ready" || typeof value.baseUrl !== "string") throw new Error(`invalid ready line: ${buffer.slice(0, lineEnd)}`);
        resolve({ child, baseUrl: value.baseUrl });
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake platform exited before ready: ${code} ${stderr}`));
    });
  });
}

function spawnResult(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.once("exit", (status) => resolve({ status }));
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MSSWSessionAdapter } from "../dist/index.js";

const SERVER = fileURLToPath(new URL("../../fake-business-platform/server.py", import.meta.url));
const LOGIN_PATH = "/gateway/mss-auth-acl-service/v1/certification/login_agent";
const HEALTH_PATH = "/v1/rtt";

function startFakeMssw() {
  const child = spawn("python3", [SERVER, "--platform", "mssw", "--port", "0"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake MSSW did not start")), 10_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve({ child, ready: JSON.parse(line) });
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", reject);
  });
}

test("MSSWSessionAdapter logs in, validates and exposes the request profile against fake MSSW", async (t) => {
  const { child, ready } = await startFakeMssw();
  t.after(() => child.kill());
  const credential = {
    humanUserId: "user-smoke",
    podId: "pod-smoke",
    agentId: "agent-smoke",
    skillName: "mssw-platform-smoke",
    platform: "mssw",
    credentialFingerprint: "sha256:smoke",
    credentials: {
      baseUrl: ready.baseUrl,
      sessionEndpoint: LOGIN_PATH,
      healthEndpoint: HEALTH_PATH,
      ak: ready.ak,
      sk: ready.sk,
      csrfEnabled: true,
      sessionTtlSeconds: 900,
    },
  };
  const adapter = new MSSWSessionAdapter();
  const state = await adapter.refresh({ credential, signal: AbortSignal.timeout(5_000) });
  assert.ok(state.cookies.some((cookie) => cookie.name === "fake_session"));
  assert.ok(state.cookies.some((cookie) => cookie.name === "csrf_token"));
  assert.equal(await adapter.validate({ credential, state, signal: AbortSignal.timeout(5_000) }), true);

  const profile = adapter.requestProfile(credential);
  assert.equal(profile.baseUrl, ready.baseUrl);
  assert.deepEqual(profile.csrf, [{ cookie: "csrf_token", header: "x-csrf-token" }]);
  assert.equal(profile.traceHeader, "Traceid");
});

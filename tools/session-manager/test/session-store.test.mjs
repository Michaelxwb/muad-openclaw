import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdapterRegistry,
  MSSPSessionAdapter,
  MSSWSessionAdapter,
  SessionService,
  SessionStore,
} from "../dist/index.js";
import { runCLI } from "../dist/cli.js";

const context = { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" };
const skillName = "request-profile-skill";

test("requestProfile: mssw profile exposes csrf mapping and host without changing legacy fields", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const credentials = {
    baseUrl: "http://inner.example.com:8080",
    sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
    ak: "agent-ak-value",
    sk: "agent-sk-value",
    hostHeader: { Host: "inner.sangfor.com.cn" },
    referer: "http://inner.example.com/index.html",
  };
  const state = sessionState("mssw-cookie");
  await store.write(scopedCredential("mssw", credentials), state);

  const result = await runCLI(
    ["get-state", "--skill-name", skillName],
    {
      MUAD_SESSION_KEY: context.sessionKey,
      MUAD_CONSOLE_INTERNAL_URL: "http://console:8080",
    },
    { resolve: async () => resolvedCredential([{ platform: "mssw", credentials }]) },
    { store, adapters: adapterRegistry(), log: () => {} },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal("requestProfile" in stdout, false);
  assert.deepEqual(Object.keys(stdout.platforms[0]).sort(), [
    "credentialFingerprint", "expiresAt", "platform", "source",
  ]);

  const file = readSessionFile(stdout.sessionStateFile);
  const section = file.platforms.mssw;
  assert.deepEqual(section.requestProfile, {
    baseUrl: credentials.baseUrl,
    hostHeader: { Host: "inner.sangfor.com.cn" },
    referer: credentials.referer,
    csrf: [{ cookie: "csrf_token", header: "x-csrf-token" }],
    staticHeaders: {},
    traceHeader: "Traceid",
    extraAllowed: true,
  });
  assert.deepEqual(section.cookies, state.cookies);
  assert.deepEqual(section.storageState, state.storageState);
  assert.equal(section.expiresAt, state.expiresAt);
  assert.equal(section.credentialFingerprint, "sha256:mssw");
  assert.deepEqual(Object.keys(section).sort(), [
    "cookies", "credentialFingerprint", "expiresAt", "platform",
    "requestProfile", "source", "storageState",
  ]);
  assert.equal(statSync(stdout.sessionStateFile).mode & 0o777, 0o600);
});

test("requestProfile: mssp profile takes static headers and timezone from the credential", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const credentials = {
    baseUrl: "http://mssp.example.com:8080",
    sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
    ak: "agent-ak-value",
    sk: "agent-sk-value",
    hostHeader: { Host: "mssp.sangfor.com.cn" },
    referer: "http://mssp.example.com/index.html",
    csrfToken: "credential-csrf-token",
    timezone: "+08:00",
  };
  await store.write(scopedCredential("mssp", credentials), sessionState("mssp-cookie"));

  const result = await getState(store, [{ platform: "mssp", credentials }]);
  const section = readSessionFile(result.sessionStateFile).platforms.mssp;

  assert.deepEqual(section.requestProfile, {
    baseUrl: credentials.baseUrl,
    hostHeader: { Host: "mssp.sangfor.com.cn" },
    referer: credentials.referer,
    csrf: [{ cookie: "csrf_token", header: "x-csrf-token" }],
    staticHeaders: { "X-CSRFToken": "credential-csrf-token", timezone: "+08:00" },
    traceHeader: "Traceid",
    extraAllowed: true,
  });
  assert.equal(section.requestProfile.staticHeaders["x-mssw-company-id"], undefined);
});

test("requestProfile: mssw and mssp sections keep their own profile when served together", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const msswCredentials = {
    baseUrl: "http://mssw.example.com:8080",
    sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
    ak: "mssw-ak-value",
    sk: "mssw-sk-value",
    hostHeader: { Host: "mssw.sangfor.com.cn" },
    referer: "http://mssw.example.com/index.html",
  };
  const msspCredentials = {
    baseUrl: "http://mssp.example.com:8080",
    sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
    ak: "mssp-ak-value",
    sk: "mssp-sk-value",
    hostHeader: { Host: "mssp.sangfor.com.cn" },
    referer: "http://mssp.example.com/index.html",
    csrfToken: "mssp-credential-csrf",
    timezone: "+08:00",
  };
  await store.write(scopedCredential("mssw", msswCredentials), sessionState("mssw-cookie"));
  await store.write(scopedCredential("mssp", msspCredentials), sessionState("mssp-cookie"));

  const result = await getState(store, [
    { platform: "mssw", credentials: msswCredentials },
    { platform: "mssp", credentials: msspCredentials },
  ]);
  const platforms = readSessionFile(result.sessionStateFile).platforms;

  assert.deepEqual(platforms.mssw.requestProfile.hostHeader, { Host: "mssw.sangfor.com.cn" });
  assert.deepEqual(platforms.mssp.requestProfile.hostHeader, { Host: "mssp.sangfor.com.cn" });
  assert.deepEqual(platforms.mssw.requestProfile.staticHeaders, {});
  assert.deepEqual(platforms.mssp.requestProfile.staticHeaders, {
    "X-CSRFToken": "mssp-credential-csrf",
    timezone: "+08:00",
  });
  assert.equal(platforms.mssw.requestProfile.baseUrl, msswCredentials.baseUrl);
  assert.equal(platforms.mssp.requestProfile.baseUrl, msspCredentials.baseUrl);
  assert.equal(platforms.mssw.cookies[0].value, "mssw-cookie");
  assert.equal(platforms.mssp.cookies[0].value, "mssp-cookie");
});

test("requestProfile: legacy credentials fall back and log a diagnostic instead of failing", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const credentials = {
    baseUrl: "http://legacy-mssp.example.com:8080",
    sessionEndpoint: "/gateway/mss-auth-acl-service/v1/certification/login_agent",
    ak: "agent-ak-value",
    sk: "agent-sk-value",
  };
  const state = sessionState("legacy-cookie");
  await store.write(scopedCredential("mssp", credentials), state);
  const logs = [];

  const result = await getState(store, [{ platform: "mssp", credentials }], logs);
  const section = readSessionFile(result.sessionStateFile).platforms.mssp;

  assert.deepEqual(section.requestProfile.csrf, [{ cookie: "csrf_token", header: "x-csrf-token" }]);
  assert.deepEqual(section.requestProfile.staticHeaders, {});
  assert.equal(section.requestProfile.traceHeader, "Traceid");
  assert.equal(section.requestProfile.extraAllowed, true);
  assert.equal("referer" in section.requestProfile, false);
  assert.deepEqual(section.cookies, state.cookies);
  assert.equal(
    logs.some((line) => line.includes("platform=mssp") &&
      line.includes("request profile fallback") && line.includes("staticHeaders")),
    true,
    logs.join("\n"),
  );
});

test("requestProfile: adapters without a profile get the default no-csrf profile", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const credentials = { apiKey: "api-key-value", baseUrl: "https://xdr.internal" };
  await store.write(scopedCredential("xdr", credentials), sessionState("xdr-cookie"));
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => sessionState("xdr-cookie"),
  }]);
  const service = new SessionService(
    { resolve: async () => resolvedCredential([{ platform: "xdr", credentials }]) },
    { store, adapters, adapterTimeoutMs: 1_000, log: () => {} },
  );

  const result = await service.getState(context, skillName);
  const section = readSessionFile(result.sessionStateFile).platforms.xdr;

  assert.deepEqual(section.requestProfile, {
    baseUrl: credentials.baseUrl,
    hostHeader: {},
    csrf: [],
    staticHeaders: {},
    traceHeader: "Traceid",
    extraAllowed: true,
  });
});

function getState(store, platforms, logs = []) {
  const adapters = adapterRegistry((line) => logs.push(line));
  const service = new SessionService(
    { resolve: async () => resolvedCredential(platforms) },
    { store, adapters, adapterTimeoutMs: 1_000, log: (line) => logs.push(line) },
  );
  return service.getState(context, skillName);
}

function adapterRegistry(log = () => {}) {
  return new AdapterRegistry([
    new MSSWSessionAdapter(undefined, undefined, undefined, undefined, log),
    new MSSPSessionAdapter(undefined, undefined, log),
  ]);
}

function resolvedCredential(platforms) {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName,
    platforms: platforms.map((entry) => ({
      platform: entry.platform,
      credentialFingerprint: `sha256:${entry.platform}`,
      credentials: entry.credentials,
    })),
  };
}

function scopedCredential(platform, credentials) {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName,
    platform,
    credentialFingerprint: `sha256:${platform}`,
    credentials,
  };
}

function sessionState(cookieValue) {
  const cookies = [{ name: "sid", value: cookieValue, domain: ".internal", path: "/" }];
  return {
    cookies,
    storageState: { cookies, origins: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function readSessionFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "session-manager-request-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdapterRegistry,
  SessionManagerError,
  SessionStore,
} from "../dist/index.js";
import { runCLI } from "../dist/cli.js";

const env = {
  MUAD_AGENT_ID: "alice",
  MUAD_SESSION_KEY: "agent:alice:wecom:direct:user-a",
  MUAD_CONSOLE_INTERNAL_URL: "http://console:8080",
};

test("get-state uses trusted env context and never writes API keys", async () => {
  const requests = [];
  const resolver = {
    resolve: async (request) => {
      requests.push(request);
      return resolvedCredential("api-key-must-not-leak");
    },
  };
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"], env, resolver, sessionOptions(root),
  );
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("api-key-must-not-leak"), false);
  const output = JSON.parse(result.stdout);
  assert.deepEqual({
    ...output,
    cookiesPath: "<cookies>",
    storageStatePath: "<storageState>",
    expiresAt: "<expiresAt>",
  }, {
    version: 1,
    status: "ready",
    source: "refresh",
    platform: "xdr",
    cookiesPath: "<cookies>",
    storageStatePath: "<storageState>",
    expiresAt: "<expiresAt>",
    credentialFingerprint: "sha256:credential",
  });
  assert.match(output.cookiesPath, /alice\/session-store\/xdr\/default\/cookies\.json$/);
  assert.equal(requests[0].agentId, "alice");
  assert.equal(requests[0].skillName, "xdr-query");
  assert.equal(requests[0].platform, undefined);
  assert.equal("sessionKey" in requests[0], false);
});

test("get-state forwards an optional platform selector to the Resolver", async () => {
  const requests = [];
  const resolver = {
    resolve: async (request) => {
      requests.push(request);
      return resolvedCredential("api-key", request.platform ?? "xdr");
    },
  };
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query", "--platform", "mssw"],
    env,
    resolver,
    sessionOptions(root),
  );
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(requests[0].platform, "mssw");
});

test("cross-agent and unknown arguments are rejected before Resolver access", async () => {
  let calls = 0;
  const resolver = { resolve: async () => { calls += 1; return resolvedCredential("secret"); } };
  const result = await runCLI(["get-state", "--skill-name", "xdr-query", "--agent-id", "bob"], env, resolver);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "invalid_arguments");
  assert.equal(calls, 0);

  const badPlatform = await runCLI(["get-state", "--skill-name", "xdr-query", "--platform", "bad-name"], env, resolver);
  assert.equal(badPlatform.exitCode, 2);
  assert.equal(JSON.parse(badPlatform.stderr).error.code, "invalid_arguments");
  assert.equal(calls, 0);
});

test("missing trusted context and Resolver failures use stable redacted stderr", async () => {
  const missing = await runCLI(["get-state", "--skill-name", "xdr-query"], {}, { resolve: async () => resolvedCredential("x") });
  assert.equal(missing.exitCode, 3);
  assert.equal(JSON.parse(missing.stderr).error.code, "invalid_context");

  const resolver = { resolve: async () => { throw new SessionManagerError("not_configured"); } };
  const failed = await runCLI(["get-state", "--skill-name", "xdr-query"], env, resolver);
  assert.equal(failed.exitCode, 10);
  assert.equal(failed.stdout, "");
  assert.deepEqual(JSON.parse(failed.stderr).error, {
    code: "not_configured",
    message: "platform credential is not configured",
    retryable: false,
  });
});

test("npm-style symlink executes the CLI main module", () => {
  const root = mkdtempSync(join(tmpdir(), "session-manager-bin-"));
  const link = join(root, "session-manager");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  symlinkSync(cli, link);
  const result = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: 1 });
});

function resolvedCredential(apiKey, platform = "xdr") {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "xdr-query",
    platform,
    credentialFingerprint: "sha256:credential",
    credentials: { apiKey, baseUrl: "https://xdr.internal" },
  };
}

function sessionOptions(rootDir) {
  return {
    store: new SessionStore({ rootDir }),
    adapters: new AdapterRegistry([{
      platform: "xdr",
      refresh: async () => sessionState(),
    }, {
      platform: "mssw",
      refresh: async () => sessionState(),
    }]),
  };
}

function sessionState() {
  const cookies = [{ name: "sid", value: "cookie-value", domain: ".internal", path: "/" }];
  return {
    cookies,
    storageState: { cookies, origins: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "session-manager-cli-"));
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdapterRegistry,
  PlatformAdapterError,
  SessionManagerError,
  SessionStore,
} from "../dist/index.js";
import { runCLI } from "../dist/cli.js";

const env = {
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
    sessionStateFile: "<sessionStateFile>",
    platforms: output.platforms.map((p) => ({ ...p, expiresAt: "<expiresAt>" })),
  }, {
    version: 1,
    status: "ready",
    source: "refresh",
    sessionStateFile: "<sessionStateFile>",
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "xdr-query",
    platforms: [{
      platform: "xdr",
      source: "refresh",
      expiresAt: "<expiresAt>",
      credentialFingerprint: "sha256:credential",
    }],
  });
  assert.match(output.sessionStateFile, /alice\/session-store\/xdr-query\.session\.json$/);
  assert.equal(requests[0].agentId, "alice");
  assert.equal(requests[0].skillName, "xdr-query");
  assert.equal(requests[0].platform, undefined);
  assert.equal("sessionKey" in requests[0], false);
  assert.equal(requests[0].purpose, "session_get_state");
});

test("get-state fails closed when MUAD_SESSION_KEY is missing", async () => {
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    { MUAD_AGENT_ID: "alice", MUAD_CONSOLE_INTERNAL_URL: "http://console:8080" },
    { resolve: async () => resolvedCredential("secret") },
    sessionOptions(root),
  );
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.exitCode, 3);
  assert.equal(JSON.parse(result.stderr).error.code, "invalid_context");
});

test("cross-agent and unknown arguments are rejected before Resolver access", async () => {
  let calls = 0;
  const resolver = { resolve: async () => { calls += 1; return resolvedCredential("secret"); } };
  const result = await runCLI(["get-state", "--skill-name", "xdr-query", "--agent-id", "bob"], env, resolver);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "invalid_arguments");
  assert.equal(calls, 0);

  const legacyPlatform = await runCLI(["get-state", "--skill-name", "xdr-query", "--platform", "mssw"], env, resolver);
  assert.equal(legacyPlatform.exitCode, 2);
  assert.equal(JSON.parse(legacyPlatform.stderr).error.code, "invalid_arguments");
  assert.equal(calls, 0);
});

test("forged MUAD_AGENT_ID is ignored; identity derives only from MUAD_SESSION_KEY", async () => {
  const requests = [];
  const resolver = {
    resolve: async (request) => {
      requests.push(request);
      return resolvedCredential("secret");
    },
  };
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    { ...env, MUAD_AGENT_ID: "bob" },
    resolver,
    sessionOptions(root),
  );
  rmSync(root, { recursive: true, force: true });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agentId, "alice");
  assert.equal(requests[0].agentId, "alice");
});

test("cross-agent session key cannot read another agent's state", async () => {
  const requests = [];
  const resolver = {
    resolve: async (request) => {
      requests.push(request);
      return resolvedCredential("secret");
    },
  };
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    { ...env, MUAD_SESSION_KEY: "agent:bob:wecom:direct:user-b" },
    resolver,
  );
  assert.equal(result.exitCode, 12);
  assert.equal(JSON.parse(result.stderr).error.code, "credential_service_unavailable");
  assert.equal(requests.length, 1);
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
    reason: "unknown",
  });
});

test("adapter failures include platform attribution in stable stderr", async () => {
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    env,
    { resolve: async () => resolvedCredential("secret") },
    {
      store: new SessionStore({ rootDir: root }),
      adapters: new AdapterRegistry([{
        platform: "xdr",
        refresh: async () => {
          throw new PlatformAdapterError(false, true, "network", "network unavailable");
        },
      }]),
    },
  );
  rmSync(root, { recursive: true, force: true });

  assert.equal(result.exitCode, 13);
  assert.deepEqual(JSON.parse(result.stderr).error, {
    code: "adapter_failed",
    message: "network unavailable",
    retryable: true,
    reason: "network",
    platform: "xdr",
  });
});

test("retryable browser apply failures do not block CLI cookie state", async () => {
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    env,
    { resolve: async () => resolvedCredential("secret") },
    {
      ...sessionOptions(root),
      browserApplier: {
        apply: async () => {
          throw new SessionManagerError("browser_apply_failed", true);
        },
      },
    },
  );
  rmSync(root, { recursive: true, force: true });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).platforms[0].browser, undefined);
});

test("non-retryable browser apply failures include platform attribution in stable stderr", async () => {
  const root = temporaryRoot();
  const result = await runCLI(
    ["get-state", "--skill-name", "xdr-query"],
    env,
    { resolve: async () => resolvedCredential("secret") },
    {
      ...sessionOptions(root),
      browserApplier: {
        apply: async () => {
          throw new SessionManagerError("browser_apply_failed", false);
        },
      },
    },
  );
  rmSync(root, { recursive: true, force: true });

  assert.equal(result.exitCode, 18);
  assert.equal(JSON.parse(result.stderr).error.platform, "xdr");
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

function resolvedCredential(apiKey) {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "xdr-query",
    platforms: [{
      platform: "xdr",
      credentialFingerprint: "sha256:credential",
      credentials: { apiKey, baseUrl: "https://xdr.internal" },
    }],
  };
}

function sessionOptions(rootDir) {
  return {
    store: new SessionStore({ rootDir }),
    adapters: new AdapterRegistry([{
      platform: "xdr",
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

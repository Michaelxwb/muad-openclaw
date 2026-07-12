import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdapterRegistry,
  PlatformAdapterError,
  SessionManagerError,
  SessionService,
  SessionStore,
} from "../dist/index.js";

test("session cache validates owner and both fingerprints without persisting API key", async (t) => {
  const harness = makeHarness(t);
  const first = await harness.service.getState(context, "xdr");
  const second = await harness.service.getState(context, "xdr");
  assert.equal(first.source, "refresh");
  assert.equal(second.source, "cache");
  assert.equal(harness.refreshes(), 1);
  assertPrivateFiles(first, harness.root, "api-key-memory-only");

  harness.setCredential({ credentialFingerprint: "sha256:credential-2" });
  await harness.service.getState(context, "xdr");
  assert.equal(harness.refreshes(), 2);

  harness.setCredential({ platformConfigFingerprint: "sha256:platform-2" });
  await harness.service.getState(context, "xdr");
  assert.equal(harness.refreshes(), 3);

  harness.setCredential({ podId: "pod-b" });
  await harness.service.getState(context, "xdr");
  assert.equal(harness.refreshes(), 4);

  const meta = JSON.parse(readFileSync(harness.paths.meta, "utf8"));
  writeFileSync(harness.paths.meta, JSON.stringify({ ...meta, humanUserId: "other-user" }));
  await harness.service.getState(context, "xdr");
  assert.equal(harness.refreshes(), 5);
});

test("not configured and disabled Resolver results invalidate existing state", async (t) => {
  for (const code of ["not_configured", "platform_disabled"]) {
    const harness = makeHarness(t);
    await harness.service.getState(context, "xdr");
    harness.setResolveError(new SessionManagerError(code));
    await assert.rejects(
      () => harness.service.getState(context, "xdr"),
      (error) => error instanceof SessionManagerError && error.code === code,
    );
    assert.equal(existsSync(harness.paths.meta), false);
    assert.equal(existsSync(harness.paths.cookies), false);
  }
});

test("Resolver cannot redirect trusted context to another agent", async (t) => {
  const harness = makeHarness(t);
  harness.setCredential({ agentId: "bob", humanUserId: "user-b" });
  await assert.rejects(
    () => harness.service.getState(context, "xdr"),
    (error) => error instanceof SessionManagerError && error.code === "credential_service_unavailable",
  );
  assert.equal(harness.refreshes(), 0);
});

test("adapter authentication failure clears the old session", async (t) => {
  const harness = makeHarness(t);
  await harness.service.getState(context, "xdr");
  harness.setCredential({ credentialFingerprint: "sha256:rotated" });
  harness.setAdapterError(new PlatformAdapterError(true));

  await assert.rejects(
    () => harness.service.getState(context, "xdr"),
    (error) => error instanceof SessionManagerError && error.code === "adapter_failed",
  );
  assert.equal(existsSync(harness.paths.meta), false);
  assert.equal(existsSync(harness.paths.storageState), false);
});

test("adapter output containing the API key is rejected before disk write", async (t) => {
  const harness = makeHarness(t);
  const unsafe = sessionState();
  unsafe.cookies[0].value = "api-key-memory-only";
  unsafe.storageState.cookies[0].value = "api-key-memory-only";
  harness.setAdapterState(unsafe);

  await assert.rejects(
    () => harness.service.getState(context, "xdr"),
    (error) => error instanceof SessionManagerError && error.code === "adapter_failed",
  );
  assert.equal(existsSync(harness.paths.meta), false);
  assert.equal(existsSync(harness.paths.cookies), false);
});

test("concurrent services perform one refresh through the file lock", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const current = credential();
  let refreshes = 0;
  let releaseRefresh;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseRefresh = resolve; });
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => {
      refreshes += 1;
      markStarted();
      await release;
      return sessionState();
    },
  }]);
  const resolver = { resolve: async () => current };
  const options = { store, adapters, lock: { pollMs: 2, waitMs: 1_000 } };
  const first = new SessionService(resolver, options).getState(context, "xdr");
  await started;
  const second = new SessionService(resolver, options).getState(context, "xdr");
  releaseRefresh();

  const results = await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.deepEqual(results.map((result) => result.source).sort(), ["cache", "refresh"]);
});

test("stale crash lock is reclaimed while a live lock has bounded wait", async (t) => {
  const harness = makeHarness(t, { lock: { staleMs: 10, waitMs: 100, pollMs: 2 } });
  await harness.store.ensureDirectory(harness.paths);
  writeFileSync(harness.paths.lock, JSON.stringify({
    token: "dead", pid: 1, startedAt: new Date(Date.now() - 10_000).toISOString(),
  }));
  await harness.service.getState(context, "xdr");
  assert.equal(harness.refreshes(), 1);
  assert.equal(existsSync(harness.paths.lock), false);

  await harness.store.clear("alice", "xdr");
  writeFileSync(harness.paths.lock, JSON.stringify({
    token: "live", pid: process.pid, startedAt: new Date().toISOString(),
  }));
  const blocked = makeService(harness.resolver, harness.store, harness.adapters, {
    staleMs: 10_000, waitMs: 20, pollMs: 2,
  });
  await assert.rejects(
    () => blocked.getState(context, "xdr"),
    (error) => error instanceof SessionManagerError && error.code === "adapter_failed" && error.retryable,
  );
});

const context = { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" };

function makeHarness(t, serviceOptions = {}) {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  let current = credential();
  let resolveError = null;
  let adapterError = null;
  let adapterState = sessionState();
  let refreshes = 0;
  const resolver = { resolve: async () => {
    if (resolveError) throw resolveError;
    return current;
  } };
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => {
      refreshes += 1;
      if (adapterError) throw adapterError;
      return adapterState;
    },
  }]);
  return {
    root, store, resolver, adapters,
    service: makeService(resolver, store, adapters, serviceOptions.lock),
    paths: store.paths("alice", "xdr"),
    refreshes: () => refreshes,
    setCredential: (update) => { current = { ...current, ...update }; },
    setResolveError: (error) => { resolveError = error; },
    setAdapterError: (error) => { adapterError = error; },
    setAdapterState: (state) => { adapterState = state; },
  };
}

function makeService(resolver, store, adapters, lock = {}) {
  return new SessionService(resolver, { store, adapters, lock, adapterTimeoutMs: 1_000 });
}

function credential() {
  return {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", platform: "xdr",
    credentialFingerprint: "sha256:credential",
    platformConfigFingerprint: "sha256:platform",
    apiKey: "api-key-memory-only", sessionMode: "storage_state", adapter: "xdr",
    platformConfig: { baseUrl: "https://xdr.internal" },
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

function assertPrivateFiles(result, root, apiKey) {
  assert.equal(result.cookiesPath.startsWith(root), true);
  for (const path of [result.cookiesPath, result.storageStatePath, join(result.cookiesPath, "..", "meta.json")]) {
    assert.equal(readFileSync(path, "utf8").includes(apiKey), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "session-manager-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

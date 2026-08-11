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
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import {
  AdapterRegistry,
  PlatformAdapterError,
  SessionManagerError,
  SessionService,
  SessionStore,
} from "../dist/index.js";

const context = { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" };

test("session cache validates owner and credential fingerprint without persisting API key", async (t) => {
  const harness = makeHarness(t);
  const first = await harness.service.getState(context, "xdr-query");
  const second = await harness.service.getState(context, "xdr-query");
  assert.equal(first.source, "refresh");
  assert.equal(second.source, "cache");
  assert.equal(harness.refreshes(), 1);
  assert.equal(first.sessionStateFile, join(harness.root, "alice", "session-store", "xdr-query.session.json"));
  assertPrivateFiles(first, harness.root, "api-key-memory-only");

  harness.setCredential({ credentialFingerprint: "sha256:credential-2" });
  await harness.service.getState(context, "xdr-query");
  assert.equal(harness.refreshes(), 2);

  harness.setCredential({ podId: "pod-b" });
  await harness.service.getState(context, "xdr-query");
  assert.equal(harness.refreshes(), 3);

  const bundle = readBundle(harness.paths.bundle);
  bundle.platforms.xdr.humanUserId = "other-user";
  writeFileSync(harness.paths.bundle, `${JSON.stringify(bundle)}\n`);
  await harness.service.getState(context, "xdr-query");
  assert.equal(harness.refreshes(), 4);
});

test("not configured and disabled Resolver results keep the bundle but drop the stale skill session file", async (t) => {
  for (const code of ["not_configured", "platform_disabled"]) {
    const harness = makeHarness(t);
    await harness.service.getState(context, "xdr-query");
    harness.setResolveError(new SessionManagerError(code));
    await assert.rejects(
      () => harness.service.getState(context, "xdr-query"),
      (error) => error instanceof SessionManagerError && error.code === code,
    );
    assert.equal(existsSync(harness.paths.bundle), true);
    assert.equal(existsSync(join(harness.root, "alice", "session-store", "xdr-query.session.json")), false);
  }
});

test("retryable Resolver failures keep the existing skill session file", async (t) => {
  const harness = makeHarness(t);
  await harness.service.getState(context, "xdr-query");
  harness.setResolveError(new SessionManagerError("credential_service_unavailable", true));
  await assert.rejects(
    () => harness.service.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError &&
      error.code === "credential_service_unavailable" && error.retryable,
  );
  assert.equal(existsSync(join(harness.root, "alice", "session-store", "xdr-query.session.json")), true);
});

test("Resolver cannot redirect trusted context to another agent", async (t) => {
  const harness = makeHarness(t);
  harness.setCredential({ agentId: "bob", humanUserId: "user-b" });
  await assert.rejects(
    () => harness.service.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError && error.code === "credential_service_unavailable",
  );
  assert.equal(harness.refreshes(), 0);
});

test("adapter authentication failure clears the old session", async (t) => {
  const harness = makeHarness(t);
  await harness.service.getState(context, "xdr-query");
  harness.setCredential({ credentialFingerprint: "sha256:rotated" });
  harness.setAdapterError(new PlatformAdapterError(true));

  await assert.rejects(
    () => harness.service.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError &&
      error.code === "adapter_failed" && error.platform === "xdr",
  );
  assert.equal(existsSync(harness.paths.bundle), true);
  assert.equal(readBundle(harness.paths.bundle).platforms.xdr, undefined);
});

test("adapter output containing the API key is rejected before disk write", async (t) => {
  const harness = makeHarness(t);
  const unsafe = sessionState();
  unsafe.cookies[0].value = "api-key-memory-only";
  unsafe.storageState.cookies[0].value = "api-key-memory-only";
  harness.setAdapterState(unsafe);

  await assert.rejects(
    () => harness.service.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError && error.code === "adapter_failed",
  );
  assert.equal(existsSync(harness.paths.bundle), false);
});

test("cached sessions are refreshed when adapter health validation fails", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const current = credential();
  let refreshes = 0;
  let validations = 0;
  let healthValid = true;
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => {
      refreshes += 1;
      return sessionState(`cookie-value-${refreshes}`);
    },
    validate: async () => {
      validations += 1;
      return healthValid;
    },
  }]);
  const service = makeService({ resolve: async () => current }, store, adapters);

  const first = await service.getState(context, "xdr-query");
  const second = await service.getState(context, "xdr-query");
  healthValid = false;
  const third = await service.getState(context, "xdr-query");

  assert.equal(first.source, "refresh");
  assert.equal(second.source, "cache");
  assert.equal(third.source, "refresh");
  assert.equal(refreshes, 2);
  assert.equal(validations, 2);
});

test("retryable health validation errors trust an unexpired cache", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const current = credential();
  let refreshes = 0;
  let validations = 0;
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => {
      refreshes += 1;
      return sessionState(`cookie-value-${refreshes}`);
    },
    validate: async () => {
      validations += 1;
      throw new PlatformAdapterError(false, true, "network");
    },
  }]);
  const service = makeService({ resolve: async () => current }, store, adapters);

  const first = await service.getState(context, "xdr-query");
  const second = await service.getState(context, "xdr-query");

  assert.equal(first.source, "refresh");
  assert.equal(second.source, "cache");
  assert.equal(refreshes, 1);
  assert.equal(validations, 1);
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
  const first = new SessionService(resolver, options).getState(context, "xdr-query");
  await started;
  const second = new SessionService(resolver, options).getState(context, "xdr-query");
  releaseRefresh();

  const results = await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.deepEqual(results.map((result) => result.source).sort(), ["cache", "refresh"]);
});

test("stale crash lock is reclaimed while a live lock has bounded wait", async (t) => {
  const harness = makeHarness(t, { lock: { staleMs: 10, waitMs: 100, pollMs: 2 } });
  await harness.store.ensureDirectory(harness.paths);
  writeFileSync(harness.paths.refreshLock, JSON.stringify({
    token: "dead", pid: 1, startedAt: new Date(Date.now() - 10_000).toISOString(),
  }));
  await harness.service.getState(context, "xdr-query");
  assert.equal(harness.refreshes(), 1);
  assert.equal(existsSync(harness.paths.refreshLock), false);

  await harness.store.clear("alice", "xdr");
  writeFileSync(harness.paths.refreshLock, JSON.stringify({
    token: "live", pid: process.pid, startedAt: new Date().toISOString(),
  }));
  const blocked = makeService(harness.resolver, harness.store, harness.adapters, {
    staleMs: 10_000, waitMs: 20, pollMs: 2,
  });
  await assert.rejects(
    () => blocked.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError && error.code === "adapter_failed" && error.retryable,
  );
});

test("bundle sections: same platform overwrites, other platforms persist", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });

  await store.write(scoped("xdr"), sessionState("xdr-1"));
  await store.write(scoped("mssw"), sessionState("mssw-1"));
  await store.write(scoped("xdr"), sessionState("xdr-2"));

  const bundle = readBundle(store.bundlePath("alice"));
  assert.deepEqual(Object.keys(bundle.platforms).sort(), ["mssw", "xdr"]);
  assert.equal(bundle.platforms.xdr.cookies[0].value, "xdr-2");
  assert.equal(bundle.platforms.mssw.cookies[0].value, "mssw-1");
});

test("sessionStateFile is cropped to the requested skill's platforms", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  await store.write(scoped("xdr"), sessionState("xdr-bundle"));
  await store.write(scoped("mssw"), sessionState("mssw-bundle"));
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => sessionState("xdr-refreshed"),
  }]);
  const service = makeService({ resolve: async () => credential() }, store, adapters);

  const result = await service.getState(context, "xdr-query");
  const file = readBundle(result.sessionStateFile);
  assert.deepEqual(Object.keys(file.platforms).sort(), ["xdr"]);
  assert.equal(file.platforms.xdr.cookies[0].value, "xdr-refreshed");
});

test("concurrent platform writes preserve every bundle section", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root, lock: { waitMs: 1_000, pollMs: 2 } });
  const platforms = ["xdr", "mssw"];
  const adapters = new AdapterRegistry(platforms.map((platform) => ({
    platform,
    refresh: async () => sessionState(`${platform}-cookie`),
  })));
  const multi = multiPlatformCredential();
  const resolver = { resolve: async () => multi };
  const service = new SessionService(resolver, {
    store, adapters, adapterTimeoutMs: 1_000, lock: { waitMs: 1_000, pollMs: 2 },
  });

  await service.getState(context, "multi-report");
  assert.deepEqual(Object.keys(readBundle(store.bundlePath("alice")).platforms).sort(), ["mssw", "xdr"]);
  assert.deepEqual(readBundle(store.bundlePath("alice")).platforms.xdr.cookies[0].value, "xdr-cookie");
  assert.deepEqual(readBundle(store.bundlePath("alice")).platforms.mssw.cookies[0].value, "mssw-cookie");
});

test("multi-platform skill refreshes each platform and aggregates sources", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const multi = multiPlatformCredential();
  let xdrRefreshes = 0;
  let msswRefreshes = 0;
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => { xdrRefreshes += 1; return sessionState(`xdr-${xdrRefreshes}`); },
  }, {
    platform: "mssw",
    refresh: async () => { msswRefreshes += 1; return sessionState(`mssw-${msswRefreshes}`); },
  }]);
  const resolver = { resolve: async () => multi };
  const service = makeService(resolver, store, adapters);

  const first = await service.getState(context, "multi-report");
  assert.equal(first.platforms.length, 2);
  assert.deepEqual(first.platforms.map((p) => p.platform).sort(), ["mssw", "xdr"]);
  assert.equal(xdrRefreshes, 1);
  assert.equal(msswRefreshes, 1);

  const second = await service.getState(context, "multi-report");
  assert.equal(second.source, "cache");
  assert.equal(xdrRefreshes, 1);
  assert.equal(msswRefreshes, 1);

  await store.clear("alice", "mssw");
  const mixed = await service.getState(context, "multi-report");
  assert.equal(mixed.source, "mixed");
  assert.deepEqual(mixed.platforms.map((p) => p.source).sort(), ["cache", "refresh"]);
  assert.equal(xdrRefreshes, 1);
  assert.equal(msswRefreshes, 2);
});

test("multi-platform cold refreshes run concurrently", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const multi = multiPlatformCredential();
  const release = deferred();
  const xdrStarted = deferred();
  const msswStarted = deferred();
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => {
      xdrStarted.resolve();
      await release.promise;
      return sessionState("xdr");
    },
  }, {
    platform: "mssw",
    refresh: async () => {
      msswStarted.resolve();
      await release.promise;
      return sessionState("mssw");
    },
  }]);
  const service = makeService({ resolve: async () => multi }, store, adapters);
  const running = service.getState(context, "multi-report");

  await Promise.race([
    Promise.all([xdrStarted.promise, msswStarted.promise]),
    sleep(100).then(() => {
      throw new Error("platform refreshes did not start concurrently");
    }),
  ]);
  release.resolve();
  await running;
});

test("multi-platform skill fails entirely when one platform adapter fails", async (t) => {
  const root = temporaryRoot(t);
  const store = new SessionStore({ rootDir: root });
  const multi = multiPlatformCredential();
  const adapters = new AdapterRegistry([{
    platform: "xdr",
    refresh: async () => sessionState("xdr-ok"),
  }, {
    platform: "mssw",
    refresh: async () => { throw new PlatformAdapterError(true); },
  }]);
  const resolver = { resolve: async () => multi };
  const service = makeService(resolver, store, adapters);

  await assert.rejects(
    () => service.getState(context, "multi-report"),
    (error) => error instanceof SessionManagerError &&
      error.code === "adapter_failed" && error.platform === "mssw",
  );
});

test("retryable browser session applier failures do not block cookie state", async (t) => {
  const harness = makeHarness(t, {
    browserApplier: {
      apply: async () => {
        throw new SessionManagerError("browser_apply_failed", true);
      },
    },
  });

  const result = await harness.service.getState(context, "xdr-query");
  assert.equal(result.status, "ready");
  assert.equal(result.platforms[0].platform, "xdr");
  assert.equal(result.platforms[0].browser, undefined);
  assert.equal(harness.refreshes(), 1);
});

test("non-retryable browser session applier failures include the owning platform", async (t) => {
  const harness = makeHarness(t, {
    browserApplier: {
      apply: async () => {
        throw new SessionManagerError("browser_apply_failed", false);
      },
    },
  });

  await assert.rejects(
    () => harness.service.getState(context, "xdr-query"),
    (error) => error instanceof SessionManagerError &&
      error.code === "browser_apply_failed" && error.platform === "xdr",
  );
});

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
    service: makeService(resolver, store, adapters, serviceOptions.lock, serviceOptions),
    paths: store.paths("alice", "xdr"),
    refreshes: () => refreshes,
    setCredential: (update) => {
      current = { ...current, ...update };
      if (update.credentialFingerprint || update.podId) {
        current.platforms = current.platforms.map((platform) => ({
          ...platform,
          ...(update.credentialFingerprint ? { credentialFingerprint: update.credentialFingerprint } : {}),
        }));
      }
    },
    setResolveError: (error) => { resolveError = error; },
    setAdapterError: (error) => { adapterError = error; },
    setAdapterState: (state) => { adapterState = state; },
  };
}

function makeService(resolver, store, adapters, lock = {}, options = {}) {
  return new SessionService(resolver, {
    ...options,
    store,
    adapters,
    lock,
    adapterTimeoutMs: 1_000,
  });
}

function credential() {
  return {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "xdr-query",
    platforms: [{
      platform: "xdr",
      credentialFingerprint: "sha256:credential",
      credentials: { apiKey: "api-key-memory-only", baseUrl: "https://xdr.internal" },
    }],
  };
}

function scoped(platform, fingerprint = `sha256:${platform}`) {
  return {
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "multi-report",
    platform,
    credentialFingerprint: fingerprint,
    credentials: { baseUrl: "https://x.internal" },
  };
}

function multiPlatformCredential() {
  return {
    humanUserId: "user-a", podId: "pod-a", agentId: "alice", skillName: "multi-report",
    platforms: [
      {
        platform: "xdr",
        credentialFingerprint: "sha256:xdr-credential",
        credentials: { apiKey: "xdr-key", baseUrl: "https://xdr.internal" },
      },
      {
        platform: "mssw",
        credentialFingerprint: "sha256:mssw-credential",
        credentials: { ak: "mssw-ak", sk: "mssw-sk", baseUrl: "https://mssw.internal", sessionEndpoint: "/api/session" },
      },
    ],
  };
}

function sessionState(cookieValue = "cookie-value") {
  const cookies = [{ name: "sid", value: cookieValue, domain: ".internal", path: "/" }];
  return {
    cookies,
    storageState: { cookies, origins: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function readBundle(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertPrivateFiles(result, root, apiKey) {
  assert.equal(result.sessionStateFile.startsWith(root), true);
  const sessionFile = readBundle(result.sessionStateFile);
  assert.equal(JSON.stringify(sessionFile).includes(apiKey), false);
  assert.equal(statSync(result.sessionStateFile).mode & 0o777, 0o600);
  assert.equal(sessionFile.platforms.xdr.cookies[0].value, "cookie-value");
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "session-manager-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

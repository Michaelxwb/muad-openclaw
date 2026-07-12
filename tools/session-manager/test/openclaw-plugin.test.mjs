import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SessionManagerError } from "../dist/index.js";
import plugin, { createPluginTool } from "../openclaw-plugin.mjs";

test("OpenClaw manifest owns the registered session_get_state tool", (t) => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  let factory;
  let options;
  plugin.register({
    pluginConfig: { consoleInternalURL: "http://console.internal:8080/internal/v1" },
    registerTool: (registeredFactory, registeredOptions) => {
      factory = registeredFactory;
      options = registeredOptions;
    },
  });
  const healthSymbol = Symbol.for("muad.session-manager.health");
  t.after(() => { delete globalThis[healthSymbol]; });

  assert.equal(plugin.id, "session-manager");
  assert.deepEqual(manifest.contracts.tools, ["session_get_state"]);
  assert.deepEqual(pkg.openclaw.extensions, ["./openclaw-plugin.mjs"]);
  assert.deepEqual(options, { name: "session_get_state" });
  assert.deepEqual(globalThis[healthSymbol], { loaded: true, version: 1 });
  const tool = factory({ agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" });
  assert.equal(tool.name, "session_get_state");
  assert.deepEqual(tool.parameters.required, ["platform"]);
  assert.equal(tool.parameters.properties.agentId, undefined);
});

test("OpenClaw Tool uses only trusted context and rejects forged agent parameters", async () => {
  const calls = [];
  const output = sessionResult();
  const service = {
    getState: async (context, platform) => {
      calls.push({ context, platform });
      return output;
    },
  };
  const tool = createPluginTool({
    toolContext: { agentId: "alice", sessionKey: "trusted-session-key" },
    service,
  });
  const result = await tool.execute("call-1", { platform: "xdr" });
  assert.deepEqual(result.details, output);
  assert.deepEqual(calls, [{
    context: { agentId: "alice", sessionKey: "trusted-session-key" },
    platform: "xdr",
  }]);

  await assert.rejects(
    () => tool.execute("call-2", { platform: "xdr", agentId: "bob" }),
    (error) => error instanceof SessionManagerError && error.code === "invalid_arguments",
  );
  const missing = createPluginTool({ toolContext: {}, service });
  await assert.rejects(
    () => missing.execute("call-3", { platform: "xdr" }),
    (error) => error instanceof SessionManagerError && error.code === "invalid_context",
  );
});

function sessionResult() {
  return {
    version: 1,
    status: "ready",
    source: "cache",
    platform: "xdr",
    cookiesPath: "/state/alice/xdr/cookies.json",
    storageStatePath: "/state/alice/xdr/storageState.json",
    expiresAt: "2026-07-12T00:00:00.000Z",
    credentialFingerprint: "sha256:credential",
    platformConfigFingerprint: "sha256:platform",
  };
}

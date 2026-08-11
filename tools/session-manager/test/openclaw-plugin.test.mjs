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
  assert.deepEqual(tool.parameters.required, ["skillName"]);
  assert.equal(tool.parameters.properties.agentId, undefined);
  assert.equal(tool.parameters.properties.platform, undefined);
});

test("OpenClaw Tool uses only trusted context and rejects forged agent parameters", async () => {
  const calls = [];
  const output = sessionResult();
  const service = {
    getState: async (context, skillName) => {
      calls.push({ context, skillName });
      return output;
    },
  };
  const tool = createPluginTool({
    toolContext: { agentId: "alice", sessionKey: "trusted-session-key" },
    service,
  });
  const result = await tool.execute("call-1", { skillName: "xdr-query" });
  const { sessionStateFile, ...expected } = output;
  assert.deepEqual(result.details, expected);
  assert.equal("sessionStateFile" in result.details, false);
  assert.deepEqual(calls, [{
    context: { agentId: "alice", sessionKey: "trusted-session-key" },
    skillName: "xdr-query",
  }]);

  await assert.rejects(
    () => tool.execute("call-platform", { skillName: "xdr-query", platform: "mssw" }),
    (error) => error instanceof SessionManagerError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => tool.execute("call-2", { skillName: "xdr-query", agentId: "bob" }),
    (error) => error instanceof SessionManagerError && error.code === "invalid_arguments",
  );
  const missing = createPluginTool({ toolContext: {}, service });
  await assert.rejects(
    () => missing.execute("call-3", { skillName: "xdr-query" }),
    (error) => error instanceof SessionManagerError && error.code === "invalid_context",
  );
});

test("OpenClaw Tool preserves platform attribution from service errors", async () => {
  const service = {
    getState: async () => {
      throw new SessionManagerError(
        "adapter_failed",
        true,
        "network",
        "network unavailable",
        undefined,
        "mssw",
      );
    },
  };
  const tool = createPluginTool({
    toolContext: { agentId: "alice", sessionKey: "agent:alice:wecom:direct:user-a" },
    service,
  });

  await assert.rejects(
    () => tool.execute("call-1", { skillName: "multi-report" }),
    (error) => error instanceof SessionManagerError &&
      error.code === "adapter_failed" &&
      error.platform === "mssw",
  );
});

function sessionResult() {
  return {
    version: 1,
    status: "ready",
    source: "cache",
    sessionStateFile: "/state/alice/session-store/xdr-query.session.json",
    humanUserId: "user-a",
    podId: "pod-a",
    agentId: "alice",
    skillName: "xdr-query",
    platforms: [{
      platform: "xdr",
      source: "cache",
      expiresAt: "2026-07-12T00:00:00.000Z",
      credentialFingerprint: "sha256:credential",
    }],
  };
}

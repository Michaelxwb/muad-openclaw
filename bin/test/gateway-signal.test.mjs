// TASK-004：Gateway 重启信号按 pod 内 OpenClaw 版本选择。
// 9.6 起 SIGUSR1 改为调试用途，重启迁移到 SIGUSR2；旧版本继续使用 SIGUSR1。
import assert from "node:assert/strict";
import test from "node:test";

import { detectGatewayRestartSignal, gatewayRestartSignal } from "../gateway-signal.mjs";

test("gateway restart signal maps OpenClaw version to the supported protocol", () => {
  assert.equal(gatewayRestartSignal("OpenClaw 2026.7.1"), "USR1");
  assert.equal(gatewayRestartSignal("OpenClaw 2026.9.5"), "USR1");
  assert.equal(gatewayRestartSignal("OpenClaw 2026.9.6"), "USR2");
  assert.equal(gatewayRestartSignal("OpenClaw 2026.9.8"), "USR2");
  assert.equal(gatewayRestartSignal("OpenClaw 2026.10.1-beta.1"), "USR2");
});

test("gateway restart signal falls back to USR1 for unknown versions", () => {
  assert.equal(gatewayRestartSignal(""), "USR1");
  assert.equal(gatewayRestartSignal("not-a-version"), "USR1");
  assert.equal(gatewayRestartSignal(undefined), "USR1");
});

test("detectGatewayRestartSignal reads openclaw --version once through the injected runner", () => {
  const calls = [];
  const signal = detectGatewayRestartSignal({
    spawnSync: (_command, args) => {
      calls.push(args.join(" "));
      return { status: 0, stdout: "OpenClaw 2026.9.8\n", error: undefined };
    },
  });
  assert.equal(signal, "USR2");
  assert.deepEqual(calls, ["--version"]);

  const legacy = detectGatewayRestartSignal({
    spawnSync: () => ({ status: 0, stdout: "OpenClaw 2026.7.1", error: undefined }),
  });
  assert.equal(legacy, "USR1");

  const missing = detectGatewayRestartSignal({
    spawnSync: () => ({ status: 1, stdout: "", error: new Error("ENOENT") }),
  });
  assert.equal(missing, "USR1");
});

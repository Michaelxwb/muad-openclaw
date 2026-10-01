import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseRuntimeConfig, readRuntimeConfig } from "../runtime-config-schema.mjs";

const fixtureText = readFileSync(
  fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url)),
  "utf8",
);

test("E-01 file input takes priority and rejects relative paths", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "muad-runtime-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "runtime.json");
  writeFileSync(file, fixtureText, { mode: 0o600 });
  const runtime = readRuntimeConfig({ env: { MUAD_RUNTIME_CONFIG_FILE: file, MUAD_RUNTIME_CONFIG: "invalid env" }, stdinText: "invalid stdin" });
  assert.deepEqual(runtime, parseRuntimeConfig(fixtureText));
  assert.throws(() => readRuntimeConfig({ env: { MUAD_RUNTIME_CONFIG_FILE: "runtime.json", MUAD_RUNTIME_CONFIG: fixtureText } }), /absolute/);
});

test("E-01 invalid files fail CLI without fallback or overwriting existing config", async (t) => {
  for (const [name, content, expected] of [
    ["missing", null, /ENOENT/], ["empty", "", /empty/],
    ["invalid-json", '{secret-not-for-logs', /JSON/], ["invalid-schema", '{}', /runtime/],
    ["unreadable", fixtureText, /EACCES/],
  ]) {
    await t.test(name, () => assertInvalidRuntimeFile(t, name, content, expected));
  }
});

function assertInvalidRuntimeFile(t, name, content, expected) {
  const directory = mkdtempSync(join(tmpdir(), "muad-runtime-fail-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "runtime.json"), target = join(directory, "openclaw.json");
  chmodSync(directory, 0o755);
  if (content !== null) writeFileSync(file, content, { mode: name === "unreadable" ? 0o000 : 0o644 });
  const baseline = '{"sentinel":"keep-existing-config"}\n';
  writeFileSync(target, baseline, { mode: 0o600 });
  const credentials = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../inject-multi-user-config.mjs", import.meta.url))], {
    env: { ...process.env, MUAD_RUNTIME_CONFIG_FILE: file, MUAD_RUNTIME_CONFIG: fixtureText, OPENCLAW_CONFIG_PATH: target },
    input: fixtureText, encoding: "utf8", timeout: 5000, ...credentials,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, expected);
  assert.doesNotMatch(child.stderr, /secret-not-for-logs/);
  assert.equal(readFileSync(target, "utf8"), baseline);
}

function runtimeWithProviderMutation(mutate) {
  const runtime = JSON.parse(fixtureText);
  const target = runtime.providers.find((provider) => provider.id === "user-alice-deepseek");
  assert.ok(target, "fixture must contain user-alice-deepseek provider");
  mutate(target);
  return JSON.stringify(runtime);
}

// E-B02 [unit] 真实边界：validateRuntimeConfig（parseRuntimeConfig）真实实现，
// 走 assertExactKeys 严格校验路径。
test("schema accepts supportsImages as an optional boolean on a provider", () => {
  // 显式 true：必须被接受，否则 console 下发的 DTO 会让 apply 前置失败。
  assert.doesNotThrow(() =>
    parseRuntimeConfig(runtimeWithProviderMutation((provider) => {
      provider.supportsImages = true;
    })),
  );
  // 缺省：可选字段，存量 DTO（无该字段）必须继续通过。
  assert.doesNotThrow(() => parseRuntimeConfig(runtimeWithProviderMutation(() => {})));
});

test("schema rejects a non-boolean supportsImages", () => {
  assert.throws(
    () =>
      parseRuntimeConfig(runtimeWithProviderMutation((provider) => {
        provider.supportsImages = "yes";
      })),
    /supportsImages/,
  );
});

test("schema still rejects provider keys outside the allow-list", () => {
  // 白名单是精确匹配：加字段不能把严格性放宽（拼写错误必须被拦下）。
  assert.throws(
    () =>
      parseRuntimeConfig(runtimeWithProviderMutation((provider) => {
        provider.supportsImage = true;
      })),
    /unknown field/,
  );
});

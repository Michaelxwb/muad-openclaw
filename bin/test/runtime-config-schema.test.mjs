import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseRuntimeConfig } from "../runtime-config-schema.mjs";

const fixtureText = readFileSync(
  fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url)),
  "utf8",
);

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

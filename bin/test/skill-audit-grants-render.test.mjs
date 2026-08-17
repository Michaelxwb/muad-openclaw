import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalHash, renderOpenClawConfig } from "../openclaw-config-renderer.mjs";
import { parseRuntimeConfig } from "../runtime-config-schema.mjs";
import { selectRestartMode } from "../runtime-config-transaction.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/runtime-v1.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");
const renderOptions = { gateway: { mode: "local", port: 18789 } };

const GRANT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

// 字节稳定对比必须剥离 generation：它是 noop 书签字段（selectRestartMode 内部
// 也调用 stripRestartNoop），真实上传流程会 bump 它，但不算运行时变更。
function hashWithoutGeneration(config) {
  const cleaned = JSON.parse(JSON.stringify(config));
  delete cleaned.plugins.entries["muad-runtime-guard"].config.generation;
  return canonicalHash(cleaned);
}

test("renderer emits directory grants for public/private and keeps system per-Skill", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  const rendered = renderOpenClawConfig(runtime, renderOptions);
  const grants = rendered.plugins.entries["muad-runtime-guard"].config.skillAuditGrants;

  const publicGrant = grants.find((grant) => grant.source === "public");
  const privateGrant = grants.find((grant) => grant.source === "private");
  const systemGrants = grants.filter((grant) => grant.source === "system");

  assert.equal(publicGrant.dir, true);
  assert.equal(publicGrant.agentId, "alice");
  assert.equal(publicGrant.rootPath, "/opt/openclaw-skills");
  assert.equal(privateGrant.dir, true);
  assert.equal(privateGrant.agentId, "alice");
  assert.equal(privateGrant.rootPath, "/tmp/muad-runtime/workspace-alice/skills");

  // 占位 name 必须保持 guard SKILL_NAME_PATTERN schema-valid（旧 guard 忽略 dir 也会校验）。
  for (const grant of grants) assert.match(grant.name, GRANT_NAME_PATTERN);

  // fixture 的 xdr-query 是 public，不产生 per-Skill grant；system 才保持 per-Skill。
  assert.equal(systemGrants.length, 0);
  assert.equal(
    grants.some((grant) => grant.dir !== true),
    false,
    "public/private 全部走目录级 grant，不再有 per-Skill 条目",
  );
});

test("adding a public or private non-longTask Skill keeps config byte-stable (restart none)", () => {
  const current = parseRuntimeConfig(fixtureText);
  const next = structuredClone(current);
  next.generation += 1; // 真实流程里上传 skill 会 bump generation
  next.skills.agents[0].allowed.push(
    {
      name: "mssw-query",
      source: "public",
      skillId: "skill-public-mssw",
      version: "1.0.0",
      entryType: "managed",
      rootPath: "/opt/openclaw-skills/mssw-query",
      longTask: false,
      scriptFiles: [],
    },
    {
      name: "my-priv",
      source: "private",
      skillId: "skill-private-mypriv",
      version: "1.0.0",
      entryType: "managed",
      rootPath: "/tmp/muad-runtime/workspace-alice/skills/my-priv",
      longTask: false,
      scriptFiles: [],
    },
  );

  const currentConfig = renderOpenClawConfig(current, renderOptions);
  const nextConfig = renderOpenClawConfig(next, renderOptions);
  assert.equal(
    hashWithoutGeneration(nextConfig),
    hashWithoutGeneration(currentConfig),
    "Skill 增删必须不改 guard config 字节（除 generation 书签外）",
  );
  assert.equal(selectRestartMode(currentConfig, nextConfig), "none");
});

test("removing a public non-longTask Skill keeps config byte-stable (restart none)", () => {
  const current = parseRuntimeConfig(fixtureText);
  // 加入一个非 longTask 的 public Skill 作为被移除对象（fixture 自带的 xdr-query 是 longTask，
  // 移除它会触发 longTaskSkillGrants 变化 → gateway，属于已知残留）。
  current.skills.agents[0].allowed.push({
    name: "smoke-platform",
    source: "public",
    skillId: "skill-public-smoke",
    version: "1.0.0",
    entryType: "managed",
    rootPath: "/opt/openclaw-skills/smoke-platform",
    longTask: false,
    scriptFiles: [],
  });
  const next = structuredClone(current);
  next.generation += 1;
  next.skills.agents[0].allowed = next.skills.agents[0].allowed.filter(
    (skill) => skill.name !== "smoke-platform",
  );

  const currentConfig = renderOpenClawConfig(current, renderOptions);
  const nextConfig = renderOpenClawConfig(next, renderOptions);
  assert.equal(
    hashWithoutGeneration(nextConfig),
    hashWithoutGeneration(currentConfig),
    "移除 public Skill 必须不改 guard config 字节（除 generation 书签外）",
  );
  assert.equal(selectRestartMode(currentConfig, nextConfig), "none");
});

test("system Skills keep per-Skill grants and stay byte-stable", () => {
  const current = parseRuntimeConfig(fixtureText);
  const systemSkill = {
    name: "web-tools-guide",
    source: "system",
    skillId: "skill-system-web-tools",
    version: "1.0.0",
    entryType: "managed",
    rootPath: "/opt/openclaw-skills/web-tools-guide",
    longTask: false,
    scriptFiles: [],
  };
  current.skills.agents[0].allowed.push(systemSkill);

  const currentConfig = renderOpenClawConfig(current, renderOptions);
  const grants = currentConfig.plugins.entries["muad-runtime-guard"].config.skillAuditGrants;
  const systemGrants = grants.filter((grant) => grant.source === "system");
  assert.equal(systemGrants.length, 1);
  assert.equal(systemGrants[0].name, "web-tools-guide");
  assert.equal(systemGrants[0].rootPath, "/opt/openclaw-skills/web-tools-guide");
  assert.notEqual(systemGrants[0].dir, true, "system Skill 保持 per-Skill 精确匹配");

  // system Skill 是同镜像一起发布的，不属于 hot-change 场景：重复渲染字节必须一致。
  const nextConfig = renderOpenClawConfig(current, renderOptions);
  assert.equal(canonicalHash(nextConfig), canonicalHash(currentConfig));
  assert.equal(selectRestartMode(currentConfig, nextConfig), "none");
});

test("longTask Skill changes hot-reload via plugin reload", () => {
  const current = parseRuntimeConfig(fixtureText);
  const next = structuredClone(current);
  next.generation += 1;
  next.skills.agents[0].allowed.push({
    name: "xdr-deep",
    source: "public",
    skillId: "skill-public-xdrdeep",
    version: "1.0.0",
    entryType: "managed",
    rootPath: "/opt/openclaw-skills/xdr-deep",
    longTask: true,
    scriptFiles: [],
  });

  const currentConfig = renderOpenClawConfig(current, renderOptions);
  const nextConfig = renderOpenClawConfig(next, renderOptions);
  assert.notEqual(
    canonicalHash(nextConfig),
    canonicalHash(currentConfig),
    "longTask grant 是 per-Skill 的，新增必须改字节",
  );
  // longTask grant 落在 guard 插件配置（plugins.entries.muad-runtime-guard
  // .config.longTaskSkillGrants），命中 openclaw 的 plugins 前缀 hot reload：
  // reload-plugins 会重建插件运行时并让 channel 插件重新捕获配置，无需
  // gateway 全量重启（曾作为 known residual 触发重启）。
  assert.equal(selectRestartMode(currentConfig, nextConfig), "none");
});

test("sanitizeGrantName keeps unusual public/private roots schema-valid", () => {
  const runtime = parseRuntimeConfig(fixtureText);
  runtime.skills.publicDirectory = "/opt/Public Skills 目录";
  runtime.skills.agents[0].allowed[0].rootPath = "/opt/Public Skills 目录/xdr-query";

  const rendered = renderOpenClawConfig(runtime, renderOptions);
  const grants = rendered.plugins.entries["muad-runtime-guard"].config.skillAuditGrants;
  const publicGrant = grants.find((grant) => grant.source === "public");
  assert.equal(publicGrant.rootPath, "/opt/Public Skills 目录");
  assert.match(publicGrant.name, GRANT_NAME_PATTERN, "占位 name 必须被 sanitize 成 schema-valid");
});

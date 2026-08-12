import assert from "node:assert/strict";
import test from "node:test";

import { parseGuardConfig } from "../src/config.mjs";

// 目录级 grant（public/private 热变更 scope）携带占位 name；只有 per-Skill grant
// 才按 name 精确匹配，因此占位 name 只要非空即可。旧 guard 忽略 dir 字段并
// 对每个 grant 强校验 SKILL_NAME_PATTERN，renderer 侧仍保证占位 name 合法。
test("directory grants parse with the dir marker and lenient placeholder names", () => {
  const parsed = parseGuardConfig(validConfig());
  assert.equal(parsed.valid, true);
  const publicGrant = parsed.skillAuditGrants.find((grant) => grant.source === "public");
  const privateGrant = parsed.skillAuditGrants.find((grant) => grant.source === "private");
  const systemGrant = parsed.skillAuditGrants.find((grant) => grant.source === "system");
  assert.equal(publicGrant.dir, true);
  assert.equal(privateGrant.dir, true);
  assert.equal(systemGrant.dir, false);
  assert.equal(systemGrant.name, "web-tools-guide");
});

test("directory grant placeholder names bypass the Skill-name pattern", () => {
  const config = validConfig();
  // "9skills" 以数字开头，不匹配 SKILL_NAME_PATTERN；dir:true 时只要求非空。
  config.skillAuditGrants.find((grant) => grant.source === "private").name = "9skills";
  const parsed = parseGuardConfig(config);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.skillAuditGrants.find((grant) => grant.source === "private").name, "9skills");
});

test("directory grants reject empty names and non-public/private scopes", () => {
  const emptyName = validConfig();
  emptyName.skillAuditGrants.find((grant) => grant.source === "private").name = "";
  assert.equal(parseGuardConfig(emptyName).valid, false);

  const systemDir = validConfig();
  systemDir.skillAuditGrants.push({
    agentId: "alice", name: "sys-dir", rootPath: "/opt/sys", source: "system", dir: true,
  });
  assert.equal(parseGuardConfig(systemDir).valid, false, "dir grant 只能 public/private");
});

test("directory grants reject duplicate roots per agent and require mapped agents", () => {
  const duplicate = validConfig();
  duplicate.skillAuditGrants.push({
    agentId: "alice", name: "dup", rootPath: "/opt/openclaw-skills", source: "public", dir: true,
  });
  assert.equal(parseGuardConfig(duplicate).valid, false);

  const unmapped = validConfig();
  unmapped.skillAuditGrants.push({
    agentId: "eve", name: "eve-root", rootPath: "/opt/eve", source: "public", dir: true,
  });
  assert.equal(parseGuardConfig(unmapped).valid, false);
});

test("per-Skill grants still enforce the Skill-name pattern", () => {
  const config = validConfig();
  config.skillAuditGrants.find((grant) => grant.source === "system").name = "9bad-name";
  assert.equal(parseGuardConfig(config).valid, false, "per-Skill 必须匹配 SKILL_NAME_PATTERN");
});

test("older per-Skill grants without the dir marker remain valid (backward compatible)", () => {
  const legacy = validConfig();
  for (const grant of legacy.skillAuditGrants) {
    delete grant.dir;
  }
  const parsed = parseGuardConfig(legacy);
  assert.equal(parsed.valid, true);
  assert.equal(
    parsed.skillAuditGrants.every((grant) => grant.dir === false),
    true,
    "缺省 dir 视为 per-Skill",
  );
});

function validConfig() {
  return {
    generation: 7,
    mainAgentId: "main",
    quarantineProfile: "quarantine",
    agentProfiles: [
      { agentId: "alice", profile: "alice" },
      { agentId: "bob", profile: "bob" },
    ],
    skillReadRoots: [
      { agentId: "alice", roots: ["/opt/openclaw-skills", "/state/workspace-alice/skills"] },
      { agentId: "bob", roots: ["/opt/openclaw-skills", "/state/workspace-bob/skills"] },
    ],
    skillAuditGrants: [
      { agentId: "alice", name: "openclaw-skills", rootPath: "/opt/openclaw-skills", source: "public", dir: true },
      { agentId: "alice", name: "skills", rootPath: "/state/workspace-alice/skills", source: "private", dir: true },
      { agentId: "alice", name: "web-tools-guide", rootPath: "/opt/openclaw-skills/web-tools-guide", source: "system" },
      { agentId: "bob", name: "openclaw-skills", rootPath: "/opt/openclaw-skills", source: "public", dir: true },
      { agentId: "bob", name: "skills", rootPath: "/state/workspace-bob/skills", source: "private", dir: true },
    ],
    sessionAgentIds: ["alice", "bob"],
    maxBrowserConcurrency: 2,
    maxSkillConcurrency: 4,
    maxLongTaskConcurrency: 2,
    longTaskSkillGrants: [
      { agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query" },
    ],
    consoleInternalURL: "http://console.internal:8080/internal/v1",
    serviceTokenFile: "/run/secrets/muad/pod-service-token",
  };
}

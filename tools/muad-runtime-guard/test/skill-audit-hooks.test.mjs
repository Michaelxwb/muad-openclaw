import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createSkillAuditHooks } from "../src/skill-audit-hooks.mjs";

const config = {
  valid: true,
  mainAgentId: "main",
  agentProfiles: [{ agentId: "alice", profile: "profile-alice" }],
  skillAuditGrants: [
    { agentId: "alice", name: "xdr-query", rootPath: "/opt/openclaw-skills/xdr-query", source: "system" },
  ],
};

test("skill audit hooks report explicit Skill commands with the minimal contract", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  const result = await hooks.beforeDispatch(
    { runId: "run-1", prompt: "/skill:xdr-query now" },
    context("run-1"),
  );
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.deepEqual(Object.keys(client.reports[0]).sort(), [
    "agentId", "executionId", "skillName", "skillScope", "startedAt",
  ]);
  assert.equal(client.reports[0].agentId, "alice");
  assert.equal(client.reports[0].skillName, "xdr-query");
  assert.equal(client.reports[0].skillScope, "system");
  assert.equal(client.reports[0].startedAt, fixedNow.toISOString());
  assert.match(client.reports[0].executionId, /^[0-9a-f-]{36}$/u);
});

test("skill audit hooks report natural-language reads of a granted SKILL.md", async (t) => {
  const root = skillRoot(t);
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: root, source: "system" },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-2", prompt: "帮我查下 xdr" }, context("run-2"));
  const result = await hooks.beforeToolCall(
    { runId: "run-2", toolName: "read", params: { path: join(root, "SKILL.md") } },
    context("run-2"),
  );
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.equal(client.reports[0].skillName, "xdr-query");
  assert.equal(client.reports[0].agentId, "alice");
});

test("skill audit hooks skip non-skill reads, normal chat and ungranted skills", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  // Non-skill tool call (not a read).
  assert.equal(await hooks.beforeToolCall(
    { runId: "run-3", toolName: "exec", params: { command: "id" } }, context("run-3"),
  ), undefined);
  // Plain chat dispatch.
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-3", prompt: "你好" }, context("run-3"),
  ), undefined);
  // Skill the agent is not granted.
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-3", prompt: "/skill:admin-tool" }, context("run-3"),
  ), undefined);
  await flush();
  assert.equal(client.reports.length, 0);
});

test("skill audit hooks report only once per runId and skill", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  await hooks.beforeDispatch({ runId: "run-4", prompt: "/skill:xdr-query now" }, context("run-4"));
  await hooks.beforeDispatch({ runId: "run-4", prompt: "/skill:xdr-query again" }, context("run-4"));
  await flush();

  assert.equal(client.reports.length, 1);
});

test("skill audit hooks are fire-and-forget: client failures never block the turn", async () => {
  const client = {
    reports: [],
    async report(request) {
      this.reports.push(request);
      throw new Error("network down");
    },
  };
  const logs = [];
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow, log: (message) => logs.push(message) });

  const result = await hooks.beforeDispatch({ runId: "run-5", prompt: "/skill:xdr-query now" }, context("run-5"));
  assert.equal(result, undefined);
  await flush();

  assert.equal(client.reports.length, 1);
  assert.ok(logs.some((message) => message.includes("report failed")), "failure must be logged, not thrown");
});

test("skill audit hooks skip long-task sessions", async () => {
  const client = recordingClient();
  const hooks = createSkillAuditHooks({ config, client, now: () => fixedNow });

  const longTaskCtx = { ...context("run-6"), sessionKey: "agent:alice:longtask:task-1" };
  assert.equal(await hooks.beforeDispatch(
    { runId: "run-6", prompt: "/skill:xdr-query now" }, longTaskCtx,
  ), undefined);
  await flush();
  assert.equal(client.reports.length, 0);
});

test("skill audit hooks tolerate a missing client entirely", async () => {
  const hooks = createSkillAuditHooks({ config, client: null, now: () => fixedNow });
  const result = await hooks.beforeDispatch({ runId: "run-7", prompt: "/skill:xdr-query now" }, context("run-7"));
  assert.equal(result, undefined);
});

test("skill audit hooks derive real Skill names from directory grants on reads", async (t) => {
  const publicRoot = skillDir(t);
  mkdirSync(join(publicRoot, "mssw-query"), { recursive: true });
  writeFileSync(join(publicRoot, "mssw-query", "SKILL.md"), "# MSSW\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "openclaw-skills", rootPath: publicRoot, source: "public", dir: true },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-dir-1", prompt: "查下 mssw" }, context("run-dir-1"));
  await hooks.beforeToolCall(
    { runId: "run-dir-1", toolName: "read", params: { path: join(publicRoot, "mssw-query", "SKILL.md") } },
    context("run-dir-1"),
  );
  await flush();

  assert.equal(client.reports.length, 1);
  assert.equal(client.reports[0].skillName, "mssw-query", "真实 skill 名由路径派生，而非占位 name");
  assert.equal(client.reports[0].skillScope, "public");
});

test("skill audit hooks resolve directory-grant Skills by real directory on dispatch", async (t) => {
  const publicRoot = skillDir(t);
  mkdirSync(join(publicRoot, "mssw-query"), { recursive: true });
  writeFileSync(join(publicRoot, "mssw-query", "SKILL.md"), "# MSSW\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "openclaw-skills", rootPath: publicRoot, source: "public", dir: true },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeDispatch({ runId: "run-dir-2", prompt: "/skill:mssw-query now" }, context("run-dir-2"));
  await flush();
  assert.equal(client.reports.length, 1);
  assert.equal(client.reports[0].skillName, "mssw-query");
  assert.equal(client.reports[0].skillScope, "public");

  // 从未安装过的 skill 名：目录回退用真实文件存在性过滤，不产生 phantom 上报。
  await hooks.beforeDispatch({ runId: "run-dir-3", prompt: "/skill:phantom-skill now" }, context("run-dir-3"));
  await flush();
  assert.equal(client.reports.length, 1);
});

test("skill audit hooks report private Skills with private scope", async (t) => {
  const privateRoot = skillDir(t);
  const agentSkills = join(privateRoot, "workspace-alice", "skills");
  mkdirSync(join(agentSkills, "my-priv"), { recursive: true });
  writeFileSync(join(agentSkills, "my-priv", "SKILL.md"), "# Priv\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "skills", rootPath: agentSkills, source: "private", dir: true },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-dir-4", prompt: "用下私有 skill" }, context("run-dir-4"));
  await hooks.beforeToolCall(
    { runId: "run-dir-4", toolName: "read", params: { path: join(agentSkills, "my-priv", "SKILL.md") } },
    context("run-dir-4"),
  );
  await flush();

  assert.equal(client.reports[0].skillName, "my-priv");
  assert.equal(client.reports[0].skillScope, "private");
});

test("skill audit hooks keep system scope for system Skills under a public directory grant", async (t) => {
  const publicRoot = skillDir(t);
  const sysDir = join(publicRoot, "web-tools-guide");
  mkdirSync(sysDir, { recursive: true });
  writeFileSync(join(sysDir, "SKILL.md"), "# Web Tools\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "openclaw-skills", rootPath: publicRoot, source: "public", dir: true },
        { agentId: "alice", name: "web-tools-guide", rootPath: sysDir, source: "system" },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-dir-5", prompt: "看看 web tools" }, context("run-dir-5"));
  await hooks.beforeToolCall(
    { runId: "run-dir-5", toolName: "read", params: { path: join(sysDir, "SKILL.md") } },
    context("run-dir-5"),
  );
  await flush();

  assert.equal(client.reports.length, 1);
  assert.equal(client.reports[0].skillName, "web-tools-guide");
  assert.equal(client.reports[0].skillScope, "system", "system Skill 在 public 目录下也必须保持 system scope");
});

test("skill audit hooks derive the first path segment for nested SKILL.md reads", async (t) => {
  const publicRoot = skillDir(t);
  mkdirSync(join(publicRoot, "xdr-query", "lib"), { recursive: true });
  writeFileSync(join(publicRoot, "xdr-query", "lib", "SKILL.md"), "# XDR\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "openclaw-skills", rootPath: publicRoot, source: "public", dir: true },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeAgentRun({ runId: "run-dir-6", prompt: "查 xdr" }, context("run-dir-6"));
  await hooks.beforeToolCall(
    { runId: "run-dir-6", toolName: "read", params: { path: join(publicRoot, "xdr-query", "lib", "SKILL.md") } },
    context("run-dir-6"),
  );
  await flush();

  assert.equal(client.reports[0].skillName, "xdr-query");
});

test("skill audit hooks dedup dir-grant Skills across dispatch and read within a turn", async (t) => {
  const publicRoot = skillDir(t);
  mkdirSync(join(publicRoot, "mssw-query"), { recursive: true });
  writeFileSync(join(publicRoot, "mssw-query", "SKILL.md"), "# MSSW\n");
  const client = recordingClient();
  const hooks = createSkillAuditHooks({
    config: {
      ...config,
      skillAuditGrants: [
        { agentId: "alice", name: "openclaw-skills", rootPath: publicRoot, source: "public", dir: true },
      ],
    },
    client,
    now: () => fixedNow,
  });

  await hooks.beforeDispatch({ runId: "run-dir-7", prompt: "/skill:mssw-query now" }, context("run-dir-7"));
  await hooks.beforeAgentRun({ runId: "run-dir-7", prompt: "/skill:mssw-query now" }, context("run-dir-7"));
  await hooks.beforeToolCall(
    { runId: "run-dir-7", toolName: "read", params: { path: join(publicRoot, "mssw-query", "SKILL.md") } },
    context("run-dir-7"),
  );
  await flush();

  assert.equal(client.reports.length, 1, "同一 turn 对同一 skill 的 dispatch + read 只上报一次");
});

const fixedNow = new Date("2026-08-12T09:30:00.000Z");

function recordingClient() {
  return { reports: [], async report(request) { this.reports.push(request); } };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function context(runId) {
  return {
    agentId: "alice",
    sessionKey: "agent:alice:wecom:direct:user",
    runId,
  };
}

function skillRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-audit-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "# XDR\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// 目录 grant 的 root：只建空目录，skill 子目录由用例自行 mkdir（模拟 public/private root）。
function skillDir(t) {
  const root = mkdtempSync(join(tmpdir(), "muad-skill-audit-dir-"));
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

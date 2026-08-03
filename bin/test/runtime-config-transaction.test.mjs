import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  commitTransaction,
  prepareTransaction,
  rollbackTransaction,
  selectRestartMode,
  validateCandidate,
} from "../runtime-config-transaction.mjs";

const fixturePath = fileURLToPath(
  new URL("./fixtures/runtime-v1.json", import.meta.url),
);

test("transaction prepares, commits and rolls back an atomic config candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-transaction-"));
  const configPath = join(root, "openclaw.json");
  const original = { gateway: { mode: "local" }, browser: { enabled: false } };
  writeFileSync(configPath, JSON.stringify(original));
  const runtime = runtimeForRoot(root);

  const prepared = prepareTransaction({ runtime, configPath });
  assert.equal(prepared.restartMode, "gateway");
  assert.equal(existsSync(`${configPath}.muad.candidate`), true);
  const committed = commitTransaction({ runtime, configPath });
  assert.equal(committed.configHash, prepared.configHash);
  assert.equal(existsSync(`${configPath}.muad.previous`), true);
  assert.equal(
    JSON.parse(readFileSync(configPath, "utf8")).plugins.entries[
      "muad-runtime-guard"
    ].config.generation,
    7,
  );

  const rolledBack = rollbackTransaction(configPath);
  assert.equal(rolledBack.generation, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), original);
});

test("commit removes stale main direct sessions for newly committed bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-bind-session-"));
  const configPath = join(root, "openclaw.json");
  writeFileSync(
    configPath,
    JSON.stringify({ gateway: { mode: "local" }, browser: { enabled: false } }),
  );
  const runtime = runtimeForRoot(root);
  const sessionsDir = join(root, "agents", "main", "sessions");
  const healthyFile = join(sessionsDir, "healthy.jsonl");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(healthyFile, "{}\n");
  writeFileSync(
    join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:main:openclaw-weixin:direct:wx-alice": {
        sessionId: "stale",
        sessionFile: join(sessionsDir, "missing.jsonl"),
      },
      "agent:main:wecom:direct:XuWenBin": {
        sessionId: "healthy",
        sessionFile: healthyFile,
      },
      "agent:main:openclaw-weixin:direct:unbound-user": {
        sessionId: "unbound",
        sessionFile: join(sessionsDir, "unbound-missing.jsonl"),
      },
      "agent:main:openclaw-weixin:group:wx-alice": {
        sessionId: "group",
        sessionFile: join(sessionsDir, "group-missing.jsonl"),
      },
    }),
  );

  prepareTransaction({ runtime, configPath });
  commitTransaction({ runtime, configPath });

  const sessions = JSON.parse(
    readFileSync(join(sessionsDir, "sessions.json"), "utf8"),
  );
  assert.equal(
    sessions["agent:main:openclaw-weixin:direct:wx-alice"],
    undefined,
  );
  assert.equal(
    sessions["agent:main:wecom:direct:XuWenBin"].sessionId,
    "healthy",
  );
  assert.equal(
    sessions["agent:main:openclaw-weixin:direct:unbound-user"].sessionId,
    "unbound",
  );
  assert.equal(
    sessions["agent:main:openclaw-weixin:group:wx-alice"].sessionId,
    "group",
  );
});

test("candidate validation uses OPENCLAW_CONFIG_PATH and propagates failures", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-validate-"));
  const configPath = join(root, "openclaw.json");
  writeFileSync(`${configPath}.muad.candidate`, "{}\n");
  let candidatePath = "";
  const runner = (_command, _args, options) => {
    candidatePath = options.env.OPENCLAW_CONFIG_PATH;
    return { status: 0, stdout: '{"valid":true}', stderr: "" };
  };

  assert.deepEqual(validateCandidate(configPath, runner), { valid: true });
  assert.equal(candidatePath, `${configPath}.muad.candidate`);
  assert.throws(
    () =>
      validateCandidate(configPath, () => ({
        status: 1,
        stdout: "",
        stderr: "schema rejected",
      })),
    /schema rejected/,
  );
});

test("candidate validation verifies final model-visible Skill inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-skills-ok-"));
  const configPath = join(root, "openclaw.json");
  const workspace = join(root, "workspace-alice");
  const publicRoot = join(root, "public-skills");
  writeOpenClawSkill(join(publicRoot, "extract"), "extract");
  writeOpenClawSkill(join(workspace, "skills", "skill-vetter"), "skill-vetter");
  writeFileSync(
    `${configPath}.muad.candidate`,
    JSON.stringify(
      candidateWithSkills(["extract", "skill-vetter"], {
        workspace,
        extraDirs: [publicRoot],
      }),
    ),
  );
  const calls = [];
  const runner = (_command, args, options) => {
    calls.push({ args, configPath: options.env.OPENCLAW_CONFIG_PATH });
    return { status: 0, stdout: '{"valid":true}', stderr: "" };
  };

  assert.deepEqual(validateCandidate(configPath, runner), { valid: true });
  assert.deepEqual(
    calls.map((call) => call.args),
    [["config", "validate", "--json"]],
  );
  assert.equal(
    calls.every((call) => call.configPath === `${configPath}.muad.candidate`),
    true,
  );
});

test("candidate validation fails when final Skill inventory differs from runtime config", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-skills-missing-"));
  const configPath = join(root, "openclaw.json");
  const workspace = join(root, "workspace-alice");
  writeOpenClawSkill(join(workspace, "skills", "skill-vetter"), "skill-vetter");
  writeFileSync(
    `${configPath}.muad.candidate`,
    JSON.stringify(
      candidateWithSkills(["extract", "skill-vetter"], { workspace }),
    ),
  );
  const runner = (_command, args) => {
    if (args[0] === "config")
      return { status: 0, stdout: '{"valid":true}', stderr: "" };
    return {
      status: 0,
      stdout: JSON.stringify({
        skills: [{ name: "skill-vetter", modelVisible: true }],
      }),
      stderr: "",
    };
  };

  assert.throws(
    () => validateCandidate(configPath, runner),
    /OpenClaw skill validation failed for agent alice: missing model-visible Skills: extract/u,
  );
});

test("candidate validation rejects Skills without OpenClaw description frontmatter", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-skills-frontmatter-"));
  const configPath = join(root, "openclaw.json");
  const publicRoot = join(root, "public-skills");
  mkdirSync(join(publicRoot, "extract"), { recursive: true });
  writeFileSync(
    join(publicRoot, "extract", "SKILL.md"),
    "---\nname: extract\n---\n# Extract\n",
  );
  writeFileSync(
    `${configPath}.muad.candidate`,
    JSON.stringify(
      candidateWithSkills(["extract"], {
        workspace: join(root, "workspace-alice"),
        extraDirs: [publicRoot],
      }),
    ),
  );

  assert.throws(
    () =>
      validateCandidate(configPath, () => ({
        status: 0,
        stdout: '{"valid":true}',
        stderr: "",
      })),
    /OpenClaw skill validation failed for agent alice: missing model-visible Skills: extract/u,
  );
});

test("rollback before commit keeps the current valid config", () => {
  const root = mkdtempSync(join(tmpdir(), "muad-config-precommit-"));
  const configPath = join(root, "openclaw.json");
  const current = { gateway: { mode: "local" }, stable: true };
  writeFileSync(configPath, JSON.stringify(current));
  writeFileSync(
    `${configPath}.muad.previous`,
    JSON.stringify({ stable: false }),
  );
  prepareTransaction({ runtime: runtimeForRoot(root), configPath });

  rollbackTransaction(configPath);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), current);
  assert.equal(existsSync(`${configPath}.muad.candidate`), false);
});

test("binding-only runtime changes restart the gateway", () => {
  const current = restartBaseline();
  const next = restartBaseline();
  next.bindings = [
    {
      match: {
        channel: "mattermost",
        peer: { kind: "direct", id: "mm-user-1" },
      },
      agentId: "alice",
    },
  ];
  next.session.identityLinks = {
    alice: ["mattermost:default:direct:mm-user-1"],
  };
  next.plugins.entries["muad-runtime-guard"].config.generation = 8;

  assert.equal(selectRestartMode(current, next), "gateway");
});

test("non-binding runtime changes still restart the gateway", () => {
  const current = restartBaseline();
  const next = restartBaseline();
  next.plugins.entries["muad-runtime-guard"].config.generation = 8;
  next.plugins.entries["session-manager"].config.consoleInternalURL =
    "http://console-next/internal/v1";

  assert.equal(selectRestartMode(current, next), "gateway");
});

test("adding an agent browser profile does not require a pod restart", () => {
  const current = restartBaseline();
  current.browser = {
    enabled: true,
    profiles: { alice: { cdpPort: 18802, driver: "openclaw" } },
  };
  const next = restartBaseline();
  next.browser = {
    enabled: true,
    profiles: {
      alice: { cdpPort: 18802, driver: "openclaw" },
      bob: { cdpPort: 18803, driver: "openclaw" },
    },
  };
  next.bindings = [
    {
      match: {
        channel: "mattermost",
        peer: { kind: "direct", id: "mm-user-2" },
      },
      agentId: "bob",
    },
  ];
  next.session.identityLinks = { bob: ["mattermost:default:direct:mm-user-2"] };
  next.plugins.entries["muad-runtime-guard"].config.generation = 8;

  assert.equal(selectRestartMode(current, next), "gateway");
});

function restartBaseline() {
  return {
    browser: { enabled: false },
    bindings: [],
    session: { identityLinks: {} },
    plugins: {
      entries: {
        "muad-runtime-guard": { config: { generation: 7 } },
        "session-manager": {
          config: { consoleInternalURL: "http://console/internal/v1" },
        },
      },
    },
  };
}

function candidateWithSkills(skills, options = {}) {
  return {
    skills: {
      load: { extraDirs: options.extraDirs ?? [] },
    },
    agents: {
      list: [
        { id: "main", default: true, skills: [] },
        { id: "alice", workspace: options.workspace, skills },
      ],
    },
  };
}

function writeOpenClawSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test Skill.\n---\n# ${name}\n`,
  );
}

function runtimeForRoot(root) {
  const runtime = JSON.parse(readFileSync(fixturePath, "utf8"));
  runtime.skills.privateRoot = root;
  for (const agent of runtime.agents) {
    agent.workspace = join(root, `workspace-${agent.id}`);
    agent.agentDir = join(root, "agents", agent.id, "agent");
  }
  runtime.sessionManager.agents[0].workspace = runtime.agents[1].workspace;
  runtime.sessionManager.agents[0].storeDirectory = join(
    root,
    "agents",
    "alice",
    "session-store",
  );
  return runtime;
}

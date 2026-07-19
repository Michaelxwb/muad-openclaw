import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillExecutionLifecycle } from "../src/hook-lifecycle.mjs";
import {
  prepareTraditionalExecution,
  runTraditionalSkill,
  TraditionalScriptError,
} from "../src/traditional-runner.mjs";

const context = {
  agentId: "alice",
  runId: "run-traditional",
  sessionKey: "agent:alice:wecom:direct:user-a",
  workspaceDir: "/home/node/.openclaw/workspace-alice",
};

test("executes allowed Shell, Python, and Node scripts without a manifest", async () => {
  const skillDir = await createSkillDirectory();
  await fs.writeFile(path.join(skillDir, "scripts/run.sh"), "printf 'shell:%s' \"$1\"\n");
  await fs.writeFile(path.join(skillDir, "scripts/run.py"), "import sys; print('python:' + sys.argv[1], end='')\n");
  await fs.writeFile(path.join(skillDir, "scripts/run.js"), "process.stdout.write('node:' + process.argv[2]);\n");
  const cases = [
    ["scripts/run.sh", "shell:ok"],
    ["scripts/run.py", "python:ok"],
    ["scripts/run.js", "node:ok"],
  ];
  for (const [scriptPath, expected] of cases) {
    const reports = [];
    const lifecycle = createLifecycle(reports);
    const grant = createGrant(skillDir, cases.map(([file]) => file));
    const manifest = await prepareTraditionalExecution({
      lifecycle, context: { ...context, runId: `run-${scriptPath}` }, grant,
      params: { scriptPath, args: ["ok"], input: "" },
    });
    const result = await runTraditionalSkill({
      manifest, trustedContext: context, stateDir: os.tmpdir(), deliver: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.outputs[0].stdout, expected);
  }
});

test("rejects traversal, absolute, hidden, unknown, directory, and symlink escape paths", async () => {
  const skillDir = await createSkillDirectory();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "muad-outside-"));
  const marker = path.join(outsideDir, "executed");
  const outsideScript = path.join(outsideDir, "outside.sh");
  await fs.writeFile(outsideScript, `touch ${JSON.stringify(marker)}\n`);
  await fs.mkdir(path.join(skillDir, "scripts/directory"));
  await fs.mkdir(path.join(skillDir, ".hidden"));
  await fs.writeFile(path.join(skillDir, ".hidden/run.sh"), "exit 0\n");
  await fs.symlink(outsideScript, path.join(skillDir, "scripts/escape.sh"));
  const rejected = [
    "/tmp/run.sh", "../outside.sh", ".hidden/run.sh", "scripts/unknown.sh",
    "scripts/directory", "scripts/escape.sh",
  ];
  for (const scriptPath of rejected) {
    const reports = [];
    await assert.rejects(
      prepareTraditionalExecution({
        lifecycle: createLifecycle(reports), context, grant: createGrant(skillDir, [
          "scripts/escape.sh", ".hidden/run.sh", "scripts/directory",
        ]),
        params: { scriptPath, args: [], input: "" },
      }),
      (error) => error instanceof TraditionalScriptError && error.code === "skill_script_rejected",
    );
    assert.equal(reports.at(-1).status, "rejected");
    assert.equal(reports.at(-1).errorCode, "skill_script_rejected");
  }
  await assert.rejects(fs.stat(marker), (error) => error.code === "ENOENT");
});

function createLifecycle(reports) {
  return new SkillExecutionLifecycle({
    randomUUID: () => `execution-${reports.length + 1}`,
    reporterFactory: ({ execution }) => ({
      report(update) {
        reports.push({ ...execution, ...update });
        return Promise.resolve(true);
      },
    }),
  });
}

function createGrant(rootPath, scriptFiles) {
  return {
    name: "traditional-report", source: "private", skillId: "skill-report",
    version: "sha256:test", entryType: "traditional-script", rootPath, scriptFiles,
  };
}

async function createSkillDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muad-traditional-"));
  const skillDir = path.join(root, "traditional-report");
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Traditional report\n");
  return skillDir;
}

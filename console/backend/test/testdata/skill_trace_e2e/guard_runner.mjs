// TASK-012 cross-boundary E2E harness: drives the real runtime-guard modules.
//
// Phase "full": resolve the exec env through the shipped guard hook, run the
// Python skill with that env, then hand the finished exec to afterToolCall so
// the real spool parser, bounded queue and SkillTraceClient upload to Console.
// Phase "upload": only the afterToolCall half, used to replay a retained spool
// after a simulated Console upgrade (E-11).
//
// Configuration is passed as JSON in E2E_CONFIG; the result is printed as one
// JSON document on stdout.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const guardSrc = process.env.GUARD_SRC;
if (!guardSrc) throw new Error("GUARD_SRC is required");
const load = (file) => import(pathToFileURL(path.join(guardSrc, file)).href);

const { createSkillTraceExecutions } = await load("skill-trace-executions.mjs");
const { createSkillTraceHooks } = await load("skill-trace.mjs");
const { SkillTraceClient } = await load("skill-trace-client.mjs");

const cfg = JSON.parse(process.env.E2E_CONFIG);
const executions = createSkillTraceExecutions();
executions.register({
  executionId: cfg.executionId,
  agentId: cfg.agentId,
  sessionKey: cfg.sessionKey,
  runId: cfg.runId,
  skillName: cfg.skillName,
});
const notifications = [];
const hooks = createSkillTraceHooks({
  getConfig: () => ({ skillRequestLimit: cfg.limit, locale: "zh" }),
  executions,
  client: new SkillTraceClient({
    baseURL: cfg.baseURL,
    readToken: async () => cfg.podToken,
  }),
  notify: async (input) => {
    notifications.push(input);
    return { ok: true };
  },
  spoolRoot: cfg.spoolRoot,
});
const event = { toolName: "exec", runId: cfg.runId, sessionKey: cfg.sessionKey };
const env = await hooks.resolveExecEnv(event, { agentId: cfg.agentId });
if (!env) throw new Error("guard did not inject trace env");
const spool = env.MUAD_TRACE_SPOOL;
const modes = {
  spool: statSync(spool).mode & 0o777,
  root: statSync(cfg.spoolRoot).mode & 0o777,
};

let exitCode = 0;
let stdout = "";
let stderr = "";
if (cfg.mode !== "upload") {
  const started = Date.now();
  const child = spawn(cfg.python, [cfg.script, ...cfg.args], {
    env: { ...process.env, ...env },
    cwd: cfg.cwd ?? cfg.spoolRoot,
  });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  event.durationMs = Date.now() - started;
}
event.params = { command: cfg.command ?? "python3 skill.py" };
if (exitCode !== 0) event.error = { stderr: stderr.slice(0, 500) };

await hooks.afterToolCall(event, { agentId: cfg.agentId });
await hooks.flush();
console.log(JSON.stringify({
  env,
  modes,
  exitCode,
  stdout,
  stderr,
  notifications,
  spool,
  spoolExists: existsSync(spool),
}));

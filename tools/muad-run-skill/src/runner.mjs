import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildSkillEnvironment } from "./execution-context.mjs";

const MAX_STREAM_CHARS = 256 * 1024;

export async function runSkill({
  manifest,
  trustedContext,
  input = "",
  args = {},
  stateDir,
  signal,
  deliver,
  baseEnv = process.env,
}) {
  const startedAt = Date.now();
  const workDir = await createWorkDirectory(stateDir);
  const eventFile = path.join(workDir, "progress.events.jsonl");
  const env = buildSkillEnvironment({
    baseEnv, context: trustedContext, manifest, input, args, eventFile, workDir,
  });
  const outputs = [];
  const manualProgress = manifest.progress?.source === "manual";
  try {
    if (!manualProgress) await deliver(autoEvent(manifest.name, "accepted", "任务已接收，开始执行"));
    const failure = manifest.mode === "steps"
      ? await executeSteps({ manifest, env, eventFile, signal, deliver, outputs })
      : await executeEntrypoint({ manifest, env, eventFile, signal, deliver, outputs });
    if (failure) return result(false, manifest.name, startedAt, outputs, failure);
    if (!manualProgress) await deliver(autoEvent(manifest.name, "done", "全部步骤完成", "done"));
    return result(true, manifest.name, startedAt, outputs);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function executeSteps({ manifest, env, eventFile, signal, deliver, outputs }) {
  for (const step of manifest.steps) {
    await deliver(autoEvent(manifest.name, step.id, `正在${step.title}`));
    const commandResult = await runCommand({
      command: step.command, manifest, env, eventFile, signal, deliver,
    });
    outputs.push({ step: step.id, command: commandText(step.command), ...commandResult });
    if (commandResult.code !== 0) {
      await deliver(autoEvent(manifest.name, step.id, `${step.title}失败`, "error"));
      return step.id;
    }
    await deliver(autoEvent(manifest.name, step.id, `${step.title}完成`, "done"));
  }
  return "";
}

async function executeEntrypoint({ manifest, env, eventFile, signal, deliver, outputs }) {
  const commandResult = await runCommand({
    command: manifest.entrypoint, manifest, env, eventFile, signal, deliver,
  });
  outputs.push({ step: "entrypoint", command: commandText(manifest.entrypoint), ...commandResult });
  if (commandResult.code === 0) return "";
  await deliver(autoEvent(manifest.name, "entrypoint", "任务执行失败", "error"));
  return "entrypoint";
}

async function runCommand({ command, manifest, env, eventFile, signal, deliver }) {
  const eventState = { offset: 0, draining: Promise.resolve() };
  const interval = setInterval(() => {
    eventState.draining = eventState.draining
      .then(() => drainBestEffort(eventFile, eventState, deliver))
      .catch(() => {});
  }, 250);
  try {
    const commandResult = await runProcess({ command, cwd: manifest.skillDir, env, signal });
    await eventState.draining;
    await drainEvents(eventFile, eventState, deliver);
    return commandResult;
  } finally {
    clearInterval(interval);
    await eventState.draining;
    await drainBestEffort(eventFile, eventState, deliver);
  }
}

function runProcess({ command, cwd, env, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk.toString("utf8")); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk.toString("utf8")); });
    child.on("error", (error) => {
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code, signalName) => {
      const exitCode = code === null || code === undefined
        ? (signalName ? 128 : -1)
        : code;
      resolve({ code: exitCode, signal: signalName || null, stdout, stderr });
    });
  });
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_STREAM_CHARS) return current;
  const next = current + chunk;
  if (next.length <= MAX_STREAM_CHARS) return next;
  return `${next.slice(0, MAX_STREAM_CHARS)}\n...[truncated]`;
}

async function drainEvents(filePath, state, deliver) {
  const read = await readEvents(filePath, state.offset);
  state.offset = read.offset;
  for (const event of read.events) await deliver(event);
}

async function drainBestEffort(filePath, state, deliver) {
  try {
    await drainEvents(filePath, state, deliver);
  } catch {
    console.warn("[muad-run-skill] progress event drain failed");
  }
}

async function readEvents(filePath, offset) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { events: [], offset };
    throw error;
  }
  try {
    const details = await handle.stat();
    if (details.size <= offset) return { events: [], offset };
    const buffer = Buffer.alloc(details.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const events = buffer.toString("utf8").split("\n").map((line) => line.trim())
      .filter(Boolean).map((line) => JSON.parse(line));
    return { events, offset: details.size };
  } finally {
    await handle.close();
  }
}

async function createWorkDirectory(stateDir) {
  const root = stateDir || os.tmpdir();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return fs.mkdtemp(path.join(root, "muad-run-skill-"));
}

function autoEvent(skill, stage, text, type = "progress") {
  return {
    type, skill, stage, text,
    visibility: "channel", privacy: "public", ts: new Date().toISOString(),
  };
}

function result(ok, skill, startedAt, outputs, failedStep = "") {
  return {
    ok, skill,
    ...(failedStep ? { failedStep } : {}),
    durationMs: Date.now() - startedAt,
    outputs,
  };
}

function commandText(command) {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

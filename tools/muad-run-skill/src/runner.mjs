import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandText(command) {
  return command.map(shellQuote).join(" ");
}

function nowIso() {
  return new Date().toISOString();
}

function createAutoEvent({ skill, stage, text, type = "progress" }) {
  return {
    type,
    skill,
    stage,
    text,
    visibility: "channel",
    privacy: "public",
    ts: nowIso(),
  };
}

async function readEvents(filePath, offset) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { events: [], offset };
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) {
      return { events: [], offset };
    }
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString("utf8");
    const events = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { events, offset: stat.size };
  } finally {
    await handle.close();
  }
}

async function drainEvents(filePath, state, deliver) {
  const result = await readEvents(filePath, state.offset);
  state.offset = result.offset;
  for (const event of result.events) {
    await deliver(event);
  }
}

function runProcess({ command, cwd, env, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(err.message ?? err)}`.trim() });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function runCommand({ command, manifest, env, eventFile, signal, deliver }) {
  const eventState = { offset: 0 };
  const interval = setInterval(() => {
    drainEvents(eventFile, eventState, deliver).catch(() => undefined);
  }, 250);
  try {
    const result = await runProcess({
      command,
      cwd: manifest.skillDir,
      env,
      signal,
    });
    await drainEvents(eventFile, eventState, deliver);
    return result;
  } finally {
    clearInterval(interval);
    await drainEvents(eventFile, eventState, deliver).catch(() => undefined);
  }
}

export async function runSkill({ manifest, input = "", args = {}, stateDir, signal, deliver }) {
  const runId = `${manifest.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workDir = await fs.mkdtemp(path.join(stateDir || os.tmpdir(), "muad-run-skill-"));
  const eventFile = path.join(workDir, `${runId}.events.jsonl`);
  const env = {
    ...process.env,
    MUAD_SKILL_NAME: manifest.name,
    MUAD_SKILL_INPUT: input,
    MUAD_SKILL_ARGS_JSON: JSON.stringify(args ?? {}),
    MUAD_PROGRESS_EVENTS_FILE: eventFile,
    MUAD_PROGRESS_STATE_DIR: workDir,
  };
  const startedAt = Date.now();
  const outputs = [];
  const manualProgress = manifest.progress?.source === "manual";
  if (!manualProgress) {
    await deliver(
      createAutoEvent({
        skill: manifest.name,
        stage: "accepted",
        text: "任务已接收，开始执行",
      }),
    );
  }
  if (manifest.mode === "steps") {
    for (const step of manifest.steps) {
      await deliver(
        createAutoEvent({
          skill: manifest.name,
          stage: step.id,
          text: `正在${step.title}`,
        }),
      );
      const result = await runCommand({
        command: step.command,
        manifest,
        env,
        eventFile,
        signal,
        deliver,
      });
      outputs.push({ step: step.id, command: commandText(step.command), ...result });
      if (result.code !== 0) {
        await deliver(
          createAutoEvent({
            skill: manifest.name,
            stage: step.id,
            text: `${step.title}失败`,
            type: "error",
          }),
        );
        return {
          ok: false,
          skill: manifest.name,
          failedStep: step.id,
          durationMs: Date.now() - startedAt,
          outputs,
        };
      }
      await deliver(
        createAutoEvent({
          skill: manifest.name,
          stage: step.id,
          text: `${step.title}完成`,
          type: "done",
        }),
      );
    }
  } else {
    const result = await runCommand({
      command: manifest.entrypoint,
      manifest,
      env,
      eventFile,
      signal,
      deliver,
    });
    outputs.push({ step: "entrypoint", command: commandText(manifest.entrypoint), ...result });
    if (result.code !== 0) {
      await deliver(
        createAutoEvent({
          skill: manifest.name,
          stage: "entrypoint",
          text: "任务执行失败",
          type: "error",
        }),
      );
      return {
        ok: false,
        skill: manifest.name,
        failedStep: "entrypoint",
        durationMs: Date.now() - startedAt,
        outputs,
      };
    }
  }
  if (!manualProgress) {
    await deliver(
      createAutoEvent({
        skill: manifest.name,
        stage: "done",
        text: "全部步骤完成",
        type: "done",
      }),
    );
  }
  return {
    ok: true,
    skill: manifest.name,
    durationMs: Date.now() - startedAt,
    outputs,
  };
}

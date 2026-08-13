#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createInstalledAdapterRegistry,
  SessionStore,
} from "../dist/index.js";
import { runCLI } from "../dist/cli.js";

const AGENT_ID = "alice";
const HUMAN_USER_ID = "user-a";
const POD_ID = "pod-a";
const PLATFORM = "smoke_platform";
const SKILL_NAME = "smoke-platform";

export async function runSmokeSessionFlow(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "session-smoke-agents-"));
  const stateDir = mkdtempSync(join(tmpdir(), "session-smoke-state-"));
  const server = await startFakePlatform(options.python || "python3");
  const calls = [];
  try {
    const resolver = makeResolver(server.baseUrl, calls);
    const first = await getState(root, resolver);
    const firstSkill = runSkill(first, root, server.baseUrl, stateDir);
    const second = await getState(root, resolver);
    const secondSkill = runSkill(second, root, server.baseUrl, stateDir);
    return summary(server.baseUrl, calls, first, second, firstSkill, secondSkill);
  } finally {
    await stopServer(server.child);
    if (!options.keepArtifacts) {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

async function startFakePlatform(python) {
  const script = fileURLToPath(new URL("../../fake-business-platform/server.py", import.meta.url));
  const child = spawn(python, [script, "--host", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  const ready = await readReady(child);
  return { child, baseUrl: ready.baseUrl };
}

function readReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`fake platform did not start: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      clearTimeout(timer);
      try {
        resolve(parseReady(buffer.slice(0, lineEnd)));
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake platform exited before ready: ${code} ${stderr}`));
    });
  });
}

function parseReady(line) {
  const value = JSON.parse(line);
  if (value.status !== "ready" || typeof value.baseUrl !== "string") {
    throw new Error(`invalid fake platform ready line: ${line}`);
  }
  return value;
}

async function getState(root, resolver) {
  const log = (message) => console.warn(message);
  const result = await runCLI(
    ["get-state", "--skill-name", SKILL_NAME],
    {
      MUAD_SESSION_KEY: `agent:${AGENT_ID}:smoke:direct:${HUMAN_USER_ID}`,
      MUAD_CONSOLE_INTERNAL_URL: "http://mock-console.invalid",
    },
    resolver,
    {
      store: new SessionStore({ rootDir: root }),
      adapters: createInstalledAdapterRegistry(undefined, log),
      adapterTimeoutMs: 5_000,
      lock: { waitMs: 5_000, pollMs: 10 },
      log,
    },
  );
  if (result.exitCode !== 0) throw new Error(`session-manager smoke failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function makeResolver(baseUrl, calls) {
  return {
    resolve: async (request) => {
      calls.push(request);
      if (request.agentId !== AGENT_ID || request.skillName !== SKILL_NAME) {
        throw new Error("unexpected resolve request");
      }
      return resolvedCredential(baseUrl);
    },
  };
}

function resolvedCredential(baseUrl) {
  return {
    humanUserId: HUMAN_USER_ID,
    podId: POD_ID,
    agentId: AGENT_ID,
    skillName: SKILL_NAME,
    platforms: [{
      platform: PLATFORM,
      credentialFingerprint: "sha256:smoke-demo",
      credentials: {
        baseUrl,
        sessionEndpoint: "/login",
        healthEndpoint: "/health/session",
        sessionTtlSeconds: 300,
        username: "demo",
        password: "demo-pass",
      },
    }],
  };
}

function runSkill(state, root, baseUrl, stateDir) {
  const cliStub = join(stateDir, "session-manager-stub.mjs");
  writeFileSync(cliStub, `import { stdout } from "node:process";\nstdout.write(${JSON.stringify(`${JSON.stringify(state)}\n`)});\n`);
  const script = fileURLToPath(new URL("../../../skills/smoke-platform/scripts/run.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      SESSION_MANAGER_CLI_JS: cliStub,
      SMOKE_BUSINESS_BASE_URL: baseUrl,
      SMOKE_PLATFORM: PLATFORM,
    },
  });
  if (result.status !== 0) throw new Error(`smoke Skill failed: ${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}

function summary(baseUrl, calls, first, second, firstSkill, secondSkill) {
  return {
    status: "SMOKE_OK",
    baseUrl,
    resolveCalls: calls.length,
    first: trimState(first),
    second: trimState(second),
    firstSkill,
    secondSkill,
  };
}

function trimState(state) {
  return {
    source: state.source,
    skillName: state.skillName,
    platform: state.platforms[0].platform,
    platformSource: state.platforms[0].source,
  };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function main() {
  const result = await runSmokeSessionFlow({ keepArtifacts: process.argv.includes("--keep-artifacts") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

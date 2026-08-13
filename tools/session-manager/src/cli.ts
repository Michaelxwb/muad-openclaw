#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadCLIConfig } from "./config.js";
import { SESSION_MANAGER_VERSION, SKILL_PATTERN } from "./constants/runtime.js";
import { SessionManagerError, normalizeSessionError } from "./errors.js";
import { ResolverClient } from "./resolver-client.js";
import { SessionService, type SessionServiceOptions } from "./service.js";
import type { Resolver } from "./types.js";

export type CLIResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runCLI(
  args: readonly string[], env: NodeJS.ProcessEnv, resolver?: Resolver,
  serviceOptions?: SessionServiceOptions,
): Promise<CLIResult> {
  try {
    if (args.length === 1 && args[0] === "--version") return success({ version: SESSION_MANAGER_VERSION });
    if (args.length === 1 && args[0] === "--help") {
      return success({
        version: SESSION_MANAGER_VERSION,
        usage: "session-manager get-state --skill-name <name>",
      });
    }
    const parsed = parseGetStateArgs(args);
    const config = loadCLIConfig(env);
    const service = new SessionService(
      resolver ?? new ResolverClient({ baseURL: config.consoleInternalURL }), serviceOptions,
    );
    return success(await service.getState(config.trustedContext, parsed.skillName));
  } catch (error) {
    return failure(normalizeSessionError(error));
  }
}

type GetStateArgs = {
  skillName: string;
};

function parseGetStateArgs(args: readonly string[]): GetStateArgs {
  if (args.length < 3 || args[0] !== "get-state" || args.length % 2 !== 1) {
    throw new SessionManagerError("invalid_arguments");
  }
  const values = parseOptionPairs(args.slice(1));
  const skillName = String(values.get("skill-name") ?? "").trim();
  if (!SKILL_PATTERN.test(skillName)) throw new SessionManagerError("invalid_arguments");
  return { skillName };
}

function parseOptionPairs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = String(args[index] ?? "");
    const value = String(args[index + 1] ?? "");
    if (!key.startsWith("--") || value === "" || values.has(key.slice(2))) {
      throw new SessionManagerError("invalid_arguments");
    }
    if (key !== "--skill-name") throw new SessionManagerError("invalid_arguments");
    values.set(key.slice(2), value);
  }
  return values;
}

function success(data: unknown): CLIResult {
  return { exitCode: 0, stdout: `${JSON.stringify(data)}\n`, stderr: "" };
}

function failure(error: SessionManagerError): CLIResult {
  const body = {
    version: SESSION_MANAGER_VERSION,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      reason: error.reason,
      ...(error.platform !== undefined ? { platform: error.platform } : {}),
      ...(error.businessCode !== undefined ? { businessCode: error.businessCode } : {}),
    },
  };
  return { exitCode: error.exitCode, stdout: "", stderr: `${JSON.stringify(body)}\n` };
}

async function main(): Promise<void> {
  // CLI 是独立进程（skill 脚本通过 `get-state` 调用），日志走 stderr 便于脚本透传；
  // openclaw 插件路径（session_get_state 工具）则由 openclaw-plugin.mjs 注入 api.logger。
  const result = await runCLI(
    process.argv.slice(2),
    process.env,
    undefined,
    { log: (message) => console.warn(message) },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

function isMainModule(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1])) void main();

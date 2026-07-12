#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadCLIConfig } from "./config.js";
import { PLATFORM_PATTERN, SESSION_MANAGER_VERSION } from "./constants/runtime.js";
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
      return success({ version: SESSION_MANAGER_VERSION, usage: "session-manager get-state --platform <name>" });
    }
    const platform = parseGetStateArgs(args);
    const config = loadCLIConfig(env);
    const service = new SessionService(
      resolver ?? new ResolverClient({ baseURL: config.consoleInternalURL }), serviceOptions,
    );
    return success(await service.getState(config.trustedContext, platform));
  } catch (error) {
    return failure(normalizeSessionError(error));
  }
}

function parseGetStateArgs(args: readonly string[]): string {
  if (args.length !== 3 || args[0] !== "get-state" || args[1] !== "--platform") {
    throw new SessionManagerError("invalid_arguments");
  }
  const platform = String(args[2] ?? "").trim();
  if (!PLATFORM_PATTERN.test(platform)) throw new SessionManagerError("invalid_arguments");
  return platform;
}

function success(data: unknown): CLIResult {
  return { exitCode: 0, stdout: `${JSON.stringify(data)}\n`, stderr: "" };
}

function failure(error: SessionManagerError): CLIResult {
  const body = {
    version: SESSION_MANAGER_VERSION,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
  return { exitCode: error.exitCode, stdout: "", stderr: `${JSON.stringify(body)}\n` };
}

async function main(): Promise<void> {
  const result = await runCLI(process.argv.slice(2), process.env);
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

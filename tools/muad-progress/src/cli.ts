#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArguments, type ParsedArguments } from "./arguments.js";
import { appendEvent, type Delivery } from "./delivery.js";
import { normalizeProgressError, ProgressError } from "./errors.js";
import { validateEvent, type ProgressEvent } from "./protocol.js";

export const MUAD_PROGRESS_VERSION = "0.2.0";

export type CLIResult = { exitCode: number; stdout: string; stderr: string };

const HELP = `muad-progress reports user-visible skill progress.

Usage:
  muad-progress stage --stage <id> --text <text> [--skill <name>] [--id <id>] [--json]
  muad-progress done --stage <id> --text <text> [--raw] [--media <path>]... [--skill <name>] [--id <id>] [--json]
  muad-progress error --stage <id> --text <text> [--code <code>] [--id <id>] [--json]
  muad-progress validate --stage <id> --text <text> [--skill <name>] [--id <id>] [--json]
`;

export function runCLI(args: readonly string[], env: NodeJS.ProcessEnv): CLIResult {
  if (args.length === 1 && args[0] === "--help") return textSuccess(HELP);
  if (args.length === 1 && args[0] === "--version") {
    return textSuccess(`muad-progress ${MUAD_PROGRESS_VERSION}\n`);
  }
  const jsonOutput = args.includes("--json");
  let command = "";
  try {
    const parsed = parseArguments(args);
    command = parsed.command;
    const event = buildEvent(parsed, env, new Date());
    if (parsed.command === "validate") return eventSuccess("validated", event, parsed.jsonOutput);
    const delivery = appendEvent(env.MUAD_PROGRESS_EVENTS_FILE, event);
    if (delivery === "skipped" && strictBridge(env)) throw new ProgressError("bridge_unavailable");
    return eventSuccess(delivery, event, parsed.jsonOutput);
  } catch (error) {
    const normalized = normalizeProgressError(error);
    appendDiagnosticEvent(env, command, normalized.code);
    return failure(normalized, jsonOutput);
  }
}

// 失败也经事件文件回传一条 type="log" 诊断事件，让 runtime-guard 能把
// muad-progress 的失败原因写进 openclaw 日志（无事件文件时静默跳过——
// bridge_unavailable 场景本身写不进文件，由 exec stderr 链路兜底）。
function appendDiagnosticEvent(env: NodeJS.ProcessEnv, command: string, code: string): void {
  try {
    appendEvent(env.MUAD_PROGRESS_EVENTS_FILE, {
      type: "log",
      stage: command || "cli",
      text: `error=${code}`,
      visibility: "channel",
      privacy: "public",
      ts: new Date().toISOString(),
    });
  } catch {
    // 诊断事件是尽力而为，绝不改变 CLI 的错误返回。
  }
}

function buildEvent(parsed: ParsedArguments, env: NodeJS.ProcessEnv, now: Date): ProgressEvent {
  const skill = parsed.skill ?? normalizedOptional(env.MUAD_SKILL_NAME);
  return validateEvent({
    type: parsed.type,
    stage: parsed.stage,
    text: parsed.text,
    visibility: "channel",
    privacy: "public",
    ts: now.toISOString(),
    ...(skill === undefined ? {} : { skill }),
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(parsed.code === undefined ? {} : { code: parsed.code }),
    ...(parsed.rawOutput ? { raw: true as const } : {}),
    ...(parsed.media.length === 0 ? {} : { media: parsed.media }),
  });
}

function strictBridge(env: NodeJS.ProcessEnv): boolean {
  return truthy(env.MUAD_PROGRESS_STRICT_BRIDGE) || truthy(env.MUAD_PROGRESS_STRICT_ADAPTER);
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function eventSuccess(delivery: Delivery | "validated", event: ProgressEvent, json: boolean): CLIResult {
  const stdout = json ? `${JSON.stringify({ ok: true, delivery, event })}\n` : "";
  return { exitCode: 0, stdout, stderr: "" };
}

function textSuccess(stdout: string): CLIResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(error: ProgressError, json: boolean): CLIResult {
  const stderr = json
    ? `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } })}\n`
    : `muad-progress: ${error.code}\n`;
  return { exitCode: error.exitCode, stdout: "", stderr };
}

function main(): void {
  const result = runCLI(process.argv.slice(2), process.env);
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

if (isMainModule(process.argv[1])) main();

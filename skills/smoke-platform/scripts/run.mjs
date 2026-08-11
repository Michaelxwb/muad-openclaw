#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_SKILL_NAME = "smoke-platform";
export const DEFAULT_PLATFORM = "smoke_platform";
export const DEFAULT_BUSINESS_BASE_URL = "http://host.docker.internal:18080";

async function main() {
  const state = callSessionManager();
  const platformState = selectPlatform(state);
  const cookies = await readCookies(state.sessionStateFile, platformState.platform);
  const profile = await fetchProfile(cookies);
  process.stdout.write(`${JSON.stringify({
    status: "SMOKE_OK",
    platform: platformState.platform,
    source: platformState.source,
    user: profile.user,
    authenticated: profile.authenticated,
  })}\n`);
}

// Identity is not self-reported: Runtime Guard injects the trusted
// MUAD_SESSION_KEY into the exec env, and the CLI derives the agent from it.
function callSessionManager() {
  const skillName = process.env.SMOKE_SKILL_NAME || DEFAULT_SKILL_NAME;
  const args = ["get-state", "--skill-name", skillName];
  const command = sessionManagerCommand(args);
  const result = spawnSync(command.bin, command.args, {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`session-manager failed: ${result.stderr || result.error?.message || result.status}`);
  }
  return parseJSON(result.stdout, "session-manager stdout");
}

function sessionManagerCommand(args) {
  if (process.env.SESSION_MANAGER_CLI_JS) {
    return { bin: process.execPath, args: [process.env.SESSION_MANAGER_CLI_JS, ...args] };
  }
  return { bin: process.env.SESSION_MANAGER_BIN || "session-manager", args };
}

export function selectPlatform(state, env = process.env) {
  const platform = String(env.SMOKE_PLATFORM || DEFAULT_PLATFORM).trim();
  if (!Array.isArray(state.platforms) || state.platforms.length === 0) throw new Error("state has no platforms");
  const selected = state.platforms.find((item) => item.platform === platform);
  if (!selected) throw new Error(`platform session is missing: ${platform}`);
  return selected;
}

export async function readCookies(sessionStateFile, platform) {
  const session = parseJSON(await readFile(sessionStateFile, "utf8"), "session state file");
  const section = session?.platforms?.[platform];
  if (!Array.isArray(section?.cookies)) throw new Error(`session state file is missing cookies for platform: ${platform}`);
  return section.cookies.map((cookie) => {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
      throw new Error("session state file contained an invalid cookie");
    }
    return `${cookie.name}=${cookie.value}`;
  }).join("; ");
}

async function fetchProfile(cookieHeader) {
  const baseUrl = businessBaseUrl();
  const response = await fetch(new URL("/api/me", withTrailingSlash(baseUrl)), {
    headers: { Cookie: cookieHeader },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`business profile request failed: ${response.status} ${body}`);
  const payload = parseJSON(body, "/api/me response");
  if (payload.authenticated !== true || typeof payload.user !== "string") {
    throw new Error("business profile response was not authenticated");
  }
  return payload;
}

export function businessBaseUrl(env = process.env) {
  return String(env.SMOKE_BUSINESS_BASE_URL || DEFAULT_BUSINESS_BASE_URL).trim();
}

function parseJSON(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

if (isMainModule(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(argvPath) {
  return Boolean(argvPath) && import.meta.url === pathToFileURL(argvPath).href;
}

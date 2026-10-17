import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { parseGuardConfig } from "./config.mjs";
import { cancelCapabilityOf } from "./long-task-cancel-rpc.mjs";
import { sessionCancelCapabilityOf } from "./session-cancel-rpc.mjs";

export const RUNTIME_GUARD_VERSION = 2;

export function runtimeHealth(config, globals = globalThis) {
  const sessionManager = globals[Symbol.for("muad.session-manager.health")];
  const browserQueue = globals[Symbol.for("muad.browser.lease")];
  const skillQueue = globals[Symbol.for("muad.skill.lease")];
  const longTaskQueue = globals[Symbol.for("muad.longtask.manager")];
  const cancelCapability = cancelCapabilityOf(globals);
  const sessionCancelCapability = sessionCancelCapabilityOf(globals);
  const sessionManagerLoaded = sessionManager?.loaded === true;
  const browser = queueSnapshot(browserQueue, config.maxBrowserConcurrency);
  const skill = queueSnapshot(skillQueue, config.maxSkillConcurrency);
  const longTask = queueSnapshot(longTaskQueue, config.maxLongTaskConcurrency);
  const browserGuardLoaded = browserQueue && typeof browserQueue.snapshot === "function";
  const skillGuardLoaded = skillQueue && typeof skillQueue.snapshot === "function";
  const longTaskGuardLoaded = longTaskQueue && typeof longTaskQueue.snapshot === "function";
  // 取消能力只在链路完整（manager 支持取消 + 原生 abort/drain 可用）时报告；
  // 缺失时明确 available=false，不推断 canCancel=true，也不影响整体健康。
  const longTaskCancel = {
    available: cancelCapability?.available === true &&
      typeof longTaskQueue?.cancelTask === "function" &&
      typeof longTaskQueue?.taskStatus === "function",
    version: Number.isInteger(cancelCapability?.version) ? cancelCapability.version : 0,
  };
  // 会话终止能力：只有 native abort/drain 加载成功才 available=true, version=1；
  // 缺失时给出稳定 reason，Console 据此明确不可用而不做危险兜底。
  const sessionCancel = {
    available: sessionCancelCapability?.available === true,
    version: Number.isInteger(sessionCancelCapability?.version) ? sessionCancelCapability.version : 0,
    reason: typeof sessionCancelCapability?.reason === "string"
      ? sessionCancelCapability.reason
      : (sessionCancelCapability?.available === true ? "" : "native_unavailable"),
  };
  return {
    ok: config.valid && sessionManagerLoaded && Boolean(browserGuardLoaded) &&
      Boolean(skillGuardLoaded) && Boolean(longTaskGuardLoaded),
    version: RUNTIME_GUARD_VERSION,
    generation: config.generation,
    mappings: config.agentProfiles.length,
    sessionManager: {
      loaded: sessionManagerLoaded,
      version: Number.isInteger(sessionManager?.version) ? sessionManager.version : 0,
    },
    browser,
    skill,
    longTask,
    longTaskCancel,
    sessionCancel,
  };
}

export function createHealthHandler(config, globals = globalThis, options = {}) {
  return async () => runtimeHealth(latestGuardConfig(config, options.readConfig), globals);
}

export function latestGuardConfig(fallback, readConfig = readOpenClawConfig) {
  try {
    const current = readConfig();
    const pluginConfig = current?.plugins?.entries?.["muad-runtime-guard"]?.config;
    const parsed = parseGuardConfig(pluginConfig);
    if (parsed.valid) return parsed;
  } catch {
    // During atomic config replacement the file may be temporarily unreadable;
    // keep reporting the last in-memory config until the next probe.
  }
  return fallback;
}

function queueSnapshot(queue, fallbackLimit) {
  if (!queue || typeof queue.snapshot !== "function") {
    return { active: 0, queued: 0, limit: fallbackLimit };
  }
  const snapshot = queue.snapshot();
  return {
    active: nonNegative(snapshot?.active),
    queued: nonNegative(snapshot?.queued),
    limit: positive(snapshot?.limit, fallbackLimit),
  };
}

function nonNegative(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function positive(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readOpenClawConfig() {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

function configPath() {
  const explicit = String(process.env.OPENCLAW_CONFIG_PATH ?? "").trim();
  if (explicit) return explicit;
  const state = String(process.env.OPENCLAW_STATE_DIR ?? `${homedir()}/.openclaw`).trim();
  return `${state.replace(/\/$/u, "")}/openclaw.json`;
}

export const RUNTIME_GUARD_VERSION = 2;

export function runtimeHealth(config, globals = globalThis) {
  const sessionManager = globals[Symbol.for("muad.session-manager.health")];
  const skillQueue = globals[Symbol.for("muad.run-skill.queue")];
  const skillTelemetry = globals[Symbol.for("muad.run-skill.telemetry")];
  const browserQueue = globals[Symbol.for("muad.browser.lease")];
  const sessionManagerLoaded = sessionManager?.loaded === true;
  const skill = queueSnapshot(skillQueue, config.maxSkillConcurrency);
  const skillRunnerLoaded = skillQueue && typeof skillQueue.snapshot === "function";
  const telemetry = telemetrySnapshot(skillTelemetry);
  const browser = queueSnapshot(browserQueue, config.maxBrowserConcurrency);
  const browserGuardLoaded = browserQueue && typeof browserQueue.snapshot === "function";
  return {
    ok: config.valid && sessionManagerLoaded && Boolean(skillRunnerLoaded) &&
      Boolean(browserGuardLoaded) && telemetry.loaded && !telemetry.writeFailed,
    version: RUNTIME_GUARD_VERSION,
    generation: config.generation,
    mappings: config.agentProfiles.length,
    sessionManager: {
      loaded: sessionManagerLoaded,
      version: Number.isInteger(sessionManager?.version) ? sessionManager.version : 0,
    },
    skill,
    browser,
    telemetry,
  };
}

function telemetrySnapshot(client) {
  if (!client || typeof client.snapshot !== "function") {
    return { loaded: false, pending: 0, writeFailed: true, dropped: 0, lastError: "unavailable" };
  }
  const snapshot = client.snapshot();
  return {
    loaded: true,
    pending: nonNegative(snapshot?.pending),
    writeFailed: snapshot?.writeFailed === true,
    dropped: nonNegative(snapshot?.dropped),
    lastError: safeErrorCode(snapshot?.lastError),
  };
}

export function createHealthHandler(config, globals = globalThis) {
  return async () => runtimeHealth(config, globals);
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

function safeErrorCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_-]{0,80}$/u.test(code) ? code : "telemetry_error";
}

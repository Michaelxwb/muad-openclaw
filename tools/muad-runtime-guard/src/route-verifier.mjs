import { parseSessionKey } from "./binding-context.mjs";

const MAX_ROUTES = 1_000;
const ID_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const PEER_KINDS = new Set(["direct", "group", "channel", "dm"]);

export function createRouteVerifier(api) {
  return async (request = {}) => verifyRoutes(request?.params, {
    config: currentConfig(api),
    resolver: api?.runtime?.channel?.routing?.resolveAgentRoute,
  });
}

export function verifyRoutes(params, dependencies) {
  const parsed = parseRequest(params);
  const generation = generationFromConfig(dependencies.config);
  if (!parsed.ok) return failedResult(parsed.error, 0, generation);
  if (!generationMatches(parsed.generation, generation)) {
    return failedResult("generation_mismatch", parsed.routes.length, generation);
  }
  if (typeof dependencies.resolver !== "function") {
    return failedResult("route_resolver_unavailable", parsed.routes.length, generation);
  }

  const failures = [];
  parsed.routes.forEach((route, index) => {
    const failure = verifyOneRoute(route, index, dependencies);
    if (failure) failures.push(failure);
  });
  return {
    ok: failures.length === 0,
    generation,
    checked: parsed.routes.length,
    failed: failures.length,
    failures,
  };
}

function verifyOneRoute(route, index, dependencies) {
  try {
    const resolved = dependencies.resolver({
      cfg: dependencies.config,
      channel: route.channel,
      accountId: route.accountId,
      peer: { kind: route.peerKind === "dm" ? "direct" : route.peerKind, id: route.externalId },
    });
    return routeFailure(route, index, resolved);
  } catch {
    return { index, reason: "resolver_error", expectedAgentId: route.agentId };
  }
}

function routeFailure(route, index, resolved) {
  if (!resolved || resolved.agentId !== route.agentId) {
    return {
      index,
      reason: "agent_mismatch",
      expectedAgentId: route.agentId,
      actualAgentId: String(resolved?.agentId ?? ""),
      matchedBy: String(resolved?.matchedBy ?? ""),
    };
  }
  if (resolved.matchedBy === "default") {
    return { index, reason: "default_route", expectedAgentId: route.agentId };
  }
  if (!sessionMatchesAgent(resolved.sessionKey, route.agentId)) {
    return { index, reason: "session_agent_mismatch", expectedAgentId: route.agentId };
  }
  return null;
}

function sessionMatchesAgent(sessionKey, agentId) {
  const value = String(sessionKey ?? "").trim();
  if (!value) return true;
  const parsed = parseSessionKey(value);
  return parsed.agentId === agentId && parsed.routeType === "direct" && Boolean(parsed.peerId);
}

function parseRequest(value) {
  if (!isRecord(value)) return { ok: false, error: "invalid_request" };
  const routes = parseRoutes(value.routes);
  if (!routes.ok) return routes;
  return {
    ok: true,
    generation: safePositiveInteger(value.generation) ? value.generation : 0,
    routes: routes.routes,
  };
}

function parseRoutes(value) {
  if (!Array.isArray(value) || value.length > MAX_ROUTES) {
    return { ok: false, error: "invalid_routes" };
  }
  const routes = [];
  for (const item of value) {
    const route = parseRoute(item);
    if (!route) return { ok: false, error: "invalid_route" };
    routes.push(route);
  }
  return { ok: true, routes };
}

function parseRoute(value) {
  if (!isRecord(value)) return null;
  const route = {
    agentId: normalizedString(value.agentId),
    channel: normalizedString(value.channel),
    accountId: normalizedString(value.accountId) || "default",
    peerKind: normalizedString(value.peerKind),
    externalId: normalizedString(value.externalId),
  };
  if (!ID_PATTERN.test(route.agentId) || route.agentId === "main") return null;
  if (!route.channel || !PEER_KINDS.has(route.peerKind) || !route.externalId) return null;
  return route;
}

function failedResult(error, checked, generation) {
  return { ok: false, generation, checked, failed: checked, error, failures: [] };
}

function currentConfig(api) {
  const current = api?.runtime?.config?.current;
  if (typeof current === "function") return current();
  return api?.config ?? {};
}

function generationMatches(expected, actual) {
  return !safePositiveInteger(expected) || expected === actual;
}

function generationFromConfig(config) {
  const value = config?.plugins?.entries?.["muad-runtime-guard"]?.config?.generation;
  return safePositiveInteger(value) ? value : 0;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizedString(value) {
  return String(value ?? "").trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

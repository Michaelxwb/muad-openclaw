import path from "node:path";

const SHELL_TOOLS = new Set(["bash", "exec", "process", "shell"]);
const FILE_TOOLS = new Set(["apply_patch", "edit", "read", "write"]);
const PROFILE_MANAGEMENT_ACTIONS = new Set(["profiles"]);

export function createMainDenyPolicy({ mainAgentId }) {
  return {
    id: "muad-main-deny",
    description: "Blocks all tool execution by the unbound main agent.",
    evaluate(event, ctx) {
      if (ctx.agentId !== mainAgentId) return undefined;
      return deny(`main agent cannot call tool ${safeToolName(event.toolName)}`);
    },
  };
}

export function createBrowserProfilePolicy({ config, onViolation = () => {} }) {
  return {
    id: "muad-browser-profile",
    description: "Pins Browser calls to the profile mapped from trusted agent context.",
    evaluate(event, ctx) {
      if (event.toolName !== "browser" || ctx.agentId === config.mainAgentId) return undefined;
      const validation = validateBrowserRequest(event, ctx, config);
      if (!validation.ok) {
        onViolation({ agentId: safeId(ctx.agentId), reason: validation.reason });
        return deny(validation.reason);
      }
      return { params: { ...event.params, profile: validation.profile } };
    },
  };
}

export function createAgentFilesPolicy({ config, resolvePaths }) {
  return {
    id: "muad-agent-files",
    description: "Blocks shell execution and file access outside the trusted agent workspace.",
    evaluate(event, ctx) {
      if (ctx.agentId === config.mainAgentId) return undefined;
      if (isShellCall(event)) return deny("shell and exec tools are disabled for business agents");
      if (!FILE_TOOLS.has(event.toolName)) return undefined;
      return evaluateFileAccess(event, ctx, config, resolvePaths);
    },
  };
}

export function validateBrowserRequest(event, ctx, config) {
  if (!config.valid) return invalid("runtime guard configuration is invalid");
  const agentId = safeId(ctx.agentId);
  const profile = profileForAgent(config, agentId);
  if (!agentId || !profile) return invalid("browser agent mapping is unavailable");
  const action = typeof event.params?.action === "string" ? event.params.action.trim() : "";
  if (!action) return invalid("browser action is required");
  if (PROFILE_MANAGEMENT_ACTIONS.has(action)) return invalid("browser profile management is disabled");
  const requested = event.params?.profile;
  if (requested !== undefined && (typeof requested !== "string" || requested.trim() !== profile)) {
    return invalid("cross-profile browser access is disabled");
  }
  return { ok: true, profile };
}

export function profileForAgent(config, agentId) {
  return config.agentProfiles.find((item) => item.agentId === agentId)?.profile;
}

function evaluateFileAccess(event, ctx, config, resolvePaths) {
  if (!config.valid || !profileForAgent(config, safeId(ctx.agentId))) {
    return deny("file access requires a mapped business agent");
  }
  const roots = resolvePaths(ctx.agentId);
  if (!validRoots(roots)) return deny("trusted agent paths are unavailable");
  const candidates = fileCandidates(event);
  if (!candidates || candidates.length === 0) return deny("file destination cannot be verified");
  for (const candidate of candidates) {
    const target = resolveCandidate(roots.workspace, candidate);
    if (!target || isWithin(roots.agentDir, target) || isWithin(roots.sessionStore, target) ||
      !isWithin(roots.workspace, target)) return deny("file access is outside the agent workspace");
  }
  return undefined;
}

function fileCandidates(event) {
  if (event.toolName === "apply_patch") {
    return Array.isArray(event.derivedPaths) && event.derivedPaths.every(isNonEmptyString)
      ? [...event.derivedPaths] : null;
  }
  return isNonEmptyString(event.params?.path) ? [event.params.path] : null;
}

function resolveCandidate(workspace, candidate) {
  try {
    if (candidate.includes("\0") || candidate === "~" || candidate.startsWith("~/")) return null;
    return path.resolve(path.isAbsolute(candidate) ? candidate : path.join(workspace, candidate));
  } catch {
    return null;
  }
}

function validRoots(value) {
  return value && [value.workspace, value.agentDir, value.sessionStore]
    .every((item) => typeof item === "string" && path.isAbsolute(item));
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative));
}

function isShellCall(event) {
  return SHELL_TOOLS.has(event.toolName) || event.toolKind === "code_mode_exec";
}

function invalid(reason) {
  return { ok: false, reason };
}

function deny(reason) {
  return { allow: false, reason };
}

function safeToolName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function safeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

export const SESSION_MANAGER_VERSION = 1 as const;
export const RESOLVER_PURPOSE = "session_get_state" as const;
export const SERVICE_TOKEN_FILE = "/run/secrets/muad/pod-service-token";
export const RESOLVER_PATH = "/internal/v1/session-credentials/resolve";
export const DEFAULT_AGENTS_ROOT = "/home/node/.openclaw/agents";

export const DEFAULT_RESOLVER_TIMEOUT_MS = 3000;
export const DEFAULT_RETRY_BASE_MS = 100;
export const DEFAULT_RETRY_JITTER_MS = 200;
export const MAX_RESOLVER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_SESSION_KEY_LENGTH = 512;
export const DEFAULT_ADAPTER_TIMEOUT_MS = 20_000;
export const DEFAULT_LOCK_WAIT_MS = 20_000;
export const DEFAULT_LOCK_STALE_MS = 30_000;
export const DEFAULT_LOCK_POLL_MS = 100;

export const AGENT_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
export const PLATFORM_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

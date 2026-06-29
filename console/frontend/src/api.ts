// Typed client for the console backend. Token is stored in localStorage; all
// paths are relative so the embedded production build shares the API origin.

const BASE = "/api/v1";
const TOKEN_KEY = "muad_token";

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

// Emitted when any request gets a 401 so the app can drop back to the login
// screen instead of leaving a dead session on screen.
export const UNAUTHORIZED_EVENT = "muad:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = token.get();
  if (t) headers["Authorization"] = `Bearer ${t}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload: { code?: number; message?: string; data?: unknown } = {};
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401) {
    token.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error("登录已失效，请重新登录");
  }
  if (!res.ok) {
    throw new Error(payload.message || `HTTP ${res.status}`);
  }
  return payload.data as T;
}

export type Channel = "wecom" | "wechat";

export interface Container {
  userId: string;
  channel: Channel;
  state: string;
  imageTag: string;
  cpuPercent: number;
  memMiB: number;
  channelConnected: boolean;
  lastActiveAt?: string;
  reapInSeconds?: number;
  memLimit: string;
  cpuLimit: string;
  restartPolicy: string;
}

export interface ResourceConfig {
  configured?: boolean;
  memLimit: string;
  cpuLimit: string;
  restartPolicy: string;
}

export interface Alert {
  userId: string;
  level: string;
  kind: string;
  message: string;
}

export interface LLMConfig {
  configured: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  payload: string;
  ts: string;
}

export interface LLMForm {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const api = {
  me: () => request<{ actor: string }>("GET", "/me"),

  login: (username: string, password: string) =>
    request<{ token: string }>("POST", "/auth/login", { username, password }),

  // Returns all containers (server-side unpaginated); the UI filters/pages
  // client-side because status/connection are computed from live state.
  listContainers: () => request<{ items: Container[]; total: number }>("GET", "/containers"),
  createContainer: (b: {
    userId: string;
    channel: Channel;
    botId?: string;
    secret?: string;
    imageTag?: string;
  }) => request<unknown>("POST", "/containers", b),
  deleteContainer: (id: string, deleteVolume: boolean) =>
    request<unknown>("DELETE", `/containers/${id}?deleteVolume=${deleteVolume}`),
  logs: (id: string, tail: number) =>
    request<{ logs: string }>("GET", `/containers/${id}/logs?tail=${tail}`),
  qrcode: (id: string) =>
    request<{ loginUrl: string; raw: string; connected: boolean }>(
      "GET",
      `/containers/${id}/qrcode`,
    ),
  action: (id: string, action: string) =>
    request<unknown>("POST", `/containers/${id}/actions/${action}`),
  upgrade: (id: string, imageTag: string) =>
    request<unknown>("POST", `/containers/${id}/upgrade`, { imageTag }),
  reloadSkills: () => request<{ results: Record<string, string> }>("POST", "/skills/reload"),

  getLLM: () => request<LLMConfig>("GET", "/llm"),
  setLLM: (b: LLMForm) => request<unknown>("PUT", "/llm", b),
  testLLM: (b: LLMForm) => request<unknown>("POST", "/llm/test", b),
  setUserLLM: (id: string, b: LLMForm) => request<unknown>("PUT", `/containers/${id}/llm`, b),
  applyLLM: (userIds: string[]) =>
    request<{ results: Record<string, string> }>("POST", "/llm/apply", { userIds }),

  getResources: () => request<ResourceConfig>("GET", "/settings/resources"),
  setResources: (b: ResourceConfig) => request<unknown>("PUT", "/settings/resources", b),
  setUserResources: (id: string, b: ResourceConfig) =>
    request<unknown>("PUT", `/containers/${id}/resources`, b),

  audit: (actor: string, offset = 0, limit = 20) =>
    request<{ items: AuditEntry[]; total: number }>(
      "GET",
      `/audit?actor=${encodeURIComponent(actor)}&offset=${offset}&limit=${limit}`,
    ),
  alerts: () => request<Alert[]>("GET", "/alerts"),
};

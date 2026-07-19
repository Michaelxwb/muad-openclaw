// Typed client for the Console backend. All paths are relative so the
// embedded production build and local development use the same API contract.

import type {
  ActivationInput,
  Alert,
  AuditEntry,
  AuditQuery,
  BindingCode,
  BindingCodeCreateResult,
  ChannelCredential,
  CreateHumanUserInput,
  CreatePlatformInput,
  CreatePodInput,
  DeletePlatformResult,
  EffectiveSkill,
  GlobalResourceConfig,
  HumanUser,
  HumanUserBootstrapResult,
  HumanUserDeleteResult,
  HumanUserDetail,
  HumanUserListQuery,
  Identity,
  IdentityDeleteResult,
  IdentityInput,
  IdentityStatus,
  ListResult,
  LLMModelConfig,
  LLMModelInput,
  LLMModelTestResult,
  PageResult,
  PatchHumanUserInput,
  PatchPlatformInput,
  PatchPodInput,
  Platform,
  PlatformCredential,
  PlatformCredentialDeleteResult,
  PlatformCredentialUpdateResult,
  Pod,
  PodAction,
  PodActionResult,
  PodApplyResult,
  PodChannelUpdateResult,
  PodDeleteResult,
  PodListQuery,
  PodResourceConfig,
  PodResourceInput,
  PodUpgradeResult,
  PrivateSkillDeleteResult,
  PrivateSkillUploadInput,
  PrivateSkillUploadResult,
  PublicSkillStorageStatus,
  PublicSkillUploadInput,
  PublicSkillUploadResult,
  ResourceConfig,
  SkillAsset,
  SkillAssetQuery,
  SkillAssetUpdateInput,
  SkillExecution,
  SkillExecutionDetail,
  SkillExecutionQuery,
  SkillPolicy,
  SkillPolicyInput,
} from "./types/api";

export type * from "./types/api";

const BASE = "/api/v1";
const TOKEN_KEY = "muad_token";

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export const UNAUTHORIZED_EVENT = "muad:unauthorized";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type QueryValue = string | number | boolean | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponseBody(raw: string, status: number): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ApiError(
      `服务端返回了无效 JSON: ${error instanceof Error ? error.message : "解析失败"}`,
      status,
    );
  }
}

function errorFromResponse(payload: unknown, status: number): ApiError {
  if (!isRecord(payload)) return new ApiError(`HTTP ${status}`, status);
  const message = typeof payload.message === "string" ? payload.message : `HTTP ${status}`;
  const code = typeof payload.code === "number" ? payload.code : undefined;
  return new ApiError(message, status, code);
}

function unwrapResponse<T>(payload: unknown, status: number): T {
  if (!isRecord(payload) || payload.code !== 0 || !("data" in payload)) {
    throw new ApiError("服务端响应格式无效", status);
  }
  return payload.data as T;
}

async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const currentToken = token.get();
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  if (response.status === 401) {
    token.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError("登录已失效，请重新登录", response.status, 40101);
  }
  const payload = parseResponseBody(raw, response.status);
  if (!response.ok) throw errorFromResponse(payload, response.status);
  return unwrapResponse<T>(payload, response.status);
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const currentToken = token.get();
  if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
  const response = await fetch(BASE + path, { method: "POST", headers, body: form });
  const raw = await response.text();
  if (response.status === 401) {
    token.clear();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError("登录已失效，请重新登录", response.status, 40101);
  }
  const payload = parseResponseBody(raw, response.status);
  if (!response.ok) throw errorFromResponse(payload, response.status);
  return unwrapResponse<T>(payload, response.status);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function withQuery(path: string, values: Record<string, QueryValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

function humanUserPath(humanUserId: string): string {
  return `/human-users/${segment(humanUserId)}`;
}

export const api = {
  me: () => request<{ actor: string }>("GET", "/me"),

  login: (username: string, password: string) =>
    request<{ token: string }>("POST", "/auth/login", { username, password }),

  listPods: (query: PodListQuery = {}) =>
    request<PageResult<Pod>>(
      "GET",
      withQuery("/containers", {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        state: query.state,
      }),
    ),
  createPod: (input: CreatePodInput) => request<Pod>("POST", "/containers", input),
  getPod: (podId: string) => request<Pod>("GET", `/containers/${segment(podId)}`),
  patchPod: (podId: string, input: PatchPodInput) =>
    request<Pod>("PATCH", `/containers/${segment(podId)}`, input),
  deletePod: (podId: string, deleteState: boolean) =>
    request<PodDeleteResult>("DELETE", withQuery(`/containers/${segment(podId)}`, { deleteState })),
  updatePodChannels: (
    podId: string,
    input: { channels?: string[]; channelConfigs?: Record<string, ChannelCredential> },
  ) => request<PodChannelUpdateResult>("PUT", `/containers/${segment(podId)}/channels`, input),
  applyPodConfig: (podId: string) =>
    request<PodApplyResult>("POST", `/containers/${segment(podId)}/apply-config`),
  action: (podId: string, action: PodAction) =>
    request<PodActionResult>("POST", `/containers/${segment(podId)}/actions/${segment(action)}`),
  logs: (podId: string, tail: number) =>
    request<{ logs: string }>("GET", withQuery(`/containers/${segment(podId)}/logs`, { tail })),
  qrcode: (podId: string, force = false) =>
    request<{ loginUrl: string; raw: string; connected: boolean }>(
      "GET",
      withQuery(`/containers/${segment(podId)}/qrcode`, { force: force || undefined }),
    ),
  upgrade: (podId: string, imageTag: string) =>
    request<PodUpgradeResult>("POST", `/containers/${segment(podId)}/upgrade`, { imageTag }),
  reloadSkills: (podIds: string[]) =>
    request<{ results: Record<string, string> }>("POST", "/skills/reload", { podIds }),
  applySkills: () => request<{ results: Record<string, string> }>("POST", "/skills/reload", {}),

  listHumanUsers: (podId: string, query: HumanUserListQuery = {}) =>
    request<PageResult<HumanUser>>(
      "GET",
      withQuery(`/containers/${segment(podId)}/human-users`, {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        status: query.status,
      }),
    ),
  listAllHumanUsers: (query: HumanUserListQuery = {}) =>
    request<PageResult<HumanUser>>(
      "GET",
      withQuery("/human-users", {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        status: query.status,
      }),
    ),
  createHumanUser: (podId: string, input: CreateHumanUserInput) =>
    request<HumanUserBootstrapResult>("POST", `/containers/${segment(podId)}/human-users`, input),
  getHumanUser: (humanUserId: string) =>
    request<HumanUserDetail>("GET", humanUserPath(humanUserId)),
  patchHumanUser: (humanUserId: string, input: PatchHumanUserInput) =>
    request<HumanUserDetail>("PATCH", humanUserPath(humanUserId), input),
  deleteHumanUser: (humanUserId: string) =>
    request<HumanUserDeleteResult>("DELETE", humanUserPath(humanUserId)),
  createIdentity: (humanUserId: string, input: IdentityInput) =>
    request<Identity>("POST", `${humanUserPath(humanUserId)}/identities`, input),
  setIdentityStatus: (humanUserId: string, identityId: string, status: IdentityStatus) =>
    request<Identity>("PATCH", `${humanUserPath(humanUserId)}/identities/${segment(identityId)}`, {
      status,
    }),
  deleteIdentity: (humanUserId: string, identityId: string) =>
    request<IdentityDeleteResult>(
      "DELETE",
      `${humanUserPath(humanUserId)}/identities/${segment(identityId)}`,
    ),

  createBindingCode: (humanUserId: string, input: ActivationInput) =>
    request<BindingCodeCreateResult>("POST", `${humanUserPath(humanUserId)}/binding-codes`, input),
  listBindingCodes: (humanUserId: string) =>
    request<ListResult<BindingCode>>("GET", `${humanUserPath(humanUserId)}/binding-codes`),
  revokeBindingCode: (humanUserId: string, bindingCodeId: string) =>
    request<BindingCode>(
      "DELETE",
      `${humanUserPath(humanUserId)}/binding-codes/${segment(bindingCodeId)}`,
    ),

  listPlatforms: () => request<ListResult<Platform>>("GET", "/platforms"),
  createPlatform: (input: CreatePlatformInput) => request<Platform>("POST", "/platforms", input),
  patchPlatform: (platform: string, input: PatchPlatformInput) =>
    request<Platform>("PATCH", `/platforms/${segment(platform)}`, input),
  deletePlatform: (platform: string) =>
    request<DeletePlatformResult>("DELETE", `/platforms/${segment(platform)}`),
  listPlatformCredentials: (humanUserId: string) =>
    request<ListResult<PlatformCredential>>(
      "GET",
      `${humanUserPath(humanUserId)}/platform-credentials`,
    ),
  putPlatformCredential: (humanUserId: string, platform: string, apiKey: string) =>
    request<PlatformCredentialUpdateResult>(
      "PUT",
      `${humanUserPath(humanUserId)}/platform-credentials/${segment(platform)}`,
      { apiKey },
    ),
  deletePlatformCredential: (humanUserId: string, platform: string) =>
    request<PlatformCredentialDeleteResult>(
      "DELETE",
      `${humanUserPath(humanUserId)}/platform-credentials/${segment(platform)}`,
    ),

  listLLMModels: (available = false) =>
    request<ListResult<LLMModelConfig>>(
      "GET",
      available ? "/llm/models?available=true" : "/llm/models",
    ),
  createLLMModels: (models: LLMModelInput[]) =>
    request<ListResult<LLMModelConfig>>("POST", "/llm/models/batch", { models }),
  testLLMModels: (modelConfigIds: string[]) =>
    request<{ results: LLMModelTestResult[] }>("POST", "/llm/models/test", { modelConfigIds }),

  listSkills: (query: SkillAssetQuery = {}) =>
    request<PageResult<SkillAsset>>(
      "GET",
      withQuery("/skills", {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        scope: query.scope,
        status: query.status,
        humanUserId: query.humanUserId,
        podId: query.podId,
      }),
    ),
  getSkill: (skillId: string) => request<SkillAsset>("GET", `/skills/${segment(skillId)}`),
  scanSkills: () => request<{ scanned: number; items: SkillAsset[] }>("POST", "/skills/scan"),
  getPublicSkillStorage: () => request<PublicSkillStorageStatus>("GET", "/skills/public-storage"),
  ensurePublicSkillStorage: () =>
    request<PublicSkillStorageStatus>("POST", "/skills/public-storage"),
  uploadPublicSkill: (input: PublicSkillUploadInput) => {
    const form = new FormData();
    const filename =
      input.filename ?? (input.bundle instanceof File ? input.bundle.name : "skill.tar.gz");
    form.set("bundle", input.bundle, filename);
    return requestForm<PublicSkillUploadResult>("/skills/public", form);
  },
  updateSkill: (skillId: string, input: SkillAssetUpdateInput) =>
    request<{ skill: SkillAsset; affectedPodIds: string[] }>(
      "PATCH",
      `/skills/${segment(skillId)}`,
      input,
    ),
  listHumanUserSkills: (humanUserId: string, query: { q?: string; status?: string } = {}) =>
    request<ListResult<EffectiveSkill>>(
      "GET",
      withQuery(`${humanUserPath(humanUserId)}/skills`, {
        q: query.q,
        status: query.status,
      }),
    ),
  uploadPrivateSkill: (humanUserId: string, input: PrivateSkillUploadInput) => {
    const form = new FormData();
    const filename =
      input.filename ?? (input.bundle instanceof File ? input.bundle.name : "skill.tar.gz");
    form.set("bundle", input.bundle, filename);
    if (input.expectedName) form.set("expectedName", input.expectedName);
    return requestForm<PrivateSkillUploadResult>(
      `${humanUserPath(humanUserId)}/skills/private`,
      form,
    );
  },
  deletePrivateSkill: (humanUserId: string, skillId: string) =>
    request<PrivateSkillDeleteResult>(
      "DELETE",
      `${humanUserPath(humanUserId)}/skills/private/${segment(skillId)}`,
    ),
  createSkillPolicy: (humanUserId: string, input: SkillPolicyInput) =>
    request<SkillPolicy>("POST", `${humanUserPath(humanUserId)}/skill-policies`, input),
  deleteSkillPolicy: (humanUserId: string, policyId: string) =>
    request<{ deleted: boolean; policyId: string }>(
      "DELETE",
      `${humanUserPath(humanUserId)}/skill-policies/${segment(policyId)}`,
    ),
  listSkillExecutions: (query: SkillExecutionQuery = {}) =>
    request<PageResult<SkillExecution>>(
      "GET",
      withQuery("/skill-executions", {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        podId: query.podId,
        humanUserId: query.humanUserId,
        agentId: query.agentId,
        skillName: query.skillName,
        scope: query.scope,
        entryType: query.entryType,
        status: query.status,
        startedFrom: query.startedFrom,
        startedTo: query.startedTo,
      }),
    ),
  getSkillExecution: (executionId: string) =>
    request<SkillExecutionDetail>("GET", `/skill-executions/${segment(executionId)}`),
  getResources: () => request<GlobalResourceConfig>("GET", "/settings/resources"),
  setResources: (input: ResourceConfig) =>
    request<{ configured: true; affectedPodIds: string[] }>("PUT", "/settings/resources", input),
  getPodResources: (podId: string) =>
    request<PodResourceConfig>("GET", `/containers/${segment(podId)}/resources`),
  setPodResources: (podId: string, input: PodResourceInput) =>
    request<PodResourceConfig>("PUT", `/containers/${segment(podId)}/resources`, input),

  audit: (query: AuditQuery = {}) =>
    request<ListResult<AuditEntry>>(
      "GET",
      withQuery("/audit", {
        actor: query.actor,
        action: query.action,
        target: query.target,
        podId: query.podId,
        humanUserId: query.humanUserId,
        identityId: query.identityId,
        bindingCodeId: query.bindingCodeId,
        from: query.from,
        to: query.to,
        offset: query.offset,
        limit: query.limit,
      }),
    ),
  alerts: () => request<Alert[]>("GET", "/alerts"),
};

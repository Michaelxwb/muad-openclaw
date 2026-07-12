export type Channel = "wecom" | "wechat";

export type PodState =
  "creating" | "running" | "stopped" | "unhealthy" | "error" | "deleting" | "missing";

export type ApplyStatus = "pending" | "applying" | "applied" | "failed";
export type HumanUserStatus = "pending" | "active" | "disabled" | "deleting";
export type IdentityStatus = "active" | "disabled";
export type BindingCodeStatus = "pending" | "used" | "expired" | "revoked";
export type BindingCodePurpose = "create_user_first_identity" | "add_identity_to_existing_user";
export type PodAction = "start" | "stop" | "restart";

export interface ApiSuccessResponse<T> {
  code: 0;
  data: T;
}

export interface ApiErrorResponse {
  code: number;
  message: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

export interface ChannelCredential {
  botId?: string;
  secret?: string;
  botToken?: string;
  signingSecret?: string;
}

export interface ChannelConfigView {
  botId?: string;
  secretConfigured: boolean;
  lastUpdated?: string;
}

export interface ModelOverrideView {
  provider?: string;
  baseUrl?: string;
  model?: string;
  keyConfigured: boolean;
  keyFingerprint?: string;
}

export interface Pod {
  podId: string;
  displayName: string;
  imageTag: string;
  state: PodState;
  channels: string[];
  channelConfigs?: Record<string, ChannelConfigView>;
  channelStatuses?: Record<string, boolean>;
  modelOverride: ModelOverrideView;
  maxUsers: number;
  userCount: number;
  availableSlots: number;
  configGeneration: number;
  appliedGeneration: number;
  generationLag: number;
  lastApplyStatus: ApplyStatus;
  lastApplyError?: string;
  lastAppliedAt?: string;
  serviceTokenFingerprint: string;
  cpuPercent: number;
  memMiB: number;
  skillActive: number;
  skillQueued: number;
  browserActive: number;
  browserQueued: number;
  runtimeGuardHealthy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PodListQuery extends PageQuery {
  state?: Exclude<PodState, "missing">;
}

export interface CreatePodInput {
  podId: string;
  displayName?: string;
  imageTag?: string;
  maxUsers?: number;
  channels?: string[];
  channelConfigs?: Record<string, ChannelCredential>;
  memLimit?: string;
  cpuLimit?: string;
  restartPolicy?: string;
  maxSkillConcurrency?: number;
  maxBrowserConcurrency?: number;
}

export interface PatchPodInput {
  displayName?: string;
  imageTag?: string;
  maxUsers?: number;
}

export interface PodDeleteResult {
  podId: string;
  deleted: boolean;
  stateRetained: boolean;
}

export interface PodChannelUpdateResult {
  podId: string;
  channels: string[];
  channelConfigs: Record<string, ChannelConfigView>;
}

export interface PodApplyResult {
  podId: string;
  status: "queued";
  configGeneration: number;
  appliedGeneration: number;
}

export interface PodActionResult {
  podId: string;
  state: PodState;
}

export interface PodUpgradeResult {
  podId: string;
  imageTag: string;
  state: PodState;
  configGeneration: number;
  appliedGeneration: number;
}

export interface HumanUser {
  humanUserId: string;
  podId: string;
  displayName: string;
  agentId: string;
  browserProfile: string;
  browserCdpPort: number;
  status: HumanUserStatus;
  notes: string;
  identityCount: number;
  modelOverride: ModelOverrideView;
  createdAt: string;
  updatedAt: string;
}

export interface HumanUserListQuery extends PageQuery {
  status?: Exclude<HumanUserStatus, "deleting">;
}

export interface IdentityInput {
  channel: string;
  accountId?: string;
  externalId: string;
  externalIdType: string;
  peerKind?: "direct";
}

export interface ActivationInput {
  channel: string;
  accountId?: string;
  expiresInMinutes?: number;
}

interface CreateHumanUserBase {
  displayName: string;
  agentId?: string;
  notes?: string;
}

export type CreateHumanUserInput = CreateHumanUserBase &
  (
    | { identity: IdentityInput; activation?: never }
    | { activation: ActivationInput; identity?: never }
  );

export interface HumanUserActivation {
  bindingCodeId: string;
  code: string;
  expiresAt: string;
}

export type HumanUserBootstrapResult =
  | { humanUser: HumanUser; identity: Identity; activation?: never }
  | { humanUser: HumanUser; activation: HumanUserActivation; identity?: never };

export interface PatchHumanUserInput {
  displayName?: string;
  status?: Exclude<HumanUserStatus, "deleting">;
  notes?: string;
}

export interface HumanUserDetail {
  humanUser: HumanUser;
  identities: Identity[];
}

export interface HumanUserDeleteResult {
  humanUserId: string;
  podId: string;
  status: "deleting";
}

export interface Identity {
  identityId: string;
  channel: string;
  openclawChannel: string;
  accountId: string;
  externalId: string;
  externalIdType: string;
  peerKind: "direct";
  status: IdentityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityDeleteResult {
  humanUserId: string;
  identityId: string;
  deleted: boolean;
}

export interface BindingCode {
  bindingCodeId: string;
  codeHint: string;
  humanUserId: string;
  podId: string;
  channel: string;
  openclawChannel: string;
  accountId: string;
  purpose: BindingCodePurpose;
  status: BindingCodeStatus;
  failedAttempts: number;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface BindingCodeCreateResult {
  bindingCode: BindingCode;
  code: string;
}

export interface Platform {
  platform: string;
  displayName: string;
  config: Record<string, unknown>;
  configFingerprint: string;
  enabled: boolean;
  adapterInstalled: boolean;
  updatedAt: string;
}

export interface CreatePlatformInput {
  platform: string;
  displayName: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface PatchPlatformInput {
  displayName?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface PlatformCredential {
  humanUserId: string;
  platform: string;
  keyFingerprint: string;
  platformEnabled: boolean;
  updatedAt: string;
}

export interface PlatformCredentialUpdateResult {
  credential: PlatformCredential;
  cacheInvalidation: "on_next_resolve";
}

export interface PlatformCredentialDeleteResult {
  humanUserId: string;
  platform: string;
  deleted: boolean;
  cacheInvalidation: "on_next_resolve";
}

export interface ModelOverrideInput {
  clear?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface LLMForm {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface GlobalLLMConfig {
  configured: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKeyConfigured: boolean;
  keyFingerprint?: string;
}

export interface PodLLMConfig {
  podId: string;
  configured: boolean;
  modelOverride: ModelOverrideView;
}

export interface HumanUserModelResult {
  humanUserId: string;
  modelOverride: ModelOverrideView;
}

export interface ResourceValues {
  memLimit: string;
  cpuLimit: string;
  restartPolicy: string;
  maxSkillConcurrency: number;
  maxBrowserConcurrency: number;
}

export interface ResourceConfig {
  memLimit: string;
  cpuLimit: string;
  restartPolicy: string;
}

export interface GlobalResourceConfig extends ResourceConfig {
  configured: boolean;
  globalOverrides: ResourceValues;
  runtimeDefaults: ResourceValues;
  effective: ResourceValues;
}

export interface PodResourceConfig {
  podId: string;
  overrides: ResourceValues;
  globalDefaults: ResourceValues;
  runtimeDefaults: ResourceValues;
  effective: ResourceValues;
  memoryAlertThresholdMiB: number;
  configGeneration: number;
  appliedGeneration: number;
  lastApplyStatus: ApplyStatus;
  requiresPodRestart?: boolean;
  runtimeConfigChanged?: boolean;
}

export interface PodResourceInput {
  memLimit?: string;
  cpuLimit?: string;
  restartPolicy?: string;
  maxSkillConcurrency?: number;
  maxBrowserConcurrency?: number;
}

export interface AuditMetadata {
  podId?: string;
  humanUserId?: string;
  agentId?: string;
  identityId?: string;
  bindingCodeId?: string;
  platform?: string;
  fingerprint?: string;
  status?: string;
  errorCode?: string;
  generation?: number;
  appliedGeneration?: number;
  count?: number;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  targetType: "pod" | "human_user" | "identity" | "binding_code" | "platform" | "generic";
  payload: string;
  metadata: AuditMetadata;
  ts: string;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  target?: string;
  podId?: string;
  humanUserId?: string;
  identityId?: string;
  bindingCodeId?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export interface Alert {
  podId: string;
  level: "P1" | "P2" | "P3";
  kind: string;
  message: string;
  details?: Record<string, unknown>;
}

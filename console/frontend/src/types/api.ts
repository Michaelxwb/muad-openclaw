export type Channel = "wecom" | "wechat";

export type PodState =
  "creating" | "running" | "stopped" | "unhealthy" | "error" | "deleting" | "missing";

export type ApplyStatus = "pending" | "applying" | "applied" | "failed";
export type HumanUserStatus = "pending" | "active" | "disabled" | "deleting";
export type IdentityStatus = "active" | "disabled";
export type BindingCodeStatus = "pending" | "used" | "expired" | "revoked";
export type BindingCodePurpose = "create_user_first_identity" | "add_identity_to_existing_user";
export type PodAction = "start" | "stop" | "restart";
export type SkillScope = "system" | "public" | "private";
export type SkillStatus = "active" | "disabled" | "deleted";
export type EffectiveSkillStatus = "effective" | "conflict" | "disabled" | "missing_credential";
export type SkillPolicyAction = "disable" | "allow_override";
export type SkillExecutionStatus = "running" | "succeeded" | "failed" | "cancelled" | "rejected";
export type SkillEntryType = "managed" | "traditional-script" | "traditional-prompt";
export type SkillActivationMode = "tool" | "path-detected" | "runner";

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

export interface LLMModelView {
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
  modelConfigId: string;
  displayName: string;
  agentId: string;
  browserProfile: string;
  browserCdpPort: number;
  status: HumanUserStatus;
  notes: string;
  identityCount: number;
  modelConfig: LLMModelView;
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
  modelConfigId: string;
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

export interface DeletePlatformResult {
  platform: string;
  deleted: boolean;
  affectedPodIds: string[];
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

export interface LLMModelConfig {
  modelConfigId: string;
  displayName: string;
  provider: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  keyFingerprint?: string;
  boundHumanUserId?: string;
  boundHumanUserName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LLMModelInput {
  displayName: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LLMModelTestResult {
  modelConfigId?: string;
  displayName: string;
  ok: boolean;
  error?: string;
}

export interface SkillAsset {
  skillId: string;
  name: string;
  scope: SkillScope;
  humanUserId?: string;
  podId?: string;
  displayName: string;
  version: string;
  status: SkillStatus;
  sourcePath: string;
  manifestHash: string;
  manifestJson: string;
  entryType: string;
  platformsJson: string;
  browserRequired: boolean;
  progressSupported: boolean;
  systemProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillAssetQuery extends PageQuery {
  scope?: SkillScope;
  status?: SkillStatus;
  humanUserId?: string;
  podId?: string;
}

export interface SkillAssetUpdateInput {
  status: SkillStatus;
}

export interface SkillPlatformStatus {
  platform: string;
  credentialStatus: "configured" | "missing" | "platform_disabled" | "platform_missing";
  platformEnabled: boolean;
}

export interface SkillExecutionSummary {
  executionId: string;
  status: SkillExecutionStatus;
  startedAt: string;
  durationMs: number;
}

export interface EffectiveSkill {
  name: string;
  displayName: string;
  effective: boolean;
  effectiveSource: SkillScope;
  status: EffectiveSkillStatus;
  version: string;
  systemSkillId?: string;
  publicSkillId?: string;
  privateSkillId?: string;
  conflict: boolean;
  conflictReason?: string;
  platforms: SkillPlatformStatus[];
  progressSupported: boolean;
  browserRequired: boolean;
  runtimePending: boolean;
  lastExecution?: SkillExecutionSummary;
}

export interface SkillPolicy {
  policyId: string;
  humanUserId: string;
  skillName: string;
  action: SkillPolicyAction;
  reason: string;
  createdBy: string;
  expiresAt?: string;
  createdAt: string;
}

export interface SkillPolicyInput {
  skillName: string;
  action: SkillPolicyAction;
  reason?: string;
  expiresAt?: string;
}

export interface PrivateSkillUploadInput {
  bundle: File | Blob;
  filename?: string;
  expectedName?: string;
}

export interface PublicSkillUploadInput {
  bundle: File | Blob;
  filename?: string;
}

export interface PrivateSkillUploadResult {
  skill: SkillAsset;
}

export interface PublicSkillUploadResult {
  skill: SkillAsset;
  affectedPodIds: string[];
}

export interface PublicSkillStorageStatus {
  driver: "docker" | "k8s" | string;
  name: string;
  namespace: string;
  configured: boolean;
  ready: boolean;
  phase: string;
  accessMode: string;
  storageClass: string;
  size: string;
  message: string;
}

export interface PrivateSkillDeleteResult {
  deleted: boolean;
  skillId: string;
}

export interface SkillExecution {
  executionId: string;
  podId: string;
  humanUserId: string;
  agentId: string;
  skillName: string;
  skillScope: SkillScope;
  skillVersion: string;
  entryType: SkillEntryType;
  activationMode: SkillActivationMode;
  eventSeq: number;
  status: SkillExecutionStatus;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  lastToolName?: string;
  terminalReason?: string;
  errorCode?: string;
  errorMessage?: string;
  inputSummary?: string;
  outputSummary?: string;
  createdAt: string;
}

export interface SkillExecutionDetail extends SkillExecution {
  progressJson: string | null;
}

export interface SkillExecutionQuery extends PageQuery {
  podId?: string;
  humanUserId?: string;
  agentId?: string;
  skillName?: string;
  scope?: SkillScope;
  entryType?: SkillEntryType;
  status?: SkillExecutionStatus;
  startedFrom?: string;
  startedTo?: string;
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
  skillId?: string;
  skillName?: string;
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
  targetType: "pod" | "human_user" | "identity" | "binding_code" | "platform" | "skill" | "generic";
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

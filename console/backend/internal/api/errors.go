package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	auditlog "github.com/Michaelxwb/muad-openclaw/console/backend/internal/audit"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/errcode"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// Error codes are defined in internal/errcode (the API contract). The catalog
// below maps each code to its HTTP status and localized (zh/en) message
// template. Codes are grouped into business blocks and are stable: the
// frontend matches on them, so do not reuse or renumber existing codes.

// --- request language ---
// ctxKey is declared in auth.go; langKey reuses that type.

const langKey ctxKey = "lang"

type langCode string

const (
	langZH langCode = "zh"
	langEN langCode = "en"
)

// langFrom returns the request language, defaulting to zh when absent.
func langFrom(ctx context.Context) langCode {
	if v, ok := ctx.Value(langKey).(langCode); ok && v != "" {
		return v
	}
	return langZH
}

// parseLang maps an Accept-Language header to a supported language. Anything
// starting with "zh" (case-insensitively, before any quality value) is zh;
// an empty or unrecognized header defaults to zh to keep current behavior.
func parseLang(header string) langCode {
	first := header
	if i := strings.IndexByte(header, ','); i >= 0 {
		first = header[:i]
	}
	first = strings.TrimSpace(first)
	if first == "" {
		return langZH
	}
	if strings.HasPrefix(strings.ToLower(first), "zh") {
		return langZH
	}
	return langEN
}

// --- error catalog ---
//
// Each stable code maps to one distinguishable user-facing error: its HTTP
// status and localized (zh/en) message template. Message templates may contain
// %s placeholders filled by writeErr args.

type errorDef struct {
	httpStatus int
	zh, en     string
}

var errorCatalog = map[int]errorDef{
	// invalid.request_body
	errcode.InvalidRequestBody: {http.StatusBadRequest, "请求参数不合法", "Invalid request body"},
	// invalid.resource_limits
	errcode.InvalidResourceLimits: {http.StatusBadRequest, "资源配额配置不合法", "Invalid resource limits"},
	// invalid.page_size
	errcode.InvalidPageSize: {http.StatusBadRequest, "分页大小不合法", "Invalid page size"},
	// invalid.start_time
	errcode.InvalidStartTime: {http.StatusBadRequest, "开始时间不合法", "Invalid start time"},
	// invalid.end_time
	errcode.InvalidEndTime: {http.StatusBadRequest, "结束时间不合法", "Invalid end time"},
	// invalid.credentials_json
	errcode.InvalidCredentialsJson: {http.StatusBadRequest, "凭据必须是 JSON 对象", "Credentials must be a JSON object"},
	// invalid.channel_config
	errcode.InvalidChannelConfig: {http.StatusBadRequest, "通道配置不合法", "Invalid channel configuration"},
	// invalid.qrcode_wechat_only
	errcode.InvalidQrcodeWechatOnly: {http.StatusBadRequest, "二维码登录仅适用于微信通道", "QR code login only applies to the WeChat channel"},
	// invalid.delete_state
	errcode.InvalidDeleteState: {http.StatusBadRequest, "deleteState 必须为 true 或 false", "deleteState must be true or false"},
	// invalid.allow_override
	errcode.InvalidAllowOverride: {http.StatusBadRequest, "allowOverride 参数不合法", "Invalid allowOverride"},
	// invalid.credentials
	errcode.InvalidCredentials: {http.StatusUnauthorized, "账号或密码错误", "Invalid credentials"},
	// unauthorized
	errcode.Unauthorized: {http.StatusUnauthorized, "未授权，请重新登录", "Unauthorized"},
	// unauthorized.pod_token
	errcode.UnauthorizedPodToken: {http.StatusUnauthorized, "Pod 服务令牌无效", "Invalid Pod service token"},
	// invalid.human_user_request
	errcode.InvalidHumanUserRequest: {http.StatusBadRequest, "用户请求不合法", "Invalid user request"},
	// invalid.human_user_config
	errcode.InvalidHumanUserConfig: {http.StatusBadRequest, "用户配置不合法", "Invalid user configuration"},
	// invalid.human_user_status
	errcode.InvalidHumanUserStatus: {http.StatusBadRequest, "用户状态不合法", "Invalid user status"},
	// invalid.human_user_update
	errcode.InvalidHumanUserUpdate: {http.StatusBadRequest, "用户更新不合法", "Invalid user update"},
	// invalid.human_user_ids_required
	errcode.InvalidHumanUserIdsRequired: {http.StatusBadRequest, "必须指定用户", "humanUserIds is required"},
	// invalid.attach_confirm_no_memory
	errcode.InvalidAttachConfirmNoMemory: {http.StatusBadRequest, "绑定到其他 Pod 需要确认清空内存", "Attaching to a different Pod requires confirming memory reset"},
	// conflict.attach_unbound_only
	errcode.ConflictAttachUnboundOnly: {http.StatusConflict, "只能绑定未绑定的用户", "Only unbound users can be attached"},
	// invalid.human_user
	errcode.InvalidHumanUser: {http.StatusBadRequest, "用户数据不合法", "Invalid user data"},
	// invalid.identity_status
	errcode.InvalidIdentityStatus: {http.StatusBadRequest, "身份状态不合法", "Invalid identity status"},
	// conflict.identity_exists
	errcode.ConflictIdentityExists: {http.StatusConflict, "同名作用域身份已存在", "Scoped identity already exists"},
	// conflict.sender_bound
	errcode.ConflictSenderBound: {http.StatusConflict, "发送者已绑定", "Sender is already bound"},
	// invalid.binding_context
	errcode.InvalidBindingContext: {http.StatusBadRequest, "绑定上下文不合法", "Invalid binding context"},
	// invalid.binding_or_context
	errcode.InvalidBindingOrContext: {http.StatusBadRequest, "绑定码或绑定上下文不合法", "Binding code or context is invalid"},
	// invalid.binding_code
	errcode.InvalidBindingCode: {http.StatusBadRequest, "绑定码不合法", "Invalid binding code"},
	// conflict.binding_code_expired
	errcode.ConflictBindingCodeExpired: {http.StatusConflict, "绑定码已过期，请重新申请", "Binding code has expired, please request a new one"},
	// conflict.binding_code_used
	errcode.ConflictBindingCodeUsed: {http.StatusConflict, "绑定码已被使用", "Binding code has already been used"},
	// conflict.binding_code_revoked
	errcode.ConflictBindingCodeRevoked: {http.StatusConflict, "绑定码已被撤销", "Binding code has been revoked"},
	// invalid.agent_bundle_required
	errcode.InvalidAgentBundleRequired: {http.StatusBadRequest, "必须同时提供 agentId 与 Skill 包", "agentId and bundle are required"},
	// invalid.bundle_format
	errcode.InvalidBundleFormat: {http.StatusBadRequest, "Skill 包格式不合法", "Invalid bundle format"},
	// invalid.bundle_encoding
	errcode.InvalidBundleEncoding: {http.StatusBadRequest, "Skill 包编码不合法", "Invalid bundle encoding"},
	// invalid.skill_bundle
	errcode.InvalidSkillBundle: {http.StatusBadRequest, "Skill 包不合法", "Invalid skill bundle"},
	// invalid.skill_platforms
	errcode.InvalidSkillPlatforms: {http.StatusBadRequest, "Skill 平台列表不合法", "Invalid Skill platforms"},
	// invalid.skill_scope
	errcode.InvalidSkillScope: {http.StatusBadRequest, "Skill 作用域不合法", "Invalid Skill scope"},
	// invalid.skill_status
	errcode.InvalidSkillStatus: {http.StatusBadRequest, "Skill 状态不合法", "Invalid Skill status"},
	// invalid.skill_execution_status
	errcode.InvalidSkillExecutionStatus: {http.StatusBadRequest, "Skill 执行状态不合法", "Invalid Skill execution status"},
	// invalid.skill_execution_filter
	errcode.InvalidSkillExecutionFilter: {http.StatusBadRequest, "Skill 执行过滤条件不合法", "Invalid Skill execution filter"},
	// invalid.long_task_status
	errcode.InvalidLongTaskStatus: {http.StatusBadRequest, "Long Task 状态不合法", "Invalid Long Task status"},
	// invalid.public_skill_storage_not_configured
	errcode.InvalidPublicSkillStorageNotConfigured: {http.StatusBadRequest, "Public Skill 存储未配置", "Public Skill storage is not configured"},
	// invalid.skill_platform_dependency
	errcode.InvalidSkillPlatformDependency: {http.StatusBadRequest, "Skill 平台依赖非法", "Invalid Skill platform dependency"},
	// invalid.skill_platform_dependency_exists
	errcode.InvalidSkillPlatformDependencyExists: {http.StatusBadRequest, "Skill 平台依赖必须是已存在的业务平台", "Skill platform dependency must reference an existing platform"},
	// invalid.skill_platform_required
	errcode.InvalidSkillPlatformRequired: {http.StatusBadRequest, "多平台 Skill 必须指定平台", "Platform is required for multi-platform Skills"},
	// invalid.skill_platform_not_bound
	errcode.InvalidSkillPlatformNotBound: {http.StatusBadRequest, "Skill 未绑定该平台", "Platform is not bound to this Skill"},
	// invalid.public_skill_override_name
	errcode.InvalidPublicSkillOverrideName: {http.StatusBadRequest, "覆盖 Public Skill 时必须指定 Skill 名称", "Skill name is required to override a Public Skill"},
	// conflict.skill_exists
	errcode.ConflictSkillExists: {http.StatusConflict, "同名 Skill 已存在", "Skill already exists"},
	// conflict.public_skill_storage_not_ready
	errcode.ConflictPublicSkillStorageNotReady: {http.StatusConflict, "Public Skill 存储尚未就绪", "Public Skill storage is not ready"},
	// skill.bundle.frontmatter
	errcode.SkillBundleFrontmatter: {http.StatusBadRequest, "Public Skill 的 SKILL.md 必须包含 OpenClaw YAML frontmatter：name 和 description", "The Public Skill's SKILL.md must include OpenClaw YAML frontmatter: name and description"},
	// skill.bundle.name_mismatch
	errcode.SkillBundleNameMismatch: {http.StatusBadRequest, "muad.skill.json.name 必须与 SKILL.md frontmatter name 一致", "muad.skill.json.name must match the SKILL.md frontmatter name"},
	// skill.bundle.no_skill_md
	errcode.SkillBundleNoSkillMd: {http.StatusBadRequest, "Skill 包必须包含一个明确的主 SKILL.md", "The skill bundle must contain a primary SKILL.md"},
	// skill.bundle.multi_root
	errcode.SkillBundleMultiRoot: {http.StatusBadRequest, "Skill 包包含多个同层 Skill 根目录，请拆分后分别上传", "The skill bundle contains multiple top-level Skill roots; upload them separately"},
	// skill.bundle.invalid_name
	errcode.SkillBundleInvalidName: {http.StatusBadRequest, "Skill 名称非法，请在 muad.skill.json.name 中使用小写字母、数字、- 或 _", "Invalid skill name; use lowercase letters, digits, - or _ in muad.skill.json.name"},
	// skill.bundle.invalid_platform
	errcode.SkillBundleInvalidPlatform: {http.StatusBadRequest, "Skill 平台依赖非法", "Invalid Skill platform dependency"},
	// skill.bundle.invalid_manifest
	errcode.SkillBundleInvalidManifest: {http.StatusBadRequest, "muad.skill.json 格式非法", "Invalid muad.skill.json format"},
	// skill.bundle.unsafe_path
	errcode.SkillBundleUnsafePath: {http.StatusBadRequest, "Skill 包包含不安全路径", "The skill bundle contains unsafe paths"},
	// skill.bundle.link
	errcode.SkillBundleLink: {http.StatusBadRequest, "Skill 包不能包含软链接或硬链接", "The skill bundle must not contain symbolic or hard links"},
	// invalid.skill
	errcode.InvalidSkill: {http.StatusBadRequest, "Skill 数据不合法", "Invalid Skill data"},
	// invalid.platform_not_found
	errcode.InvalidPlatformNotFound: {http.StatusBadRequest, "业务平台不存在", "Platform not found"},
	// invalid.platform_display_name
	errcode.InvalidPlatformDisplayName: {http.StatusBadRequest, "平台显示名称不合法", "Invalid platform display name"},
	// invalid.platform_config
	errcode.InvalidPlatformConfig: {http.StatusBadRequest, "平台配置不合法", "Invalid platform configuration"},
	// conflict.platform_exists
	errcode.ConflictPlatformExists: {http.StatusConflict, "同名平台已存在", "Platform already exists"},
	// conflict.platform_disabled
	errcode.ConflictPlatformDisabled: {http.StatusConflict, "该平台已停用", "Platform is disabled"},
	// not_found.platform_credential
	errcode.NotFoundPlatformCredential: {http.StatusNotFound, "平台凭据未配置", "Platform credential not configured"},
	// invalid.platform
	errcode.InvalidPlatform: {http.StatusBadRequest, "业务平台数据不合法", "Invalid platform data"},
	// invalid.pod_action
	errcode.InvalidPodAction: {http.StatusBadRequest, "不支持的 Pod 操作", "Unsupported Pod action"},
	// invalid.pod_ids
	errcode.InvalidPodIds: {http.StatusBadRequest, "Pod ID 列表不合法", "podIds must contain valid unique Pod IDs"},
	// invalid.image_tag
	errcode.InvalidImageTag: {http.StatusBadRequest, "必须指定合法的镜像版本", "A valid imageTag is required"},
	// invalid.pod_config
	errcode.InvalidPodConfig: {http.StatusBadRequest, "Pod 配置不合法", "Invalid Pod configuration"},
	// invalid.pod_state
	errcode.InvalidPodState: {http.StatusBadRequest, "Pod 状态不合法", "Invalid Pod state"},
	// conflict.pod_capacity
	errcode.ConflictPodCapacity: {http.StatusConflict, "Pod 的 Human User 容量已达上限", "Pod Human User capacity exceeded"},
	// conflict.retained_state
	errcode.ConflictRetainedState: {http.StatusConflict, "保留的 Pod 状态需要显式确认采纳", "Retained Pod state requires explicit adoption"},
	// conflict.pod_state_action
	errcode.ConflictPodStateAction: {http.StatusConflict, "当前 Pod 状态不允许该操作", "Pod state does not allow this action"},
	// conflict.pod_running_apply
	errcode.ConflictPodRunningApply: {http.StatusConflict, "Pod 必须处于运行中才能应用配置", "Pod must be running to apply configuration"},
	// conflict.pod_running_upgrade
	errcode.ConflictPodRunningUpgrade: {http.StatusConflict, "Pod 必须处于运行中才能升级", "Pod must be running to upgrade"},
	// invalid.pod_capacity
	errcode.InvalidPodCapacity: {http.StatusBadRequest, "Pod 容量配置不合法", "Invalid Pod capacity"},
	// invalid.llm_model
	errcode.InvalidLLMModel: {http.StatusBadRequest, "LLM 模型配置不合法", "Invalid LLM model configuration"},
	// conflict.llm_model_bound
	errcode.ConflictLLMModelBound: {http.StatusConflict, "该 LLM 模型已绑定用户", "LLM model is already bound to a user"},
	// not_found
	errcode.NotFound: {http.StatusNotFound, "资源不存在", "Resource not found"},
	// conflict.exists
	errcode.ConflictExists: {http.StatusConflict, "资源已存在", "Resource already exists"},
	// conflict.generation
	errcode.ConflictGeneration: {http.StatusConflict, "配置代冲突，请刷新后重试", "Configuration generation conflict"},
	// conflict.state_operation
	errcode.ConflictStateOperation: {http.StatusConflict, "当前资源状态不允许该操作", "Resource state does not allow this operation"},
	// rate_limited.login
	errcode.RateLimitedLogin: {http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试", "Too many login attempts, please try again later"},
	// rate_limited.binding
	errcode.RateLimitedBinding: {http.StatusTooManyRequests, "绑定尝试过于频繁，请稍后再试", "Too many binding attempts, please try again later"},
	// internal.error
	errcode.InternalError: {http.StatusInternalServerError, "服务内部错误，请稍后重试", "Internal server error, please try again later"},
	// internal.query_audit
	errcode.InternalQueryAudit: {http.StatusInternalServerError, "查询审计日志失败", "Failed to query audit log"},
	// internal.list_pods
	errcode.InternalListPods: {http.StatusInternalServerError, "查询 Pod 列表失败", "Failed to list Pods"},
	// internal.query_alerts
	errcode.InternalQueryAlerts: {http.StatusInternalServerError, "查询运行时告警失败", "Failed to query runtime failure alerts"},
	// internal.query_stale_executions
	errcode.InternalQueryStaleExecutions: {http.StatusInternalServerError, "查询过期 Skill 执行记录失败", "Failed to query stale Skill executions"},
	// internal.read_agent_guidance
	errcode.InternalReadAgentGuidance: {http.StatusInternalServerError, "读取 Agent 指引失败", "Failed to read Agent guidance"},
	// internal.expire_binding_codes
	errcode.InternalExpireBindingCodes: {http.StatusInternalServerError, "使绑定码失效失败", "Failed to expire binding codes"},
	// internal.list_binding_codes
	errcode.InternalListBindingCodes: {http.StatusInternalServerError, "查询绑定码列表失败", "Failed to list binding codes"},
	// internal.decode_channel_config
	errcode.InternalDecodeChannelConfig: {http.StatusInternalServerError, "解析通道配置失败", "Failed to decode channel configuration"},
	// internal.encode_channel_config
	errcode.InternalEncodeChannelConfig: {http.StatusInternalServerError, "编码通道配置失败", "Failed to encode channel configuration"},
	// internal.generate_agent_id
	errcode.InternalGenerateAgentID: {http.StatusInternalServerError, "生成 Agent ID 失败", "Failed to generate agent ID"},
	// internal.create_human_user
	errcode.InternalCreateHumanUser: {http.StatusInternalServerError, "创建用户失败", "Failed to create user"},
	// internal.render_human_user
	errcode.InternalRenderHumanUser: {http.StatusInternalServerError, "渲染用户信息失败", "Failed to render user"},
	// internal.render_human_users
	errcode.InternalRenderHumanUsers: {http.StatusInternalServerError, "渲染用户列表失败", "Failed to render users"},
	// internal.list_human_users
	errcode.InternalListHumanUsers: {http.StatusInternalServerError, "查询用户列表失败", "Failed to list users"},
	// internal.count_human_user_identities
	errcode.InternalCountHumanUserIdentities: {http.StatusInternalServerError, "统计用户身份失败", "Failed to count user identities"},
	// internal.list_human_user_identities
	errcode.InternalListHumanUserIdentities: {http.StatusInternalServerError, "查询用户身份失败", "Failed to list user identities"},
	// internal.activate_binding_code
	errcode.InternalActivateBindingCode: {http.StatusInternalServerError, "激活绑定码失败", "Failed to activate binding code"},
	// internal.list_llm_models
	errcode.InternalListLLMModels: {http.StatusInternalServerError, "查询 LLM 模型失败", "Failed to list LLM models"},
	// internal.list_platform_credentials
	errcode.InternalListPlatformCredentials: {http.StatusInternalServerError, "查询平台凭据失败", "Failed to list platform credentials"},
	// internal.list_platforms
	errcode.InternalListPlatforms: {http.StatusInternalServerError, "查询业务平台失败", "Failed to list platforms"},
	// internal.inspect_platform_credential
	errcode.InternalInspectPlatformCredential: {http.StatusInternalServerError, "检查平台凭据失败", "Failed to inspect platform credential"},
	// internal.prepare_pod_config
	errcode.InternalPreparePodConfig: {http.StatusInternalServerError, "准备 Pod 配置失败", "Failed to prepare Pod configuration"},
	// internal.decode_pod_config
	errcode.InternalDecodePodConfig: {http.StatusInternalServerError, "解析 Pod 配置失败", "Failed to decode Pod configuration"},
	// internal.read_resource_config
	errcode.InternalReadResourceConfig: {http.StatusInternalServerError, "读取资源配置失败", "Failed to read resource config"},
	// internal.save_resource_config
	errcode.InternalSaveResourceConfig: {http.StatusInternalServerError, "保存资源配置失败", "Failed to save resource config"},
	// internal.mark_pods_pending
	errcode.InternalMarkPodsPending: {http.StatusInternalServerError, "标记继承 Pod 待应用失败", "Failed to mark inheriting Pods pending"},
	// internal.resolve_pod_resources
	errcode.InternalResolvePodResources: {http.StatusInternalServerError, "解析 Pod 资源失败", "Failed to resolve Pod resources"},
	// internal.list_skill_executions
	errcode.InternalListSkillExecutions: {http.StatusInternalServerError, "查询 Skill 执行记录失败", "Failed to list Skill executions"},
	// internal.list_skills
	errcode.InternalListSkills: {http.StatusInternalServerError, "查询 Skill 列表失败", "Failed to list Skills"},
	// internal.scan_skills
	errcode.InternalScanSkills: {http.StatusInternalServerError, "扫描 Skill 失败", "Failed to scan Skills"},
	// internal.list_long_tasks
	errcode.InternalListLongTasks: {http.StatusInternalServerError, "查询 Long Task 列表失败", "Failed to list Long Tasks"},
	// runtime.read_pod_logs
	errcode.RuntimeReadPodLogs: {http.StatusBadGateway, "读取 Pod 日志失败", "Failed to read Pod logs"},
	// runtime.wechat_login
	errcode.RuntimeWechatLogin: {http.StatusBadGateway, "触发微信登录失败", "Failed to trigger WeChat login"},
	// runtime.pod_action
	errcode.RuntimePodAction: {http.StatusBadGateway, "Pod 操作失败", "Pod action failed"},
	// runtime.reload_skills
	errcode.RuntimeReloadSkills: {http.StatusBadGateway, "重载 Skill 失败", "Failed to reload Skills"},
	// runtime.upgrade_rolled_back
	errcode.RuntimeUpgradeRolledBack: {http.StatusBadGateway, "Pod 升级失败，已自动回滚", "Pod upgrade failed and was rolled back"},
	// runtime.create_pod
	errcode.RuntimeCreatePod: {http.StatusBadGateway, "创建 Pod 运行时失败", "Failed to create Pod runtime"},
	// runtime.list_pods
	errcode.RuntimeListPods: {http.StatusBadGateway, "查询 Pod 运行时失败", "Failed to list Pod runtimes"},
	// runtime.inspect_pod
	errcode.RuntimeInspectPod: {http.StatusBadGateway, "检查 Pod 运行时失败", "Failed to inspect Pod runtime"},
	// runtime.image_change_rolled_back
	errcode.RuntimeImageChangeRolledBack: {http.StatusBadGateway, "Pod 镜像变更失败，已自动回滚", "Pod image change failed and was rolled back"},
	// runtime.delete_pod
	errcode.RuntimeDeletePod: {http.StatusBadGateway, "删除 Pod 运行时失败", "Failed to delete Pod runtime"},
	// runtime.inspect_public_skill_storage
	errcode.RuntimeInspectPublicSkillStorage: {http.StatusBadGateway, "检查 Public Skill 存储失败", "Failed to inspect public Skill storage"},
	// runtime.create_public_skill_storage
	errcode.RuntimeCreatePublicSkillStorage: {http.StatusBadGateway, "创建 Public Skill 存储失败", "Failed to create public Skill storage"},
	// runtime.token_rotation
	errcode.RuntimeTokenRotation: {http.StatusBadGateway, "Pod 服务令牌轮换失败", "Pod service token rotation failed"},
	// runtime.apply_failed
	errcode.RuntimeApplyFailed: {http.StatusBadGateway, "绑定已保存，但运行时配置应用失败", "Binding saved but runtime config apply failed"},
	// unavailable.binding_code_service
	errcode.UnavailableBindingCodeService: {http.StatusServiceUnavailable, "绑定码服务暂不可用", "Binding code service is temporarily unavailable"},
	// unavailable.runtime_reconciler
	errcode.UnavailableRuntimeReconciler: {http.StatusServiceUnavailable, "运行时协调器暂不可用", "Runtime reconciler is temporarily unavailable"},
	// unavailable.runtime_coordinator
	errcode.UnavailableRuntimeCoordinator: {http.StatusServiceUnavailable, "运行时协调器暂不可用", "Runtime coordinator is temporarily unavailable"},
	// unavailable.endpoint_not_implemented
	errcode.UnavailableEndpointNotImplemented: {http.StatusNotImplemented, "该接口尚未实现", "Endpoint not implemented"},
}

// writeErr writes a localized, friendly error response for a catalog code.
// Unknown codes fall back to the generic internal-error response.
func writeErr(w http.ResponseWriter, r *http.Request, code int) {
	def, ok := errorCatalog[code]
	if !ok {
		log.Printf("error_catalog_missing_code code=%d", code)
		code = errcode.InternalError
		def = errorCatalog[code]
	}
	body := map[string]any{"code": code, "message": renderError(def, langFrom(r.Context()))}
	writeErrorEnvelope(w, r, def.httpStatus, body)
}

// writeRuntimeFailure writes an error whose httpStatus is taken from the
// catalog code (typically 502 for runtime failures): a friendly localized
// message plus a redacted technical detail (omitted when err is nil) so pages
// can show the root cause collapsed without leaking secrets.
func writeRuntimeFailure(w http.ResponseWriter, r *http.Request, err error, code int) {
	def, ok := errorCatalog[code]
	if !ok {
		log.Printf("error_catalog_missing_code code=%d", code)
		code = errcode.InternalError
		def = errorCatalog[code]
	}
	body := map[string]any{"code": code, "message": renderError(def, langFrom(r.Context()))}
	if err != nil {
		body["detail"] = auditlog.RedactDiagnostic(err.Error())
	}
	writeErrorEnvelope(w, r, def.httpStatus, body)
}

func writeErrorEnvelope(w http.ResponseWriter, r *http.Request, status int, body map[string]any) {
	body["requestId"] = requestID(r)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("api_error_encode_failed status=%d error=%v", status, err)
	}
}

func renderError(def errorDef, lang langCode) string {
	if lang == langEN {
		return def.en
	}
	return def.zh
}

// writeRepoError maps a repo error to its catalog code. Repo sentinel errors
// are *repo.Error carrying the code directly, so a single errors.As lookup
// replaces the former errors.Is chain. Errors without a code (unexpected DB
// failures, etc.) surface as generic internal errors.
func writeRepoError(w http.ResponseWriter, r *http.Request, err error) {
	var re *repo.Error
	if errors.As(err, &re) {
		if _, ok := errorCatalog[re.Code]; ok {
			writeErr(w, r, re.Code)
			return
		}
	}
	// Unexpected repo failure (non-sentinel, or sentinel with an unknown code):
	// surface a generic internal error but keep the redacted diagnostic so the
	// page can still show the root cause collapsed.
	writeRuntimeFailure(w, r, err, errcode.InternalError)
}

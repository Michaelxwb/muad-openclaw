// Package errcode defines the console's stable, fine-grained error codes.
//
// Each code is one distinguishable user-facing error scenario; codes are
// grouped into business blocks (400xx generic parameters, 401xx auth, ...).
// The value of a code is decoupled from its HTTP status — the status lives
// in the api package's error catalog alongside the zh/en message templates.
// The api package indexes its catalog by these codes, and the repo package
// stamps them onto repo.Error so writeRepoError can surface them directly.
//
// Codes are the API contract: the frontend matches on them (e.g. 40101 for
// auth failures, 42901 for login rate limiting). Do not reuse or renumber
// existing codes.
package errcode

// Error codes — one per distinguishable error scenario, grouped by business.
const (
	// 400xx — 通用参数 / 请求校验
	InvalidRequestBody      = 40001
	InvalidResourceLimits   = 40003
	InvalidPageSize         = 40004
	InvalidStartTime        = 40005
	InvalidEndTime          = 40006
	InvalidCredentialsJson  = 40007
	InvalidChannelConfig    = 40008
	InvalidQrcodeWechatOnly = 40009
	InvalidDeleteState      = 40010
	InvalidAllowOverride    = 40011
	// 401xx — 认证授权
	InvalidCredentials   = 40101
	Unauthorized         = 40102
	UnauthorizedPodToken = 40103
	// 402xx — Human User 用户
	InvalidHumanUserRequest      = 40201
	InvalidHumanUserConfig       = 40202
	InvalidHumanUserStatus       = 40203
	InvalidHumanUserUpdate       = 40204
	InvalidHumanUserIdsRequired  = 40205
	InvalidAttachConfirmNoMemory = 40206
	ConflictAttachUnboundOnly    = 40207
	InvalidHumanUser             = 40208
	// 403xx — Identity 身份
	InvalidIdentityStatus  = 40301
	ConflictIdentityExists = 40302
	ConflictSenderBound    = 40303
	// 404xx — 绑定码 Binding Code
	InvalidBindingContext      = 40401
	InvalidBindingOrContext    = 40402
	InvalidBindingCode         = 40403
	ConflictBindingCodeExpired = 40404
	ConflictBindingCodeUsed    = 40405
	ConflictBindingCodeRevoked = 40406
	// 405xx — Skill 技能
	InvalidAgentBundleRequired             = 40501
	InvalidBundleFormat                    = 40502
	InvalidBundleEncoding                  = 40503
	InvalidSkillBundle                     = 40504
	InvalidSkillPlatforms                  = 40505
	InvalidSkillScope                      = 40506
	InvalidSkillStatus                     = 40507
	InvalidSkillExecutionStatus            = 40508
	InvalidSkillExecutionFilter            = 40509
	InvalidPublicSkillStorageNotConfigured = 40510
	InvalidSkillPlatformDependency         = 40511
	InvalidSkillPlatformDependencyExists   = 40512
	InvalidSkillPlatformRequired           = 40513
	InvalidSkillPlatformNotBound           = 40514
	InvalidPublicSkillOverrideName         = 40515
	ConflictSkillExists                    = 40516
	ConflictPublicSkillStorageNotReady     = 40517
	SkillBundleFrontmatter                 = 40518
	SkillBundleNameMismatch                = 40519
	SkillBundleNoSkillMd                   = 40520
	SkillBundleMultiRoot                   = 40521
	SkillBundleInvalidName                 = 40522
	SkillBundleInvalidPlatform             = 40523
	SkillBundleInvalidManifest             = 40524
	SkillBundleUnsafePath                  = 40525
	SkillBundleLink                        = 40526
	InvalidSkill                           = 40527
	// 406xx — 平台 Platform
	InvalidPlatformNotFound    = 40601
	InvalidPlatformDisplayName = 40602
	InvalidPlatformConfig      = 40603
	ConflictPlatformExists     = 40604
	ConflictPlatformDisabled   = 40605
	NotFoundPlatformCredential = 40606
	InvalidPlatform            = 40607
	// 407xx — Pod
	InvalidPodAction          = 40701
	InvalidPodIds             = 40702
	InvalidImageTag           = 40703
	InvalidPodConfig          = 40704
	InvalidPodState           = 40705
	ConflictPodCapacity       = 40706
	ConflictRetainedState     = 40707
	ConflictPodStateAction    = 40708
	ConflictPodRunningApply   = 40709
	ConflictPodRunningUpgrade = 40710
	InvalidPodCapacity        = 40711
	// 408xx — LLM 模型
	InvalidLLMModel       = 40801
	ConflictLLMModelBound = 40802
	// 409xx — 通用资源（未找到 / 冲突）
	NotFound               = 40901
	ConflictExists         = 40902
	ConflictGeneration     = 40903
	ConflictStateOperation = 40904
	// 429xx — 限流
	RateLimitedLogin   = 42901
	RateLimitedBinding = 42902
	// 500xx — 服务内部错误
	InternalError                     = 50001
	InternalQueryAudit                = 50002
	InternalListPods                  = 50003
	InternalQueryAlerts               = 50004
	InternalQueryStaleExecutions      = 50005
	InternalReadAgentGuidance         = 50006
	InternalExpireBindingCodes        = 50007
	InternalListBindingCodes          = 50008
	InternalDecodeChannelConfig       = 50009
	InternalEncodeChannelConfig       = 50010
	InternalGenerateAgentID           = 50011
	InternalCreateHumanUser           = 50012
	InternalRenderHumanUser           = 50013
	InternalRenderHumanUsers          = 50014
	InternalListHumanUsers            = 50015
	InternalCountHumanUserIdentities  = 50016
	InternalListHumanUserIdentities   = 50017
	InternalActivateBindingCode       = 50018
	InternalListLLMModels             = 50019
	InternalListPlatformCredentials   = 50020
	InternalListPlatforms             = 50021
	InternalInspectPlatformCredential = 50022
	InternalPreparePodConfig          = 50023
	InternalDecodePodConfig           = 50024
	InternalReadResourceConfig        = 50025
	InternalSaveResourceConfig        = 50026
	InternalMarkPodsPending           = 50027
	InternalResolvePodResources       = 50028
	InternalListSkillExecutions       = 50029
	InternalListSkills                = 50030
	InternalScanSkills                = 50031
	// 502xx — 运行时失败
	RuntimeReadPodLogs               = 50201
	RuntimeWechatLogin               = 50202
	RuntimePodAction                 = 50203
	RuntimeReloadSkills              = 50204
	RuntimeUpgradeRolledBack         = 50205
	RuntimeCreatePod                 = 50206
	RuntimeListPods                  = 50207
	RuntimeInspectPod                = 50208
	RuntimeImageChangeRolledBack     = 50209
	RuntimeDeletePod                 = 50210
	RuntimeInspectPublicSkillStorage = 50211
	RuntimeCreatePublicSkillStorage  = 50212
	RuntimeTokenRotation             = 50213
	RuntimeApplyFailed               = 50214
	// 503xx — 依赖不可用
	UnavailableBindingCodeService     = 50301
	UnavailableRuntimeReconciler      = 50302
	UnavailableRuntimeCoordinator     = 50303
	UnavailableEndpointNotImplemented = 50304
)

// AllCodes enumerates every code in the block above, in block order. The api
// package's error catalog is cross-checked against it (see
// TestErrorCatalogCoversAllCodes) so a newly added code cannot silently lack a
// catalog entry and fall back to internal.error at runtime.
var AllCodes = []int{
	40001, 40003, 40004, 40005, 40006, 40007, 40008, 40009, 40010, 40011,
	40101, 40102, 40103,
	40201, 40202, 40203, 40204, 40205, 40206, 40207, 40208,
	40301, 40302, 40303,
	40401, 40402, 40403, 40404, 40405, 40406,
	40501, 40502, 40503, 40504, 40505, 40506, 40507, 40508, 40509, 40510,
	40511, 40512, 40513, 40514, 40515, 40516, 40517, 40518, 40519, 40520,
	40521, 40522, 40523, 40524, 40525, 40526, 40527,
	40601, 40602, 40603, 40604, 40605, 40606, 40607,
	40701, 40702, 40703, 40704, 40705, 40706, 40707, 40708, 40709, 40710, 40711,
	40801, 40802,
	40901, 40902, 40903, 40904,
	42901, 42902,
	50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008, 50009, 50010,
	50011, 50012, 50013, 50014, 50015, 50016, 50017, 50018, 50019, 50020,
	50021, 50022, 50023, 50024, 50025, 50026, 50027, 50028, 50029, 50030, 50031,
	50201, 50202, 50203, 50204, 50205, 50206, 50207, 50208, 50209, 50210,
	50211, 50212, 50213, 50214,
	50301, 50302, 50303, 50304,
}

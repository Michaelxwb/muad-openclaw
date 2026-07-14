# Tasks: Skill 管理

- **Source**: `.code-flow/tasks/2026-07-13/skill-management/`
- **Created**: 2026-07-13
- **Updated**: 2026-07-13

## Proposal

当前 Console 已经具备 Pod、用户、模型、平台和审计管理能力，但 Skill 仍停留在 Runtime 文件与执行层，管理员无法稳定看到平台有哪些 Skill、某个用户实际能用哪些 Skill、为什么某个 Skill 被冲突/凭证/策略拦截。该任务集新增 Skill 管理闭环：后端建立 Skill 资产、用户生效视图、private skill 安装、执行记录和策略校验，前端新增全局 Skill 管理页面与用户详情 Skill Tab。

实现时保持已对齐的架构边界：不 fork OpenClaw 或第三方插件，不为每个 Skill 注册独立 tool；script skill 统一经 `muad-run-skill` 执行，public/private/system 的最终可见性由控制面 resolver 与 runtime runner 双层约束。

---

## TASK-001: 后端 Skill 数据模型与 Repo

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `skill-management.backend.design.md#3.3 数据设计`, `skill-management.backend.design.md#4.4 数据迁移`

### Description

新增 Skill 管理所需的控制面数据模型，保存全局 Skill 资产、用户级策略和 Skill 执行记录，为后续 API、resolver、runtime 集成提供统一数据访问层。

### Checklist

- [x] 在 `console/backend/internal/repo/schema.go` 新增 `skill_assets`、`skill_policies`、`skill_execution_records` 表结构。
- [x] 增加设计文档要求的普通索引与 partial unique index，覆盖 scope/name、human_user_id/status、pod_id/status、执行记录查询。
- [x] 新增或扩展 repo model，定义 Skill asset、policy、execution record、分页查询参数和状态枚举。
- [x] 实现 Skill asset CRUD/list、policy CRUD、execution record upsert/list 查询方法，所有 SQL 使用参数化查询。
- [x] 补充 schema 和 repo 测试，覆盖表创建、唯一约束、分页、软删除/状态过滤。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-002: Effective Skill Resolver

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-management.backend.design.md#2.5.1 业务规则与约束`, `skill-management.backend.design.md#3.2 架构设计`, `skill-management.backend.design.md#3.5 质量实现方案`

### Description

实现用户维度的最终 Skill 生效计算，将 system/public/private Skill、用户策略、平台配置、用户平台凭证和最近执行记录合并成 Human User 可见的 effective skill 视图。

### Checklist

- [x] 新增 resolver 服务，批量加载 system/public、目标用户 private、用户 skill policies、平台配置、用户平台凭证和最近执行记录。
- [x] 实现 system skill 永远保护、private 覆盖 public 默认冲突、allow_override 后 private 生效、disable 后不生效的规则。
- [x] 返回 effective source、conflict reason、credential status、runtime pending、last execution 等字段。
- [x] 确保凭证只返回 configured/missing/disabled 等状态，不返回 key、cookie 或完整 payload。
- [x] 补充单元测试，覆盖 system 覆盖拒绝、public/private 冲突、allow_override、disable、缺少平台凭证、平台禁用。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-003: Skill 管理 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-002
- **Source**: `skill-management.backend.design.md#3.4 接口设计`, `skill-management.backend.design.md#2.5 验收条件`

### Description

提供管理端 Skill 资产、详情、扫描、状态更新、用户生效 Skill 和用户策略接口，支撑全局 Skill 管理页面和用户详情 Skill Tab。

### Checklist

- [x] 注册 `GET /api/v1/skills`、`GET /api/v1/skills/{skillId}`、`POST /api/v1/skills/scan`、`PATCH /api/v1/skills/{skillId}`。
- [x] 注册 `GET /api/v1/human-users/{humanUserId}/skills`、`POST /api/v1/human-users/{humanUserId}/skill-policies`、`DELETE /api/v1/human-users/{humanUserId}/skill-policies/{policyId}`。
- [x] 按现有 API 约定实现 DTO、分页参数、过滤参数和错误码，统一使用 `writeJSON` / `writeErr`。
- [x] `POST /skills/scan` 首版支持显式扫描/刷新 metadata，不在列表查询中递归扫描文件系统。
- [x] 写入审计 action：`skill.asset.scan`、`skill.asset.update`、`skill.policy.create`、`skill.policy.delete`。
- [x] 补充 `httptest`，覆盖正常列表、详情、用户视图、非法过滤、冲突策略和不存在资源。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-004: Pod 侧 Private Skill 安装器

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: `skill-management.backend.design.md#3.1 方案选型`, `skill-management.backend.design.md#2.5.1 业务规则与约束`, `skill-management.backend.design.md#3.5 质量实现方案`

### Description

实现 Runtime Pod 内的 private skill 安装器，由 Console 通过 `RuntimeDriver.ExecStdin` 传入 bundle，安装器在目标用户 workspace 内安全解包，避免 Console 直接写 Runtime PVC。

### Checklist

- [x] 新增 Pod 内安装脚本或工具，支持从 stdin 接收 `.tar.gz` bundle 和目标 agent/workspace 参数。
- [x] 校验包大小、文件路径、绝对路径、`../`、symlink/hardlink、必需的 `SKILL.md`。
- [x] 解析 `SKILL.md` 中的非敏感 metadata，包括 name、version、platforms、progress/browser 标记。
- [x] 仅写入目标 Human User 对应的 private skill 目录，不允许跨 workspace。
- [x] 支持失败清理和删除指定 private skill 目录的能力。
- [x] 补充安装器测试，覆盖合法包、路径逃逸、符号链接、缺失 manifest、expectedName 不匹配。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-005: Private Skill 上传与删除 API

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001, TASK-002, TASK-004
- **Source**: `skill-management.backend.design.md#3.4 接口设计`, `skill-management.backend.design.md#2.5.2 功能验收场景`, `skill-management.backend.design.md#3.5 质量实现方案`

### Description

为单个 Human User 提供 private skill 上传和删除接口，API 负责校验用户/Pod 状态、冲突规则、调用 Pod 安装器、写入 metadata，并标记目标 Pod 配置 pending。

### Checklist

- [x] 实现 `POST /api/v1/human-users/{humanUserId}/skills/private` multipart handler。
- [x] 实现 `DELETE /api/v1/human-users/{humanUserId}/skills/private/{skillId}`。
- [x] 上传前校验 Human User、Pod、bundle、expectedName 和 system/public 重名规则。
- [x] 通过 `RuntimeDriver.ExecStdin` 调用目标 Pod 安装器，成功后写入 `skill_assets` 并标记 Pod `config_generation` pending。
- [x] 失败时不创建 active private skill；安装成功但 DB 失败时执行 best-effort 清理并写审计。
- [x] 返回 400/404/409/502 等明确错误码，前端可直接展示。
- [x] 补充 API 测试，覆盖合法上传、非法包、system 覆盖、public 冲突、Pod 不运行、installer 失败、删除成功/失败。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-006: Runtime Config 与执行策略约束

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `skill-management.backend.design.md#3.2 架构设计`, `skill-management.backend.design.md#3.5 质量实现方案`, `skill-management.backend.design.md#5.2 风险识别`

### Description

将用户 effective skill 结果注入 runtime 配置和 `muad-run-skill` 执行路径，确保 DB/UI 中被禁用或冲突的 Skill 不会在运行时被提示词或 runner 绕过执行。

### Checklist

- [x] 扩展 runtimeconfig builder，为每个 agent 生成 skill whitelist/effective policy。
- [x] 保持 public/private 目录加载能力，不修改 OpenClaw 上游 loader 或第三方插件。
- [x] 扩展 `muad-run-skill`，执行前校验 skill 是否属于该用户 effective whitelist。
- [x] 对 disabled、conflict、missing policy、unknown skill 返回标准错误，避免静默失败。
- [x] 保持 `muad-run-skill` 作为 script skill 唯一执行入口，不为每个 skill 单独注册 tool。
- [x] 补充 runtimeconfig 和 runner 测试，覆盖正常执行、禁用、冲突、跨用户、未知 skill。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-007: Skill 执行记录与进度遥测

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001, TASK-006
- **Source**: `skill-management.backend.design.md#3.4 接口设计`, `skill-management.backend.design.md#3.5 质量实现方案`, `skill-management.backend.design.md#2.5.2 功能验收场景`

### Description

接收 `muad-run-skill` 上报的 start/progress/done/fail 事件，保存脱敏后的执行摘要、耗时、阶段进度和错误信息，让管理员能排查长任务和失败 Skill。

### Checklist

- [x] 实现 `POST /internal/v1/skill-executions`，仅允许 Pod service token 调用。
- [x] 后端按 `podId + agentId` 反查 Human User，拒绝未知 agent 或跨 Pod 上报。
- [x] 实现执行记录 start/progress/done/fail 的幂等 upsert 与状态流转。
- [x] 实现 `GET /api/v1/skill-executions`，支持按 humanUserId、podId、skillName、status、时间范围分页查询。
- [x] 上报内容只保存摘要，截断 progress message、errorMessage、input/output summary，禁止保存密钥/cookie/完整业务 payload。
- [x] 扩展 `muad-run-skill` best-effort 上报，2s 超时，不阻断 skill 主流程。
- [x] 补充 internal API 鉴权、状态流转、脱敏截断、查询过滤测试。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-008: 前端 API 类型与 Client

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-005, TASK-007
- **Source**: `skill-management.frontend.design.md#3.5 状态与数据流`, `skill-management.backend.design.md#3.4 接口设计`

### Description

在前端统一 API 层补充 Skill 管理相关类型与请求方法，页面组件不得裸 `fetch`，multipart 上传使用独立 helper，不破坏现有 JSON request 行为。

### Checklist

- [x] 在 `console/frontend/src/types/api.ts` 新增 `SkillAsset`、`EffectiveSkill`、`SkillPolicy`、`SkillExecution`、分页查询和请求类型。
- [x] 在 `console/frontend/src/api.ts` 新增 `listSkills`、`getSkill`、`scanSkills`、`updateSkill`、`listHumanUserSkills`。
- [x] 新增 `uploadPrivateSkill`、`deletePrivateSkill`、`createSkillPolicy`、`deleteSkillPolicy`、`listSkillExecutions`。
- [x] 为 multipart 增加专用 request helper，保持 auth header 和 envelope 处理，不手动设置 JSON content-type。
- [x] 补充 API 单元测试，覆盖查询参数、multipart、错误 envelope、401 处理不回归。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-009: 全局 Skill 管理页面

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-008
- **Source**: `skill-management.frontend.design.md#3.2 页面与路由结构`, `skill-management.frontend.design.md#3.3 组件设计`, `skill-management.frontend.design.md#3.6 UI 状态`, `skill-management.frontend.design.md#3.7 样式方案`

### Description

新增一级菜单「Skill 管理」和全局 Skill 资产列表页面，回答“平台当前有哪些 Skill”，并提供 public skill 上传、扫描、搜索、过滤、分页和详情查看。

### Checklist

- [x] 在 AppShell 的 Page 类型、导航项、normalizePage、PageContent 中新增 `skills`。
- [x] 新增 `console/frontend/src/pages/Skills.tsx`、`Skills.module.css` 和 `src/pages/skills/` 下的页面组件/hook。
- [x] 使用现有 `PageHeader`、`PageSection`、`ListToolbar`、Semi Table 和统一分页模式。
- [x] 表头左上角放扫描/操作按钮，右上角放搜索和 scope/status 过滤，全平台风格保持一致。
- [x] 提供上传 Public Skill 入口，上传 `.tar.gz` 或 `.zip` 后刷新全局 Skill 资产列表。
- [x] 实现 `SkillAssetTable`、`SkillDetailDrawer`，展示 scope、status、version、platforms、browser/progress、protected 等信息。
- [x] 完成 loading、empty、error、success 状态和重试入口。
- [x] 补充组件测试，覆盖导航、列表查询、过滤、分页、扫描、详情抽屉、错误空态。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-010: 用户详情 Skill 视角与 Private Skill 操作

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-008
- **Source**: `skill-management.frontend.design.md#3.2 页面与路由结构`, `skill-management.frontend.design.md#3.3 组件设计`, `skill-management.frontend.design.md#3.4 组件接口契约`, `skill-management.frontend.design.md#3.6 UI 状态`

### Description

在 Human User 详情弹窗中新增 Skills Tab，展示该用户最终可见/可执行的 Skill，并提供 private skill 上传、删除、禁用和 override 策略入口。

### Checklist

- [x] 在 `HumanUserDetailDialog` 中新增 Skills Tab，避免影响已有基本信息、身份标识、绑定码、平台凭证 Tab。
- [x] 新增 `HumanUserSkillsTab`，加载 `api.listHumanUserSkills` 并维护搜索/状态过滤/刷新状态。
- [x] 新增 `EffectiveSkillTable`，展示 effectiveSource、version、conflict、credential status、lastExecution、runtimePending。
- [x] 新增 `PrivateSkillUploadDialog`，使用 Semi Modal/Upload，错误显示在弹窗内，成功后 Toast 并刷新。
- [x] 支持 private skill 删除、禁用、allow_override 策略操作，危险操作使用确认弹窗。
- [x] 缺凭证和冲突状态不能只靠颜色表达，必须有明确 Tag 文案和原因。
- [x] 补充组件测试，覆盖有效列表、冲突提示、缺凭证、上传成功/失败、删除失败、空态。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

---

## TASK-011: 审计、文档与端到端验证

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-005, TASK-007, TASK-009, TASK-010
- **Source**: `skill-management.backend.design.md#3.5 质量实现方案`, `skill-management.backend.design.md#4. 部署与运维`, `skill-management.frontend.design.md#2.4 验收条件`, `skill-management.frontend.design.md#4. 风险与依赖`

### Description

补齐 Skill 管理的审计、文档和端到端验证，确保 public/private/system 冲突、凭证依赖、执行进度和用户隔离链路可被实际验证。

### Checklist

- [x] 确认所有 Skill 变更操作写入审计日志：scan、install、update、delete、policy create/delete、execution fail。
- [x] 更新 `docs/k8s-architecture-100users.md` 中 Skill 管理、private skill、session-manager、state PVC 与执行进度相关描述。
- [x] 补充必要的开发/运维说明，说明 public skill 扫描、private skill 上传、冲突策略和执行记录查询方式。
- [x] 端到端验证 public skill 扫描、用户 effective skill 视图、private/public 同名冲突、allow_override、合法 private 上传、删除。
- [x] 端到端验证 `muad-run-skill` 执行记录和进度阶段可在 Console 查询。
- [x] 跑后端校验：`go test ./...`。
- [x] 跑前端校验：`npx tsc --noEmit`、`npx eslint src/ test/`、`npx prettier --check src/ test/`、`npx vitest run`。

### Log

- [2026-07-13] created (draft)
- [2026-07-13] started (in-progress)
- [2026-07-13] completed (done)

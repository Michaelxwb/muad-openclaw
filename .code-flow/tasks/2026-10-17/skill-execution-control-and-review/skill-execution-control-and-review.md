# Tasks: Skill 执行链路审计与限额终止

- **Source**: `.code-flow/tasks/2026-10-17/skill-execution-control-and-review/skill-execution-control-and-review.backend.design.md`, `.code-flow/tasks/2026-10-17/skill-execution-control-and-review/skill-execution-control-and-review.frontend.design.md`
- **Created**: 2026-10-17
- **Updated**: 2026-10-17

## Proposal

为自建 Skill 建立可回放的执行链路（exec + 业务接口 + 产出 + 汇总指标），在单一接口请求超限时只终止本次执行并通知用户与管理员；同时把平台请求头（Cookie / CSRF / Host / Traceid）收敛到 `muad_skill_http.platform_request`，新增 `self-skill-review` 与 creator 的 Python 收敛。所有新增能力均为 opt-in，未迁移的旧 Skill 保持原行为，支持分批迁移。

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 |
|--------|---------|---------|-------------|---------|------|
| S-01 | backend.design.md#2.5.2 功能验收场景 | E2E | Skill 脚本 → helper → spool → guard → 内部 API → SQLite → 查询 API | TASK-012 | planned |
| S-02 | backend.design.md#2.5.2 功能验收场景 | E2E | helper 退出 → guard abort → IM 通知 → Console 入库 → 通知分发 | TASK-012 | planned |
| S-03 | backend.design.md#2.5.2 功能验收场景 | integration | 设置 API → resource_config → runtimeconfig builder → renderer → 配置字节 | TASK-004 | planned |
| S-04 | backend.design.md#2.5.2 功能验收场景 | integration | 设置 API → 加密存储 → dispatcher → WeCom HTTP（httptest） | TASK-003 | planned |
| S-05 | backend.design.md#2.5.2 功能验收场景 | E2E | 执行数据 → stats SQL → 查询 API → UI 列表 | TASK-012 | planned |
| S-06 | backend.design.md#2.5.2 功能验收场景 | E2E | 审阅脚本 → 目标目录 → 报告输出（不执行目标代码） | TASK-008 | planned |
| S-07 | backend.design.md#2.5.2 功能验收场景 | integration | 下载 API → 私有上传 API → 管理员工作区 | TASK-009 | planned |
| S-08 | backend.design.md#2.5.2 功能验收场景 | integration | Skill 文档与模板文件内容 | TASK-008 | planned |
| S-09 | backend.design.md#2.5.2 功能验收场景 | integration | helper → spool 文件 | TASK-007 | planned |
| S-10 | backend.design.md#2.5.2 功能验收场景 | integration | helper 计数与 env | TASK-007 | planned |
| S-11 | backend.design.md#2.5.2 功能验收场景 | integration | settings API → audit | TASK-003 | planned |
| S-12 | backend.design.md#2.5.2 功能验收场景 | integration | session-manager 状态文件 → platform_request → HTTP（httptest） | TASK-007 | planned |
| S-13 | backend.design.md#2.5.2 功能验收场景 | integration | mssp 状态文件 → platform_request | TASK-007 | planned |
| S-14 | backend.design.md#2.5.2 功能验收场景 | E2E | 两个用户并发 → 两份 spool → Console → 告警/统计 | TASK-012 | planned |
| S-15 | backend.design.md#2.5.2 功能验收场景 | integration | 共享 gateway hook → 异步队列 → 其他用户 turn | TASK-005 | planned |
| S-16 | backend.design.md#2.5.2 功能验收场景 | E2E | 旧 Skill（raw requests + 手工头）→ 新镜像 → 执行 | TASK-012 | planned |
| S-17 | backend.design.md#2.5.2 功能验收场景 | integration | 混合 Skill（helper + raw requests） | TASK-007 | planned |
| E-01 | backend.design.md#2.5.2 功能验收场景 | integration | Console 内部接口 → repo | TASK-002 | planned |
| E-02 | backend.design.md#2.5.2 功能验收场景 | integration | dispatcher → WeCom HTTP（errcode≠0） | TASK-003 | planned |
| E-03 | backend.design.md#2.5.2 功能验收场景 | integration | guard 上传失败 → 保留 spool → 下个 hook 重试 | TASK-005 | planned |
| E-04 | backend.design.md#2.5.2 功能验收场景 | integration | 脚本绕过 helper 直接发请求 | TASK-007 | planned |
| E-05 | backend.design.md#2.5.2 功能验收场景 | unit | 并发计数锁 | TASK-007 | planned |
| E-06 | backend.design.md#2.5.2 功能验收场景 | integration | IM 投递（mock 通道） | TASK-005 | planned |
| E-07 | backend.design.md#2.5.2 功能验收场景 | integration | settings API 校验 | TASK-004 | planned |
| E-08 | backend.design.md#2.5.2 功能验收场景 | integration | session-manager → 状态文件 → platform_request | TASK-007 | planned |
| E-09 | backend.design.md#2.5.2 功能验收场景 | integration | cross-user-guard → 文件路径 | TASK-005 | planned |
| E-10 | backend.design.md#2.5.2 功能验收场景 | integration | platform_request → HTTP 401 | TASK-007 | planned |
| E-11 | backend.design.md#2.5.2 功能验收场景 | integration | 升级顺序/版本错配 | TASK-012 | planned |
| B-01 | backend.design.md#2.5.2 功能验收场景 | unit | helper 计数 | TASK-007 | planned |
| B-02 | backend.design.md#2.5.2 功能验收场景 | integration | helper spool + guard 解析 | TASK-005 | planned |
| B-03 | backend.design.md#2.5.2 功能验收场景 | unit | 路径归一化 | TASK-007 | planned |
| B-04 | backend.design.md#2.5.2 功能验收场景 | unit | 上限 0 | TASK-007 | planned |
| B-05 | backend.design.md#2.5.2 功能验收场景 | integration | 告警通道关闭 | TASK-003 | planned |
| B-06 | backend.design.md#2.5.2 功能验收场景 | unit | Traceid 生成 | TASK-007 | planned |
| B-07 | backend.design.md#2.5.2 功能验收场景 | integration | 多平台 header profile | TASK-007 | planned |
| B-08 | backend.design.md#2.5.2 功能验收场景 | integration | stats 分组维度 | TASK-002 | planned |
| B-09 | backend.design.md#2.5.2 功能验收场景 | unit | 告警去重键 | TASK-003 | planned |
| B-10 | backend.design.md#2.5.2 功能验收场景 | integration | 旧状态文件（无 requestProfile） | TASK-007 | planned |
| S-21 | frontend.design.md#2.4 验收条件 | E2E | API → 状态 → 抽屉渲染 | TASK-011 | planned |
| S-22 | frontend.design.md#2.4 验收条件 | integration | 状态 → UI | TASK-011 | planned |
| S-23 | frontend.design.md#2.4 验收条件 | E2E | 表单 → api.ts → 后端 → 回显 | TASK-010 | planned |
| S-24 | frontend.design.md#2.4 验收条件 | E2E | API → 列表 → 钻取 | TASK-011 | planned |
| S-25 | frontend.design.md#2.4 验收条件 | integration | API 返回 truncated | TASK-011 | planned |
| E-21 | frontend.design.md#2.4 验收条件 | integration | 请求失败 → 错误态 | TASK-011 | planned |
| E-22 | frontend.design.md#2.4 验收条件 | integration | 表单校验 | TASK-010 | planned |
| E-23 | frontend.design.md#2.4 验收条件 | integration | 测试接口返回 errcode≠0 | TASK-010 | planned |
| E-24 | frontend.design.md#2.4 验收条件 | integration | 空数据 | TASK-011 | planned |
| E-25 | frontend.design.md#2.4 验收条件 | integration | 权限/404 | TASK-011 | planned |
| B-21 | frontend.design.md#2.4 验收条件 | unit | 表单映射 | TASK-010 | planned |
| B-22 | frontend.design.md#2.4 验收条件 | unit | 时间线渲染 | TASK-011 | planned |
| B-23 | frontend.design.md#2.4 验收条件 | integration | 健康列表分组 | TASK-011 | planned |
| B-24 | frontend.design.md#2.4 验收条件 | integration | 旧 Skill 时间线 | TASK-011 | planned |

> 覆盖后端 38 个、前端 14 个场景；RULE-01~13 与高影响 RISK 均在对应任务 Checklist 或场景中映射。E2E 场景统一由 TASK-012 在全部功能任务完成后执行，不在编码期降级。

---

## TASK-001: Console 数据模型与迁移

- **Status**: draft
- **Priority**: P0
- **Depends**:
- **Source**: `skill-execution-control-and-review.backend.design.md#3.3 数据设计`, `skill-execution-control-and-review.backend.design.md#4.4 数据迁移`
- **Spec-Refs**: backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001
- **Acceptance-Refs**: —（数据模型迁移由 schema 测试覆盖，无独立 design 场景）

### Description

新增 `skill_trace_events`、`skill_execution_metrics`、`notify_channels` 三张表与索引，并在 `resource_config` 增加 `skill_request_limit` 列。迁移必须幂等、可重复执行、不破坏已有数据；repo 层提供 trace 事件写入/查询、metrics 单调 upsert、stats 分组查询和 notify 通道 CRUD。

### Checklist

- [ ] 新建迁移文件：三张表 DDL + 索引 + `resource_config.skill_request_limit`（`IF NOT EXISTS` 或列检测，幂等）。
- [ ] 实现 repo：事件按 `event_id` 幂等插入；metrics `aborted` 只升不降（`max(existing, excluded)`）；按 `(execution_id, seq)` 排序查询；stats 按 `(skill_name, skill_scope, human_user_id)` 分组。
- [ ] 实现 notify 通道 repo：加密配置存取、enabled 切换、单通道读取。
- [ ] [verifier][integration] `backend-database#RULE-backend-database-001`：所有 SQL 参数化且限定在 `internal/repo`；迁移在已有旧库上重复执行不报错、不丢数据。
- [ ] [verifier][integration] `backend-database#RULE-backend-no-select-star-001`：审查/正则确认无 `SELECT *`。
- [ ] 编写 schema 升级、外键级联、幂等迁移、metrics 单调性测试并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| RULE-backend-database-001 | integration | 真实 SQLite 文件、迁移脚本 | 旧库升级成功；重复执行幂等；行数与关联保留 | `console/backend/test/schema_test.go` | `cd console/backend && go test ./test -run Schema -count=1` | planned |
| RULE-backend-no-select-star-001 | unit | 生产 SQL 文本 | 无 `SELECT *` | repo 测试 + 正则扫描 | `cd console/backend && go test ./internal/repo -count=1` | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-002: Console trace 写入、查询与健康统计 API

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-execution-control-and-review.backend.design.md#3.4 接口设计`, `skill-execution-control-and-review.backend.design.md#3.5 质量实现方案`
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-code-quality-performance#RULE-backend-write-err-001, backend-platform-rules#RULE-backend-http-envelope-001
- **Acceptance-Refs**: E-01, B-08, RULE-05, RULE-12

### Description

实现 `POST /internal/v1/skill-executions/{executionId}/trace`、`GET /api/v1/skill-executions/{executionId}/trace`、`GET /api/v1/skill-executions/stats`。内部写入按 pod token + execution 归属校验，事件幂等、metrics 单调；stats 按用户维度分组；所有响应走 `writeJSON`/`writeErr`，新增错误码进 errcode/errorCatalog/AllCodes。

### Checklist

- [ ] 注册路由与 handler；内部接口校验 pod token 与 execution 归属，跨 Pod 返回稳定冲突码。
- [ ] trace 写入使用单事务批量 insert/upsert；事件 `event_id` 幂等；metrics `aborted` 只升不降；请求体与事件数量设上限（2000）。
- [ ] 查询接口按 `seq` 升序返回最多 2000 条；404 走既有 notfound。
- [ ] stats 按 `(skillName, skillScope, humanUserId)` 分组，支持 `window`/`limit`/`scope`/`humanUserId`；标记阈值集中常量。
- [ ] 新增错误码并补 `errorCatalog`、`errcode.AllCodes` 与双向守卫测试。
- [ ] [verifier][integration] `backend-code-quality-performance#RULE-backend-quality-001`：读写均带 context 超时；`go vet`/`go test` 通过。
- [ ] [verifier][unit] `backend-code-quality-performance#RULE-backend-write-err-001`：错误响应只传 errcode 常量，无字符串 message。
- [ ] [verifier][integration] `backend-platform-rules#RULE-backend-http-envelope-001`：所有响应经 `writeJSON`/`writeErr`，无 handler 直写 `json.NewEncoder`。
- [ ] 先写 API 测试（httptest + fake store/真实 SQLite）并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-01 | integration | HTTP → handler → repo → SQLite | 跨 Pod executionId 被拒绝；无数据泄漏；错误码稳定 | `console/backend/test/skill_executions_api_test.go` | `cd console/backend && go test ./test -run SkillExecutionTrace -count=1` | planned |
| B-08 | integration | stats SQL → 查询 API | 两用户同名私有 Skill 返回两行，humanUserId 不同 | 同上 | 同上 | planned |
| RULE-backend-write-err-001 | unit | handler 错误路径 | 只传 errcode 常量 | `console/backend/internal/api` 测试 | `cd console/backend && go test ./internal/api -run TestHTTPEncoder -count=1` | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-003: 通用通知能力与企微通道

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-execution-control-and-review.backend.design.md#3.4 接口设计`, `skill-execution-control-and-review.backend.design.md#3.5 质量实现方案`
- **Spec-Refs**: backend-directory-structure#RULE-backend-directory-001, backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001, runtime-isolation-and-security#RULE-runtime-security-001
- **Acceptance-Refs**: S-04, S-11, E-02, B-05, B-09, RULE-06, RULE-07

### Description

新增 `internal/notify` 包：Event/Channel/Dispatcher，异步有界队列、按 `(pod, user, skill, interface)` 去重 5 分钟、通道限速 10 条/分钟、网络失败重试一次、业务错误不重试。v1 实现企微群机器人通道；新增 settings notify 读取/保存/测试接口，webhook 加密落库、查询打码、变更记 `settings.update` 审计。

### Checklist

- [ ] 实现 Event/Channel/Dispatcher 与关闭时的 goroutine 收敛；`Publish` 非阻塞，队列满丢弃并记日志。
- [ ] 实现 WeCom channel：`errcode != 0` 视为失败；5s 超时；拒绝跨 host 重定向；仅允许 `qyapi.weixin.qq.com`。
- [ ] 实现 notify 配置读写与测试接口；webhook 用 `Cipher.Encrypt` 落库，GET 打码，PUT 校验域名；变更写 `settings.update` 审计。
- [ ] 实现去重与限速；dedupKey 含 pod + user + skill + interface。
- [ ] [verifier][integration] `backend-directory-structure#RULE-backend-directory-001`：notify 包不直连 DB/HTTP handler，分层正确。
- [ ] [verifier][integration] `backend-logging#RULE-backend-logging-001`：告警日志结构化，不含 webhook/key；操作审计与 skill telemetry 分离。
- [ ] [verifier][integration] `backend-logging#RULE-backend-redact-001`：上游错误进日志/响应前经 `RedactDiagnostic`。
- [ ] [verifier][integration] `runtime-isolation-and-security#RULE-runtime-security-001`：webhook 不落明文、不进镜像；配置读取仅服务端。
- [ ] 先写 httptest 用例（成功、errcode≠0、超时、去重、限速）并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | integration | settings API → 加密存储 → dispatcher → httptest | 测试消息 errcode=0；GET 打码 | `console/backend/test/notify_api_test.go` | `cd console/backend && go test ./test -run Notify -count=1` | planned |
| S-11 | integration | settings API → audit → DB | 产生 settings.update；库中密文；响应打码 | 同上 | 同上 | planned |
| E-02 | integration | dispatcher → httptest（errcode≠0） | 标记失败、不重试业务错误；去重/限速生效 | `console/backend/internal/notify` 测试 | `cd console/backend && go test ./internal/notify -count=1` | planned |
| B-05 | integration | 通道关闭 | 不发 webhook；trace/用户通知不受影响 | 同上 | 同上 | planned |
| B-09 | unit | 去重键生成 | 不同用户生成不同 dedupKey | `console/backend/internal/notify` 测试 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-004: 请求上限设置链路

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-execution-control-and-review.backend.design.md#2.3.2 字段约束`, `skill-execution-control-and-review.backend.design.md#3.4 接口设计`, `skill-execution-control-and-review.backend.design.md#4.2 发布与回滚`
- **Spec-Refs**: backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-model-pool-001, runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: S-03, E-07, RULE-02

### Description

把 `skillRequestLimit` 从系统设置贯通到 runtime 配置：settings handler → `SaveResourcesAndMarkPods` → builder → renderer → `runtime-config-schema` → guard 配置。默认 1000，0=不限制，范围 0~1,000,000；未变化不触发 apply；不新增/修改 Human User 创建与模型绑定路径。

### Checklist

- [ ] 扩展 `GET/PUT /api/v1/settings/resources` 与前端契约字段 `skillRequestLimit`，校验范围并映射稳定错误码。
- [ ] `SaveResourcesAndMarkPods` 增加参数与变更检测；builder/renderer/schema 同步字段；无效值拒绝写入。
- [ ] [verifier][integration] `backend-platform-rules#RULE-backend-platform-001`：多用户隔离、秘密注入、generation apply 语义不变；不新增模型回退链。
- [ ] [verifier][unit] `backend-platform-rules#RULE-backend-model-pool-001`：非回归检查，确认未改动 CreateHumanUser / model_config_id 绑定路径。
- [ ] [verifier][integration] `runtime-config-and-apply#RULE-runtime-config-001`：配置经 runtimeapply 事务链路，失败可回滚。
- [ ] [verifier][integration] `runtime-config-and-apply#RULE-runtime-validate-before-write-001`：写入前 `validateRuntimeConfig`，generation 单调。
- [ ] 先写设置保存→配置字节的失败用例并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-03 | integration | handler → repo → builder → renderer | 配置含 `skillRequestLimit:50`；generation 前移；guard env 可见 | `console/backend/test/settings_resources_test.go` | `cd console/backend && go test ./test -run SettingsResources -count=1` | planned |
| E-07 | integration | settings API 校验 | 负数/非数字返回稳定错误码且不落库 | 同上 | 同上 | planned |
| RULE-runtime-validate-before-write-001 | integration | schema + atomic write | 非法配置不写盘；generation 单调 | `bin/test` renderer/schema 测试 | `cd bin && npm test -- --test-name-pattern=RuntimeConfig` | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-005: runtime guard trace 归属、回传与隔离

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-002, TASK-004, TASK-007
- **Source**: `skill-execution-control-and-review.backend.design.md#3.2 架构设计`, `skill-execution-control-and-review.backend.design.md#3.4 接口设计`, `skill-execution-control-and-review.backend.design.md#3.5 质量实现方案`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001, runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001
- **Acceptance-Refs**: S-15, E-03, E-06, E-09, B-02, RULE-03, RULE-04, RULE-08, RULE-12

### Description

在 `muad-runtime-guard` 内增加执行归属映射与 trace 管道：按 `sessionKey + runId` 维护 `executionId → {skillName, route}`，缺失时 fail-closed；向 exec 注入 `MUAD_EXECUTION_ID`、`MUAD_TRACE_SPOOL`、`MUAD_SKILL_REQUEST_LIMIT`；exec 结束后读取 spool、解析 summary/events、异步批量回传 Console；识别 abort 后向用户 IM 通知；spool 目录 0700/文件 0600，加入 cross-user-guard 路径拦截，启动清理 24h 孤儿文件。

### Checklist

- [ ] 实现执行归属映射（session/turn 隔离，长任务 taskId），冲突/缺失不注入 env。
- [ ] `resolve_exec_env` 注入 trace env；spool 路径只用 UUID，目录 0700、文件 0600。
- [ ] exec 结束读取 spool：解析 summary 与事件、限制 2000 条、批量 POST 内部接口；失败保留 spool 并在下个 hook 重试；成功删除。
- [ ] abort 时通过共享 `notifyUser` 异步通知用户；IM 失败只记日志，不影响终止与 trace。
- [ ] 异步有界队列；hook 内只入队；队列满丢弃并记日志，不阻塞其他用户 turn。
- [ ] cross-user-guard 增加 trace spool 路径拦截；启动清理 24h 孤儿文件。
- [ ] [verifier][integration] `runtime-isolation-and-security#RULE-runtime-secret-file-mode-001`：目录 0700、文件 0600、原子写。
- [ ] [verifier][integration] `runtime-skill-execution#RULE-runtime-skill-001`：不改变 skill 分层、激活、并发租约。
- [ ] [verifier][unit] `runtime-skill-execution#RULE-runtime-log-injection-001`：注入 log，无散落 `console.*`。
- [ ] [verifier][unit] `runtime-skill-execution#RULE-runtime-log-prefix-001`：日志前缀 `[muad-runtime-guard][skill-trace]`。
- [ ] 先写 spool 解析/上传/重试与多用户隔离测试并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-15 | integration | guard hook → 队列 → 其他 turn | hook 50ms 内返回；不阻塞；最终入库 | `tools/muad-runtime-guard/test/skill-trace.test.mjs` | `cd tools/muad-runtime-guard && npm test -- --test-name-pattern=SkillTrace` | planned |
| E-03 | integration | 真实 spool 文件 + 失败上传 | 保留并重试；事件不重复 | 同上 | 同上 | planned |
| E-06 | integration | notifyUser fake | 投递失败不影响终止/trace | 同上 | 同上 | planned |
| E-09 | integration | cross-user-guard 路径扫描 | 命令含 spool 路径被拒绝 | `tools/muad-runtime-guard/test/cross-user-guard.test.mjs` | 同上 | planned |
| B-02 | integration | helper spool + guard 解析 | 500 条明细 + 汇总 600 + truncated | `tools/muad-runtime-guard/test/skill-trace.test.mjs` | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-006: session-manager 平台 request profile

- **Status**: draft
- **Priority**: P0
- **Depends**:
- **Source**: `skill-execution-control-and-review.backend.design.md#3.4 接口设计`（平台 request profile）
- **Spec-Refs**: —（runtime-directory rule 由 TASK-007 负责）
- **Acceptance-Refs**: S-12, S-13, B-07

### Description

在 session-manager 的 `PlatformAdapter` 增加可选 `requestProfile(credential)`，由 `get-state` 写入的私有状态文件在 `platforms.<platform>` 下追加 `requestProfile`：`baseUrl`、`hostHeader`、`referer`、`csrf` 映射、`staticHeaders`（如 mssp 的 `X-CSRFToken` 与 `timezone`）、`traceHeader`。只追加字段，不改已有 `cookies`/`storageState` 与 CLI stdout。

### Checklist

- [ ] 扩展 `PlatformAdapter` 可选方法；mssw/mssp 实现 profile；静态头值来自凭据，不写死在代码。
- [ ] 状态文件追加 `requestProfile`；已有字段、文件路径与 0600 模式不变。
- [ ] 旧凭据/缺省字段的 profile 回退策略：缺静态头时给默认值并记录诊断，不崩溃。
- [ ] 先写 profile 输出与旧字段兼容测试并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-12 | integration | session-manager → 状态文件 | mssw profile 含 csrf 映射与 Host；旧字段不变 | `tools/session-manager/test/session-store.test.ts` | `cd tools/session-manager && npm test -- --test-name-pattern=requestProfile` | planned |
| S-13 | integration | session-manager → 状态文件 | mssp profile 含静态头与 timezone | 同上 | 同上 | planned |
| B-07 | integration | 两平台状态文件 | 两平台 profile 不串 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-007: Python SDK `muad_skill_http`

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-006
- **Source**: `skill-execution-control-and-review.backend.design.md#3.4 接口设计`（形态 C、SDK 环境契约、spool 契约、请求头构造顺序）`, `skill-execution-control-and-review.backend.design.md#3.5 质量实现方案`
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001
- **Acceptance-Refs**: S-09, S-10, S-12, S-13, S-17, E-04, E-05, E-08, E-10, B-01, B-03, B-04, B-06, B-07, B-10, RULE-01, RULE-02, RULE-11

### Description

新增 `tools/muad-skill-sdk` Python 包（构建时安装进镜像 site-packages）：`request`/`get/post/...`/`session` 透传 `requests`；每请求写 spool（明细上限 500 + 全量计数 + summary）；按归一化接口计数，超限第 N+1 次不发出并 `os._exit(86)`；`platform_request` 读取状态文件、组装 Cookie/CSRF/Host/静态头/Traceid，401 仅对幂等请求刷新重试一次；无 helper 的旧 Skill 零影响。

### Checklist

- [ ] 建立包与测试；构建阶段安装到 site-packages；不新增运行时依赖（`requests` 已有）。
- [ ] 实现通用请求、spool JSONL、路径归一化、接口计数锁、500 条明细上限、summary 全量。
- [ ] 实现超限判定：第 N+1 次不发送、flush abort/summary、`os._exit(86)`；0 表示不限制。
- [ ] 实现 `platform_request`/`platform`：状态文件缓存、Cookie/CSRF/Host/静态头、`Traceid` 每请求 UUID v4、强制头不可覆盖、`extra_headers` 逃生口。
- [ ] 实现 401/403 刷新策略（GET/HEAD 重试一次），缺 profile 回退默认并记诊断。
- [ ] [verifier][unit] `runtime-directory-structure#RULE-runtime-directory-001`：SDK 放 `tools/muad-skill-sdk`，不 fork 上游、不散落 bin。
- [ ] 先写计数/终止/归一化/header/Traceid 测试并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-09 | integration | helper → 真实 spool 文件 | 成功/失败都计数；errorCount 正确 | `tools/muad-skill-sdk/test/test_http.py` | `cd tools/muad-skill-sdk && python3 -m pytest -q` | planned |
| S-10 | integration | helper 计数与 env | limit=0 不终止；requestCount=1000 | 同上 | 同上 | planned |
| S-12 | integration | 状态文件 → httptest | Cookie/CSRF/Host 正确；Traceid 两次不同 | 同上 | 同上 | planned |
| S-13 | integration | mssp 状态文件 → httptest | 静态头/timezone 正确；不带 mssw 头 | 同上 | 同上 | planned |
| S-17 | integration | helper + raw requests 混合 | helper 计数、raw 不计；都成功 | 同上 | 同上 | planned |
| E-04 | integration | raw requests 直连 | 无接口事件但脚本正常 | 同上 | 同上 | planned |
| E-05 | unit | 多线程计数 | 恰好放行 N 次，不超发 | 同上 | 同上 | planned |
| E-08 | integration | 缺登录态 | 刷新一次；仍失败 fail loud | 同上 | 同上 | planned |
| E-10 | integration | 401/403 | GET 重试一次；POST 返回原响应 | 同上 | 同上 | planned |
| B-01 | unit | 上限 N=1 | 第 1 次放行、第 2 次终止 | 同上 | 同上 | planned |
| B-03 | unit | 路径归一化 | 数字/UUID 归为同一接口 | 同上 | 同上 | planned |
| B-04 | unit | 上限 0 | 永不终止 | 同上 | 同上 | planned |
| B-06 | unit | Traceid | 1000 次无重复 UUID | 同上 | 同上 | planned |
| B-07 | integration | 多平台 profile | 头不串平台 | 同上 | 同上 | planned |
| B-10 | integration | 旧状态文件 | 回退默认 profile，不崩溃 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-008: `self-skill-review` 与 creator Python 收敛

- **Status**: draft
- **Priority**: P1
- **Depends**: TASK-007
- **Source**: `skill-execution-control-and-review.backend.design.md#2.3.1 功能清单`, `skill-execution-control-and-review.backend.design.md#3.4 接口设计`（存量与文档收敛）
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-06, S-08, RULE-09, RULE-10

### Description

新增 `skills/self-skill-review` system Skill：只读目标目录、不执行被审代码，先跑确定性 AST/文件检查，再由模型做语义审查，输出带 `file:line` 的检查表。同步把 `self-skill-creator` 与模板收敛为 Python，`http-headers.md` 改为使用 `muad_skill_http.platform_request`；上传链路不做硬拦截。

### Checklist

- [ ] 新建 SKILL.md、references/rules.md、scripts/check.py；检查项覆盖文件类型、manifest/frontmatter 一致、entrypoint `.py`、必须使用 platform_request、禁止手工 Cookie/CSRF、禁止 subprocess 发业务请求、stderr + 非 0、SKILL_OUTPUT_DIR、session-manager skill 名一致、凭据/内部 URL。
- [ ] `check.py` 只读 AST/文本，不 import/执行目标代码；忽略代码内指令；输出 JSON/Markdown 检查表。
- [ ] 更新 creator：删除语言选择、只保留 Python、示例改为 platform_request；下线/标记 TS/Shell 模板；更新 `_templates/README.md`。
- [ ] [verifier][integration] `runtime-skill-execution#RULE-runtime-skill-fail-loud-001`：review 规则检查失败写 stderr + 非 0；示例与模板一致。
- [ ] 先写 check.py 的违规/合规 fixture 测试并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-06 | E2E | Skill 进程 → 目标目录 → 报告 | 报告列出违规与 file:line；目标脚本未执行 | `skills/self-skill-review/test/check.test.py` | `python3 -m pytest skills/self-skill-review/test -q` | planned |
| S-08 | integration | 模板/文档文件扫描 | 无 TS/Shell 模板与示例；creator 只引导 Python | `skills/_templates/test/template-scan.py` | 同上 | planned |
| RULE-runtime-skill-fail-loud-001 | integration | review 规则与示例 | 违规能被检出；示例 fail loud | `skills/self-skill-review/test/check.test.py` | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-009: 管理员 review 流程验证

- **Status**: draft
- **Priority**: P1
- **Depends**: TASK-008
- **Source**: `skill-execution-control-and-review.backend.design.md#2.3.1 功能清单`（FEAT-13）, `skill-execution-control-and-review.backend.design.md#2.2 痛点与价值`（US-06）
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-layering-001
- **Acceptance-Refs**: S-07

### Description

复用既有下载、私有上传、删除端点，验证管理员把待审用户 Skill 临时装到自己 Human User 名下进行 review 的完整流程；补充操作 runbook，不新增生产代码。确认私有 Skill 分层、同名冲突与跨用户隔离语义不变。

### Checklist

- [ ] 编写集成测试：下载待审 bundle → 上传到管理员 human user → installer 同步到 `workspace-<agent>/skills` → 删除临时副本。
- [ ] 验证原用户工作区无感知、无跨用户读取；同名冲突仍按既有策略拒绝。
- [ ] [verifier][integration] `runtime-skill-execution#RULE-runtime-skill-layering-001`：system/public/private 解析与 allow_override 策略不变。
- [ ] 更新管理员 review runbook（步骤、前置条件、清理动作）。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-07 | integration | 下载/上传/删除 API → 管理员工人工作区 | 管理员 agent 可读；原用户无感知；删除后清理 | `console/backend/test/runtime_file_skill_e2e_test.go` 或新增用例 | `cd console/backend && go test ./test -run AdminSkillReview -count=1` | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-010: 前端系统设置（上限 + 告警推送）

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-003, TASK-004
- **Source**: `skill-execution-control-and-review.frontend.design.md#3.3 组件设计`, `skill-execution-control-and-review.frontend.design.md#3.5 状态与数据流`, `skill-execution-control-and-review.frontend.design.md#3.9 文案与 i18n`
- **Spec-Refs**: frontend-component-specs#RULE-frontend-semi-shell-001, frontend-directory-structure#RULE-frontend-directory-001, frontend-directory-structure#RULE-frontend-api-types-001, frontend-quality-standards#RULE-frontend-api-client-001
- **Acceptance-Refs**: S-23, E-22, E-23, B-21, RULE-07

### Description

在系统设置页新增 `skillRequestLimit` 字段与「告警推送」区块（启用、打码 webhook、测试、保存）。类型与请求分别收敛到 `types/api.ts`、`api.ts`；表单三态与字段校验完整；新增文案 zh/en 同步；webhook 留空表示不修改，不回填完整 key。

### Checklist

- [ ] 扩展 `types/api.ts` 与 `api.ts`：资源设置字段、notify 读取/保存/测试方法。
- [ ] 实现 `NotifySettings`/`NotifySettingsForm` 与 `ResourceForm` 新字段；保存/测试 busy 态与错误就地展示。
- [ ] webhook 打码回显；输入框留空不修改；PUT 校验失败展示字段错误。
- [ ] [verifier][integration] `frontend-component-specs#RULE-frontend-semi-shell-001`：Semi + 全局 ConfigProvider，无页面级重复包裹。
- [ ] [verifier][integration] `frontend-directory-structure#RULE-frontend-directory-001`：文件位于 console/frontend，HTTP 经 api.ts。
- [ ] [verifier][integration] `frontend-directory-structure#RULE-frontend-api-types-001`：类型集中 types/api.ts，api.ts re-export，无漂移 DTO。
- [ ] [verifier][unit] `frontend-quality-standards#RULE-frontend-api-client-001`：无裸 fetch/axios。
- [ ] 先写表单校验与保存/测试交互测试并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-23 | E2E | 表单 → api.ts → 后端 → 回显 | 保存成功；刷新回显；webhook 打码；测试结果就地展示 | `console/frontend/test/Settings.test.tsx` | `cd console/frontend && npm test -- --run Settings` | planned |
| E-22 | integration | 表单校验 | 负数/非整数提示，不发请求 | 同上 | 同上 | planned |
| E-23 | integration | 测试接口 errcode≠0 | 保留输入并展示失败原因 | 同上 | 同上 | planned |
| B-21 | unit | 上限 0 | 显示"不限制"，保存成功 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-011: 前端执行时间线与 Skill 健康

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `skill-execution-control-and-review.frontend.design.md#3.3 组件设计`, `skill-execution-control-and-review.frontend.design.md#3.5 状态与数据流`, `skill-execution-control-and-review.frontend.design.md#3.6 UI 状态`
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001, frontend-quality-standards#RULE-frontend-quality-001, frontend-quality-standards#RULE-frontend-i18n-001
- **Acceptance-Refs**: S-21, S-22, S-24, S-25, E-21, E-24, E-25, B-22, B-23, B-24

### Description

在执行日志行展开抽屉：汇总头（请求数/错误数/耗时/Top 接口/aborted/truncated 徽标）+ 事件时间线；旧 Skill 仅有 exec 事件时显示提示。审计页新增「Skill 健康」页签：按窗口聚合、用户维度、异常排序、钻取到该用户执行日志。所有请求经 api.ts，异步三态完整。

### Checklist

- [ ] 实现 `ExecutionTraceDrawer`、`TraceSummaryHeader`、`TraceTimeline`；稳定 key=`eventId`；abort/truncated 高亮。
- [ ] 实现 `SkillHealthTab`/`SkillHealthTable`：窗口切换后台刷新不闪；用户列；行点击钻取并带 `humanUserId`。
- [ ] 覆盖 loading/empty/error/success 与旧 Skill exec-only 提示。
- [ ] [verifier][integration] `frontend-component-specs#RULE-frontend-component-001`：容器/展示分离、props 类型化、无展示组件请求。
- [ ] [verifier][integration] `frontend-quality-standards#RULE-frontend-quality-001`：strict TS、三态、vitest 通过。
- [ ] [verifier][integration] `frontend-quality-standards#RULE-frontend-i18n-001`：新增 key zh/en 同步，列配置 `useMemo(...,[t])`。
- [ ] 先写时间线与健康列表交互测试并记录 RED。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-21 | E2E | API → 状态 → 抽屉渲染 | 汇总与事件按序显示；http 字段正确 | `console/frontend/test/AuditTrace.test.tsx` | `cd console/frontend && npm test -- --run Audit` | planned |
| S-22 | integration | 状态 → UI | aborted 徽标/事件高亮 | 同上 | 同上 | planned |
| S-24 | E2E | API → 列表 → 钻取 | 用户维度两行；钻取带 humanUserId | 同上 | 同上 | planned |
| S-25 | integration | truncated 数据 | 顶部提示"明细已截断，共 N 次" | 同上 | 同上 | planned |
| E-21 | integration | 请求失败 | Banner + ErrorDetail + 重试 | 同上 | 同上 | planned |
| E-24 | integration | 空数据 | 空态文案 | 同上 | 同上 | planned |
| E-25 | integration | 404 | 显示"执行不存在" | 同上 | 同上 | planned |
| B-22 | unit | 2000 条事件 | 首屏可用，不卡顿 | 同上 | 同上 | planned |
| B-23 | integration | 同名私有 Skill 两用户 | 两行分别显示用户 | 同上 | 同上 | planned |
| B-24 | integration | 旧 Skill exec-only | 提示"未使用统一客户端"，无错误 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-012: 跨边界 E2E 与兼容性验收

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-005, TASK-006, TASK-007, TASK-008, TASK-010, TASK-011
- **Source**: `skill-execution-control-and-review.backend.design.md#2.5.2 功能验收场景`, `skill-execution-control-and-review.backend.design.md#3.2 架构设计`（兼容性与渐进迁移）, `skill-execution-control-and-review.backend.design.md#4.2 发布与回滚`
- **Spec-Refs**: —（跨任务 E2E，无独立 Rule owner）
- **Acceptance-Refs**: S-01, S-02, S-05, S-14, S-16, E-11, RULE-13

### Description

在所有功能任务完成后执行跨边界验收：正常执行全链路、超限终止全链路、健康视图数据链路、两用户并发隔离、旧 Skill 零改造、版本错配/升级顺序。E2E 不得降级为 mock 后的 unit/integration。

### Checklist

- [ ] [S-01][E2E] 编写全链路用例（真实边界：Skill 脚本 → helper → spool → guard → 内部 API → SQLite → 查询 API），断言事件、汇总与脱敏。
- [ ] [S-02][E2E] 编写超限用例（helper 退出 → guard abort → IM 通知 → Console → 通知分发），断言第 N+1 次未发出、退出码 86、用户/管理员通知。
- [ ] [S-05][E2E] 验证 stats 数据 → API → UI 列表与异常标记。
- [ ] [S-14][E2E] 两用户并发同名 public Skill：trace 分离、告警按用户、统计两行。
- [ ] [S-16][E2E] 旧 Skill（raw requests + 手工头）升级后原样执行；只有 exec 事件；不触发限额。
- [ ] [E-11][integration] 版本错配/升级顺序：新 guard + 旧 Console、旧 guard + 新 Console 只降级不崩溃。
- [ ] [verifier][integration] RULE-13 兼容约束：确认未改 requests、CLI stdout、状态文件已有字段与旧链路行为。
- [ ] 执行 `cf_acceptance_runner.py --manifest <需求目录>/.acceptance-manifest.json --root . --include-e2e --write-evidence` 并记录证据。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | 全链路（脚本/helper/guard/API/DB） | 事件与汇总完整；无敏感头 | `console/backend/test/skill_trace_e2e_test.go` | `cf_acceptance_runner.py --include-e2e` | planned |
| S-02 | E2E | 全链路 + 通知 | 超限终止、IM、管理员告警 | 同上 | 同上 | planned |
| S-05 | E2E | 数据 → API → UI | 健康视图与异常标记 | 同上 | 同上 | planned |
| S-14 | E2E | 两用户并发 | trace/告警/统计隔离 | 同上 | 同上 | planned |
| S-16 | E2E | 旧 Skill → 新镜像 | 原行为不变；仅 exec trace | 同上 | 同上 | planned |
| E-11 | integration | 版本错配 | 降级不崩溃；spool 重试 | 同上 | 同上 | planned |
| RULE-13 | integration | 兼容面 | requests/CLI/状态文件/旧链路不变 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期由 `cf-task-start` 填写 RED/GREEN、断言位置与真实组件证据；E2E 由 verify-e2e 统一执行。

### Log

- [2026-10-17] created (draft)

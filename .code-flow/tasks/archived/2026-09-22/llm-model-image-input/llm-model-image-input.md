# Tasks: LLM 模型图片输入能力（多模态声明）

- **Source**: `.code-flow/tasks/2026-09-22/llm-model-image-input/llm-model-image-input.backend.design.md`, `.code-flow/tasks/2026-09-22/llm-model-image-input/llm-model-image-input.frontend.design.md`
- **Created**: 2026-09-22
- **Updated**: 2026-09-22

## Proposal

让 console 能声明 LLM 模型「支持图片输入」，并端到端下发为 OpenClaw 的 `models.providers[id].models[].input = ["text","image"]`。

起因是实测缺陷：图片消息下载解密成功（61035 bytes PNG）后**没有进入模型上下文**，而是被 offload 成 `[media attached: media://inbound/<id>]` 路径文本；agent 只能靠 `exec` 在容器内现装 OCR（288MB rapidocr），单轮 25 次工具调用、**8 分 34 秒**才回复，且该依赖装在容器可写层、pod 重建即丢。根因是 `bin/openclaw-config-renderer.mjs` 的 `renderProviders` 从不输出 `input` 字段，而运行时对没有 `input` 的模型**一律**按 text-only 处理（对照实验证明与模型名无关），因此凡经 console 下发的模型全部发不了图。模型本身具备视觉能力已实证（对其发送 `image_url` 返回 HTTP 200 并准确描述图片内容），属纯配置缺失。

期望效果：勾选后图片直接 inline 进模型上下文，offload + exec OCR 长尾路径整体消失。

> 本需求无 PRD，需求基线来自会话对齐结论 + pod 实证，详见两份 design 的 §2.1 业务背景。

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 |
|--------|---------|---------|-------------|---------|------|
| S-01 | backend.design.md#2.4 验收条件 | unit | renderer 真实实现（不 mock 渲染逻辑） | TASK-005 | verified |
| S-02 | backend.design.md#2.4 验收条件 | integration | HTTP handler → Store（真实 SQLite） | TASK-002 | verified |
| S-03 | backend.design.md#2.4 验收条件 | **E2E** | 同上 | TASK-009 | verified（2026-09-22 实测，见 TASK-009） |
| S-04 | backend.design.md#2.4 验收条件 | unit | DTO 序列化真实实现（`omitempty` 语义） | TASK-003 | verified |
| E-01 | backend.design.md#2.4 验收条件 | integration | 迁移 → 真实 SQLite | TASK-001 | verified |
| E-02 | backend.design.md#2.4 验收条件 | unit | `validateRuntimeConfig` 真实实现（`assertExactKeys`） | TASK-004 | verified |
| E-03 | backend.design.md#2.4 验收条件 | unit | renderer 真实实现 | TASK-005 | verified |
| E-04 | backend.design.md#2.4 验收条件 | integration | HTTP handler → Store | TASK-002 | verified |
| S-11 | frontend.design.md#2.4 验收条件 | integration | Browser → 对话框 → 列表重渲染（service 层为替身） | TASK-008 | verified |
| S-12 | frontend.design.md#2.4 验收条件 | integration | 组件 → 渲染（真实 fixture 数据） | TASK-007 | verified |
| S-13 | frontend.design.md#2.4 验收条件 | unit | 对话框组件真实实现 | TASK-008 | verified |
| E-11 | frontend.design.md#2.4 验收条件 | integration | Service(`api.ts`) → UI | TASK-008 | verified |
| E-12 | frontend.design.md#2.4 验收条件 | unit | 对话框组件真实实现（DOM 断言） | TASK-008 | verified |
| NFR-I18N-F01 | frontend.design.md#2.4 验收条件 | unit | 两份 locale 文件真实内容 | TASK-006 | verified |
| S-14 | frontend.design.md#2.4 验收条件 | unit | 两份 locale 文件真实内容 | TASK-006 | verified |
| RISK-B01 | backend.design.md#4.2 风险识别 | integration + manual | 旧 worker schema 拒绝未知 key；发布顺序 | TASK-009 | planned |
| RISK-B02 | backend.design.md#4.2 风险识别 | **manual** | 外部模型行为（provider 层 400）—— 无法在 CI 内自动化 | TASK-009 | confirmed-manual (user:jahan, 2026-09-22) |
| RISK-F03 | frontend.design.md#4. 风险与依赖 | **manual** | 用户误勾选后的外部模型行为 —— 无法在 CI 内自动化 | TASK-008 | confirmed-manual (user:jahan, 2026-09-22) |
| RISK-F01 | frontend.design.md#4. 风险与依赖 | unit | 列宽断言 | TASK-007 | verified |
| RISK-F02 | frontend.design.md#4. 风险与依赖 | unit | 对话框 DOM（label 包裹回归） | TASK-008 | verified |

> 覆盖范围 = design 中全部 P0/P1 场景（13 个 S/E 场景）+ RULE/高影响 RISK 映射场景。**E2E 场景 1 个（S-03）未降级**；S-11 原定 E2E，因仓库无浏览器级 E2E 设施、经用户 2026-09-22 确认降为 integration，真实浏览器段由 TASK-009 人工验收覆盖。`manual` = RISK-B02 / RISK-F03（外部模型行为）+ TASK-009 的真实 console 点击。
> RISK-B02 / RISK-F03 标为 `manual` **已由用户确认**（user:jahan，2026-09-22 会话）；理由为外部 provider 的运行时行为，无法在 CI 内自动化。

---

## TASK-001: repo — 新增 `supports_images` 列与幂等迁移

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `llm-model-image-input.backend.design.md#2.2 功能方案`, `#2.2.2 字段约束`, `#3.2 架构设计`
- **Spec-Refs**: backend-database#RULE-backend-database-001
- **Acceptance-Refs**: E-01

### Description

为 `llm_model_configs` 增加 `supports_images` 列并落地幂等迁移，作为整条链路的数据基础。列定义与既有 `supports_tools` 同构，默认 `0`（text-only），保证存量行行为不变。SQL 必须限于 `internal/repo`，迁移必须可重复执行且不破坏既有数据。

### Checklist

- [x] 在 `repo/schema.go` 的 `schemaDDL` 中，`llm_model_configs` 建表语句的 `supports_tools` 相邻处追加 `supports_images INTEGER NOT NULL DEFAULT 0 CHECK (supports_images IN (0,1))`
- [x] 新增 `migrateLLMModelSupportsImages()`：以 `columnExists(s.db, "llm_model_configs", "supports_images")` 守卫 + `ALTER TABLE llm_model_configs ADD COLUMN ...`，照 `migrateLLMModelSupportsTools` 的既有形态
- [x] 在 `migrate()`（`repo/schema.go`）中紧随 `migrateLLMModelSupportsTools` 注册新迁移
- [x] 在 `repo/models.go` 的 `LLMModelConfig` 中增 `SupportsImages bool`
- [x] `[E-01][integration]` **修改生产代码前**，对真实 SQLite 先写失败用例并记录 RED：连续调用迁移两次
- [x] `[E-01]` 断言 ①第二次执行为 nil error ②迁移前后 `SELECT` 全行结果（含既有 `supports_tools` 取值）逐行相等 ③新列默认值为 `0`
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/backend && go vet ./internal/repo/... && go test ./internal/repo/...`（`backend-database#RULE-backend-database-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-01 | integration | 真实 SQLite 文件、`columnExists` 的 `PRAGMA table_info` 路径、`migrate()` 注册顺序 | ① 二次迁移 err == nil ② 迁移前后全行结果逐行相等 ③ 新列默认 0 | `internal/repo/llm_model_migrate_test.go` / `TestMigrateLLMModelSupportsImagesIdempotentAndPreservesRows` | `cd console/backend && go test ./internal/repo/ -run TestMigrateLLMModelSupportsImages -v` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-01 | FAIL: `after first migrate: select row: SQL logic error: no such column: supports_images (1)` —— 与"缺少新列"对应的失败原因 | PASS: `--- PASS: TestMigrateLLMModelSupportsImagesIdempotentAndPreservesRows` | ① 幂等断言 `llm_model_migrate_test.go` 第二次 `store.migrate()` 返回 nil（L78-80）② 保全断言 `assertLegacyRowPreserved` 中 `supports_tools != 0` 与 `supports_images != 0` 双向校验（L67-76）③ 行数 `COUNT(*) == 1`（L83-88）④ 重开后再验（L92-104） | 真实组件：`Open()` 走真实 `migrate()`→`migrateLLMModelSupportsImages()`→`columnExists()` 的 `PRAGMA table_info` 路径；DB 为 `t.TempDir()` 下真实 SQLite 文件；"旧库"由测试手写不含新列的建表语句构造，因此真实走到了 `ALTER TABLE ADD COLUMN` 分支（非 DDL 建表分支） | verified |

> 回归：`go vet ./...` 干净；`go test ./...`（console/backend 全量，含 `internal/api`、`internal/runtimeconfig`、`test` 集成包）全部 ok。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)：Start Gate pass；Refs 裸写法修正；baseline HEAD e2f752d，pre-existing requirements.txt
- [2026-09-22] completed (done)：E-01 verified（RED→GREEN）；后端全量测试通过

---

## TASK-002: repo + api — create/update/view 读写贯通 `supportsImages`

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `llm-model-image-input.backend.design.md#3.3 接口设计`, `#2.2 功能方案`
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-write-err-001, backend-database#RULE-backend-no-select-star-001, backend-platform-rules#RULE-backend-http-envelope-001, backend-logging#RULE-backend-logging-001, backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: S-02, E-04

### Description

把新列贯通到 API 层：create 采用**默认 `false`**（与 `supportsTools` 默认 `true` 相反）、update 用 `*bool` 区分「缺省不触碰」与「显式置 false」、view 输出具体布尔。错误路径沿用既有 `errcode` 常量与 `writeErr`，不新增错误码。成功后随既有 `enqueueModelReconcile` 触发热下发。

### Checklist

- [x] `repo/llm_models.go`：`LLMModelConfigCreate` 增 `SupportsImages bool`；`LLMModelConfigUpdate` 增 `SupportsImages *bool`
- [x] `repo/llm_models.go`：`llmModelColumns` 常量追加 `m.supports_images`（显式列清单，禁止 `SELECT *`）
- [x] `repo/llm_models.go`：`prepareLLMModelConfig` 复制、`insertLLMModelConfig` 以 `boolToInt` 写入、`scanLLMModelConfig` 以 `int` 中转、`UpdateLLMModelConfig` 仅在 `!= nil` 时追加 `supports_images = ?`
- [x] `api/llm.go`：`llmModelInput` 增 `SupportsImages *bool \`json:"supportsImages"\``；`prepareLLMModelCreate` 中缺省解析为 **`false`**（注释写明与 supportsTools 默认相反）；`llmModelUpdateRequest` 增 `*bool`；`llmModelView` 输出 `"supportsImages"`
- [x] `[S-02][integration]` **修改生产代码前**先写失败用例并记录 RED：`PATCH` 携带 `supportsImages:true` → `GET` 列表回读
- [x] `[S-02]` 断言 PATCH 与 GET 响应均含 `supportsImages:true`，且 `enqueueModelReconcile` 被触发（目标 pod config generation 前移）
- [x] `[E-04][integration]` 覆盖 PATCH 仅带 `apiKey`（`supportsImages` 为 nil）时，库中该列**保持原值不被改写为 0**
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/backend && go test ./internal/api/... ./internal/repo/...`（`backend-code-quality-performance#RULE-backend-write-err-001` / `backend-database#RULE-backend-no-select-star-001` / `backend-platform-rules#RULE-backend-http-envelope-001`）
- [x] [verifier][manual] `backend-logging#RULE-backend-logging-001`：确认本次未新增任何日志/审计输出，且 handler 不落凭证（view 不回显 apiKey）
- [x] [verifier][manual] `backend-platform-rules#RULE-backend-model-pool-001`：确认未触碰 Human User 创建与 `model_config_id` 绑定路径

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02 | integration | HTTP handler（真实路由）、真实 SQLite、`enqueueModelReconcile` | ① PATCH 响应 `supportsImages:true` ② GET 列表回读一致 ③ generation 前移 | `test/llm_model_image_input_test.go` / `TestLLMModels_SupportsImagesRoundTrip` | `cd console/backend && go test ./test/ -run TestLLMModels_SupportsImagesRoundTrip -v` | verified |
| E-04 | integration | HTTP handler、真实 SQLite | 仅改 `apiKey` 后 `supports_images` 列值与请求前相等 | `test/llm_model_image_input_test.go` / `TestLLMModels_PatchWithoutSupportsImagesKeepsExistingValue` | `cd console/backend && go test ./test/ -run TestLLMModels_PatchWithoutSupportsImagesKeepsExistingValue -v` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-02 | FAIL: `创建默认应为 supportsImages:false` —— 创建响应体完全未含该字段（view 未输出） | PASS | ① 创建默认 false（L22-30）② PATCH 回显 true（L50-53）③ GET 列表回读（L56-61）④ `after.ConfigGeneration == before+1`（L64-70） | 真实路由（`e.do` 打真实 handler）、真实 SQLite（`e.store`）、真实 generation 前移（`enqueueModelReconcile→MarkPodsPendingForModel`） | verified |
| E-04 | FAIL: `status = 400, want 201` —— 带 `supportsImages:true` 的创建请求被 40001 拒（字段未被 DTO 接受） | PASS | ① 显式 true 被接受（L77-80）② 仅改 apiKey 后 PATCH 回显仍 true（L88-92）③ GET 回读仍 true（L93-98） | 同上；关键点为 `*bool` 为 nil 时 SQL 不追加 `supports_images = ?` | verified |

> 回归：`go vet ./...` 干净；`go test ./...`（console/backend 全量）全部 ok。
> [verifier][manual] 已核验：未新增日志/审计输出；未触碰 Human User 创建与 `model_config_id` 绑定路径。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：S-02 / E-04 verified（RED→GREEN）；后端全量测试通过

---

## TASK-003: console runtime DTO — 三态指针传递

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `llm-model-image-input.backend.design.md#3.2 架构设计`, `#2.2 功能方案`
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-directory-structure#RULE-backend-directory-001, backend-platform-rules#RULE-backend-platform-001, backend-logging#RULE-backend-redact-001
- **Acceptance-Refs**: S-04

### Description

控制面 DTO 只表达「支持图片」这一种非默认状态：`true` 时置指针并出现在 JSON，`false`/缺省时字段整体不出现，从而保证存量配置字节级不变（旧 worker 兼容）。**条件方向与 `supportsTools` 相反** —— 后者是 `false` 时输出，本字段是 `true` 时输出。

### Checklist

- [x] `runtimeconfig/models.go`：`modelConfig` 增 `SupportsImages bool`；`modelFromConfig` 复制该值
- [x] `runtimeconfig/models.go` 的 `runtimeProvider`：追加 `if model.SupportsImages { enabled := true; provider.SupportsImages = &enabled }`，注释写明与 `SupportsTools` 的**方向相反**及原因
- [x] `driver/runtime.go` 的 `RuntimeProvider` 增 `SupportsImages *bool \`json:"supportsImages,omitempty"\``，注释说明 omit 语义（缺省 = text-only，与 `supportsTools` 缺省 = 开启 相反）
- [x] `[S-04][unit]` **修改生产代码前**先写失败用例并记录 RED：分别以 `true` / `false` 构建 DTO
- [x] `[S-04]` 断言 `true` → JSON 含 `"supportsImages":true`；`false` → JSON **不含**该键
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/backend && go vet ./... && go test ./internal/runtimeconfig/... ./internal/driver/...`（`backend-code-quality-performance#RULE-backend-quality-001` / `backend-directory-structure#RULE-backend-directory-001` / `backend-platform-rules#RULE-backend-platform-001`）
- [x] [verifier][manual] `backend-logging#RULE-backend-redact-001`：确认本次未新增写入日志/审计/apply 失败字段的 error，未引入需 `auditlog.RedactDiagnostic` 的新诊断输出

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | unit | `runtimeProvider` 真实构建逻辑、真实 `encoding/json` 序列化 | ① `true` → JSON 含 `supportsImages:true` ② `false` → JSON 不含该键 | `internal/runtimeconfig/supports_images_test.go` / `TestRuntimeProviderSupportsImagesSerialization` | `cd console/backend && go test ./internal/runtimeconfig/ -run TestRuntimeProviderSupportsImagesSerialization -v` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-04 | FAIL(build): `enabled.SupportsImages undefined (type modelConfig has no field or method SupportsImages)` —— 新字段不存在 | PASS | ① true → JSON 含 `"supportsImages":true`（L26-33）② false/缺省 → JSON 不含该键（L37-54） | `runtimeProvider()` 真实构建逻辑；`json.Marshal` 真实序列化，断言的是旧 worker 实际收到的 DTO 形态 | verified |

> 回归：`go vet ./...` 干净；`go test ./...`（console/backend 全量）全部 ok。
> [verifier][manual] 已核验：未新增日志/诊断输出（除字段注释）；未触碰多用户隔离与 model-pool 绑定；改动全部位于 `internal/`，handler 未持有持久化/driver 细节。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：S-04 verified（RED→GREEN）；后端全量测试通过

---

## TASK-004: worker schema — 白名单接受 `supportsImages`

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: `llm-model-image-input.backend.design.md#3.2 架构设计`, `#4.2 风险识别`
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: E-02

### Description

`bin/runtime-config-schema.mjs` 的 `validateProviders` 使用严格 `assertExactKeys`，DTO 多一个未知 key 即校验失败。必须把 `supportsImages` 加入允许清单与可选清单，否则 TASK-003 下发的字段会让 apply 前置失败。

### Checklist

- [x] `bin/runtime-config-schema.mjs` 的 `validateProviders`：`assertExactKeys` 的允许 key 数组加入 `"supportsImages"`；可选 key 数组同步加入（保持向后兼容，允许缺省）
- [x] 增加类型校验：存在时必须为 boolean（照 `optionalThinking` 的既有 helper 风格）
- [x] `[E-02][unit]` **修改生产代码前**先写失败用例并记录 RED：构造含清单外 key 的 provider DTO
- [x] `[E-02]` 断言 ①`supportsImages` 为合法 boolean 时校验通过 ②携带未知 key 时抛错且不产生半截配置
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd bin && node --test test/`（`runtime-config-and-apply#RULE-runtime-validate-before-write-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-02 | unit | `validateRuntimeConfig` / `assertExactKeys` 真实实现 | ① 合法 boolean 通过 ② 非 boolean 抛错 ③ 清单外 key 仍被严格拒绝 | `bin/test/runtime-config-schema.test.mjs`（3 个 test） | `cd bin && node --test test/*.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-02 | FAIL: `AssertionError: Got unwanted exception` —— `assert.doesNotThrow` 失败，因 `parseRuntimeConfig` 抛 `contains unknown field: supportsImages` | PASS（3/3） | ① true 被接受（test 1 前半）② 缺省被接受（test 1 后半）③ 非 boolean 抛错（test 2）④ 拼写错误 `supportsImage` 仍被 `unknown field` 拒绝（test 3） | `parseRuntimeConfig` 真实实现，走真实 `assertExactKeys` 严格校验路径；断言的是 apply 前置校验的真实行为 | verified |

> 回归：`cd bin && node --test test/*.test.mjs` → 99/99 pass。
> **命令修正**：原计划的 `node --test test/` 在本 Node 版本（v24）会把 `test/` 当模块路径解析而报 `MODULE_NOT_FOUND`，正确写法是 `node --test test/*.test.mjs`。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：E-02 verified（RED→GREEN）；bin 全量 99/99

---

## TASK-005: worker renderer — `true` → `input:["text","image"]`

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: `llm-model-image-input.backend.design.md#3.2 架构设计`, `#2.2 功能方案`
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-directory-structure#RULE-runtime-directory-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-01, E-03

### Description

**这是修复的落点。** `bin/openclaw-config-renderer.mjs` 的 `renderProviders` 在 `supportsImages === true` 时输出 `input: ["text","image"]`；`false`/缺省时不输出该键，使存量配置与改动前逐字节一致。只修改 `bin/` 既有文件，不 vendor/fork 上游；config 物化沿用既有 `0o600` 原子写，不新增落盘路径。

> 注意 `inputModalities` 是 catalog entry 的拼写，写进 provider config 会报 `Invalid input`，**必须用 `input`**。

### Checklist

- [x] `bin/openclaw-config-renderer.mjs` 的 `renderProviders`：在既有 `supportsTools` 条件旁追加 `if (provider.supportsImages === true) { model.input = ["text", "image"]; }`，注释写明「OpenClaw 对无 `input` 的模型默认 text-only，故只在开启时表达」
- [x] 确认渲染后仍走既有 `validateRuntimeConfig` + 原子写（`0o600`），不新增落盘路径
- [x] `[S-01][unit]` **修改生产代码前**先写失败用例并记录 RED：以 `supportsImages:true` 渲染
- [x] `[S-01]` 断言渲染结果 `models.providers[id].models[0].input` 深等于 `["text","image"]`
- [x] `[E-03][unit]` 断言未携带 `supportsImages` 时渲染输出与改动前**逐字节一致**（不含 `input` 键）
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd bin && node --test test/`（`runtime-config-and-apply#RULE-runtime-config-001` / `runtime-directory-structure#RULE-runtime-directory-001` / `runtime-isolation-and-security#RULE-runtime-secret-file-mode-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | unit | `renderProviders` 真实实现（不 mock 渲染逻辑） | `models[0].input` 深等于 `["text","image"]` | `bin/test/inject-multi-user-config.test.mjs` / `renderer maps supportsImages:true to OpenClaw model input [text,image]` | `cd bin && node --test test/inject-multi-user-config.test.mjs` | verified |
| E-03 | unit | 同上 + 真实 JSON 序列化 | 缺省时输出与基线逐字节相等 | `bin/test/inject-multi-user-config.test.mjs` / `renderer omits model input when supportsImages is false or absent` | `cd bin && node --test test/inject-multi-user-config.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-01 | FAIL: `AssertionError: Expected values to be strictly deep-equal: + actual - expected` → `actual: undefined` vs `expected: ["text","image"]` | PASS | `assert.deepEqual(provider.models[0].input, ["text","image"])` | `renderOpenClawConfig` 真实实现，走真实 `renderProviders`；断言对象是最终写入 openclaw.json 的 `models.providers[id].models[0].input` | verified |
| E-03 | PASS（基线行为，改动前后均不输出；断言即回归护栏） | PASS | ① 缺省 → `input === undefined` ② 显式 `false` → `input === undefined` | 同上 | verified |

> 回归：`cd bin && node --test test/*.test.mjs` → 101/101 pass。
> [verifier][manual] 已核验：① 未新增落盘路径，渲染结果仍由既有 `validateRuntimeConfig` + 原子写（`0o600`）物化（本任务只往 `model` 对象加一个键）② 只修改 `bin/` 既有文件，未 vendor/fork 上游 ③ 变更仍随既有 generation/事务 apply 链路下发。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：S-01 / E-03 verified（RED→GREEN）；bin 全量 101/101。**本任务是整条链路的修复落点**

---

## TASK-006: 前端类型与 i18n 文案

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `llm-model-image-input.frontend.design.md#3.4 组件接口契约`, `#3.7 样式方案`, `#3.8 可访问性与兼容性`, `#2.2 功能方案`
- **Spec-Refs**: frontend-quality-standards#RULE-frontend-i18n-001, frontend-directory-structure#RULE-frontend-api-types-001
- **Acceptance-Refs**: S-14, NFR-I18N-F01

### Description

先落地共享类型与两份 locale 文案，作为 TASK-007/008 的公共依赖（避免两个任务同时改 locale 文件产生冲突）。类型三处：读模型必填、create/update 可选。文案新增「模型能力」分组/列头、「文本+图片」能力项及其 aria，并复用既有「工具调用」Tag 文案。

### Checklist

- [x] `types/api.ts`：`LLMModelConfig` 增 `supportsImages: boolean`（必填）；`LLMModelInput` 与 `LLMModelUpdateInput` 增 `supportsImages?: boolean`（可选）
- [x] `i18n/locales/zh.ts`：新增 `model.capabilities`（「模型能力」）、`model.imageInput`（「文本+图片」）、`model.imageInputAria`；`model.supportFunctionCalls` 的值由「支持函数调用（工具）」改为「工具调用」
- [x] `i18n/locales/en.ts`：同步补齐同名 key，不得遗漏
- [x] `[NFR-I18N-F01][unit]` **修改生产代码前**先写失败用例并记录 RED：断言两份 locale 的 key 集合一致且新增 key 均存在
- [x] `[NFR-I18N-F01]` 断言 zh 与 en 的 `model.*` 新增 key 一一对应，无硬编码中文残留在组件内
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/frontend && npx tsc --noEmit && npm test`（`#RULE-frontend-i18n-001` / `#RULE-frontend-api-types-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| NFR-I18N-F01 | unit | 两份 locale 文件真实内容、真实 `tsc` 类型检查 | ① zh/en 新增 key 一一对应 ② `tsc --noEmit` 无错 ③ 中文能力项文案与设计一致 | `test/i18n.test.ts`（2 个 it） | `cd console/frontend && npx tsc --noEmit && npx vitest run` | verified |
| S-14 | unit | 两份 locale 文件真实内容 | 中英两份能力文案均存在且为对应语言文案（en 不回落 key 名） | `test/i18n.test.ts` / `renders English labels for the capability group without falling back to key names` | `cd console/frontend && npx vitest run test/i18n.test.ts` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| NFR-I18N-F01 | FAIL(2/2): `expect(model.imageInput).toBe("文本+图片")` → `Received: undefined`；key 存在性断言同样失败 | PASS(2/2) |
| S-14 | FAIL: en 侧 `model.imageInput` 为 `undefined`（renderer 从未渲染过英文能力文案） | PASS(3/3) | ① en `capabilities === "Capabilities"` ② en `imageInput === "Text + image"` ③ en `supportFunctionCalls === "Tool calls"`（不回落为 key 名） | 直接 import 真实 `en.ts`；key 结构由 `const en: AppLocale` 在 tsc 层强制 | verified |
| NFR-I18N-F01 | FAIL(2/2): `expect(model.imageInput).toBe("文本+图片")` → `Received: undefined`；key 存在性断言同样失败 | PASS(2/2) | ① zh/en 的 `capabilities`/`imageInput`/`imageInputAria` 均存在且非空（test 1）② zh `toolCalls==="工具调用"`、`imageInput==="文本+图片"`、`supportFunctionCalls==="工具调用"`（test 2） | 直接 import 两份真实 locale 文件对象；key 结构一致性由 `const en: AppLocale` 在 tsc 层强制（漏 key 编译不过），本测试补值层 | verified |

> 回归：`npx tsc --noEmit` 干净；`npx vitest run` → **22 文件 / 161 测试全绿**。
>
> ⚠️ **跨任务改动（已在 TASK-006 处理）**：本任务把 `model.supportFunctionCalls` 的值由「支持函数调用（工具）」改为「工具调用」（设计 §3.4 要求），导致 `test/LLM.test.tsx` 中 3 处按旧可见文案定位 checkbox 的查询失配（`Unable to find an accessible element with the role "checkbox" and name /支持函数调用/`）。该文件在计划上归 TASK-007/008，但**是我的改动把它改红的**，故在此一并把 3 处查询更新为 `{ name: /工具调用/ }`，避免留下红色套件。TASK-007/008 在此基础上继续。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：NFR-I18N-F01 verified；tsc 干净、前端 161/161
- [2026-09-22] 收尾校验收回：原 Acceptance-Refs 只含 NFR、缺 S/E/B 场景 → design v0.3 补 S-14 并补测（en 文案断言）

---

## TASK-007: 前端列表「模型能力」列

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006
- **Source**: `llm-model-image-input.frontend.design.md#3.3 组件设计`, `#3.7 样式方案`, `#2.4 验收条件`
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001
- **Acceptance-Refs**: S-12, RISK-F01

### Description

把原「工具调用」单值列升级为「模型能力」列，由 `supportsTools` / `supportsImages` 两个布尔派生 Tag 列表（四种组合）。派生为纯展示逻辑，不引入网络调用、不用内联样式；列宽需容纳两个 Tag，并同步更新列宽总和断言。

### Checklist

- [x] `pages/LLM.tsx`：列定义 `title` 改为 `t("model.capabilities")`，`dataIndex` 改为派生逻辑，width 常量调大（原 `toolCalls: 90`）
- [x] 派生渲染：两者皆 true → 两个 Tag（`工具调用` + `文本+图片`，green）；仅一者 → 单 Tag；皆 false → `不支持`（grey）
- [x] `[S-12][integration]` **修改生产代码前**先写失败用例并记录 RED：以四种能力组合的 fixture 渲染列表
- [x] `[S-12]` 断言四种组合的最外层渲染结果与 design §2.4 表格一致（含 Tag 数量与文案）
- [x] `[RISK-F01][unit]` 更新 `MODEL_TABLE_COLUMN_WIDTHS` 总和断言（原 `toBe(1390)`）为新总和并断言通过
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/frontend && npm test`（`frontend-component-specs#RULE-frontend-component-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-12 | integration | 组件真实渲染（真实 fixture 数据，不 mock 组件） | 四种组合的 Tag 数量与文案符合 design §2.4 | `test/LLM.test.tsx` / `renders the capability column for all four combinations` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| RISK-F01 | unit | 真实列宽常量与断言 | 列宽总和为新值（1400→1460）且通过 | `test/LLM.test.tsx` / `keeps model columns compact enough to fit without horizontal table scrolling` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-12 | FAIL: 三项失败，原因与「列仍为旧单值 Tag（支持/不支持）、表头仍为『工具调用』、列宽总和仍为 1390」一一对应；四组合行内取不到 `工具调用` / `文本+图片` | PASS(9/9) | ① both 行同时含 `工具调用`+`文本+图片` ② tools 行含 `工具调用`、不含 `文本+图片` ③ images 行反之 ④ none 行含 `不支持`（均用 `within(row)` 限定到行，避免与表头同名文案串味） | 真实 `LLM` 组件渲染 + 真实 fixture（4 个模型各覆盖一种组合）；Tag 派生为纯展示逻辑，无网络 IO | verified |
| RISK-F01 | FAIL: 列宽总和 `1390 !== 1460` | PASS | `Object.values(MODEL_TABLE_COLUMN_WIDTHS)` 求和 `toBe(1460)` | 真实列宽常量（`toolCalls:90` → `capabilities:160`） | verified |

> 回归：`npx tsc --noEmit` 干净；`npx vitest run` → **22 文件 / 162 测试全绿**。
> 同步修改：既有「shows plaintext API keys and test results」中两处断言随列改造更新（表头 `工具调用` → `模型能力`；`支持` Tag 已不存在，改断言 `工具调用`）。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] completed (done)：S-12 / RISK-F01 verified；前端 162/162

---

## TASK-008: 前端对话框「模型能力」分组

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-007
- **Source**: `llm-model-image-input.frontend.design.md#3.3 组件设计`, `#3.4 组件接口契约`, `#3.5 状态与数据流`, `#3.6 UI 状态`
- **Spec-Refs**: frontend-component-specs#RULE-frontend-semi-shell-001, frontend-quality-standards#RULE-frontend-quality-001, frontend-quality-standards#RULE-frontend-api-client-001, frontend-directory-structure#RULE-frontend-directory-001
- **Acceptance-Refs**: S-11, S-13, E-11, E-12, RISK-F02, RISK-F03

### Description

新建与编辑对话框把原单个 checkbox 改为「模型能力」分组，内含 `工具调用`（沿用原值）与 `文本+图片`（新增，**默认不勾**）。两者为独立布尔，不合并。checkbox 必须位于 `Field as="div"` 中（禁止被 `<label>` 包裹，否则 label 激活与 input 事件双触发）。提交沿用既有 `api.createLLMModels` / `api.updateLLMModel`，不新增 API 方法或路径字符串。

### Checklist

- [x] `LLMCreateDialog.tsx`：draft 增 `supportsImages: boolean`，初值 **`false`**；JSX 改为 `<Field as="div" label={t("model.capabilities")}>` 内含两个 `<Checkbox>`；批量 payload 增 `supportsImages: draft.supportsImages`
- [x] `LLMEditDialog.tsx`：增 `useState<boolean>`（打开模型时以 `model.supportsImages` 重置）；JSX 同上；PATCH payload 增 `supportsImages`
- [x] `[S-13][unit]` **修改生产代码前**先写失败用例并记录 RED：新建对话框与编辑对话框的初值/回显
- [x] `[S-13]` 断言 新建时「文本+图片」未勾选、「工具调用」沿用既有默认；编辑 `supportsImages:true` 的模型时两者回显正确
- [x] `[S-11][E2E]` 走真实 service 层：打开编辑对话框 → 勾选「文本+图片」→ 保存，断言 PATCH 请求体含 `supportsImages:true`、对话框关闭、列表该行出现「文本+图片」Tag（**不得 mock `api.ts` 或路由**）
- [x] `[E-11][integration]` 断言 PATCH 返回 `ApiError` 时对话框保持打开、`busy` 复位、经 `Toast` 展示本地化文案、勾选状态不丢失
- [x] `[E-12][unit]` 断言点击 checkbox 一次 `onChange` 只触发一次，且 `el.closest("label") === null`（`RISK-F02` label 包裹回归）
- [x] 运行 verifier 并填写 Acceptance Evidence：`cd console/frontend && npm test`（`frontend-quality-standards#RULE-frontend-quality-001` / `frontend-quality-standards#RULE-frontend-api-client-001` / `frontend-component-specs#RULE-frontend-semi-shell-001` / `frontend-directory-structure#RULE-frontend-directory-001`）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-11 | integration（原 E2E，已同步 design v0.2） | Browser DOM、对话框、列表重渲染（`src/api` 为模块级替身；真实浏览器 + 真实 HTTP 段由 TASK-009 人工覆盖） | ① PATCH 体含 `supportsImages:true` ② 对话框关闭 ③ 列表出现「文本+图片」Tag | `test/LLM.test.tsx` / `sends supportsImages and refreshes the capability column after saving` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| S-13 | unit | 两个对话框组件真实实现 | 新建默认未勾；编辑回显与数据一致 | `test/LLM.test.tsx` / `defaults image capability off…` + `reflects the saved image capability…` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| E-11 | integration | `api.ts` 真实错误路径 → UI | ① 对话框不关闭 ② 勾选状态不丢失（可重试） | `test/LLM.test.tsx` / `keeps the edit dialog open and reports the error when saving fails` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| E-12 | unit | 对话框真实 DOM | `onChange` 单次触发；`closest("label") === null` | `test/LLM.test.tsx` / `fires onChange once for the image checkbox…` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| RISK-F02 | unit | 同上 | 同 E-12 | `test/LLM.test.tsx` / `fires onChange once for the image checkbox…` | `cd console/frontend && npx vitest run test/LLM.test.tsx` | verified |
| RISK-F03 | **manual** | 外部 LLM provider 行为 | 对不支持视觉的模型勾选后 provider 层返回 400 的确认记录 | 手工记录 | 手动执行 | confirmed-manual (user:jahan, 2026-09-22) |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-13 | FAIL: 找不到 `checkbox` name `/文本\+图片/`（新 checkbox 不存在） | PASS(14/14) | ① 新建：`文本+图片` 未勾选、`工具调用` 已勾选 ② 编辑：`supportsImages:true` 的模型回显为已勾选 | 两个对话框组件真实实现（真实渲染 + 真实 state） | verified |
| E-12 / RISK-F02 | FAIL: 同上（无该 checkbox） | PASS | ① `onChange` 监听器 `toHaveBeenCalledTimes(1)` ② `imageCheckbox.closest("label") === null` | 对话框真实 DOM；`Field as="div"` 未包裹 `<label>` | verified |
| E-11 | FAIL: 同上 | PASS | 保存抛错后 ① 对话框仍在（`编辑模型配置 Alice Model` 可见）② `文本+图片` 仍为 checked | `apiMocks.updateLLMModel.mockRejectedValueOnce` 走真实 `ApiError` 分支 → 页面 `onError` | verified |
| S-11 | FAIL: 同上 | PASS | ① `updateLLMModel` 收到 `model-a` + `objectContaining({supportsImages:true})` ② 对话框关闭 ③ 列表重渲染出 `文本+图片` | 断言对话框真实构造的请求载荷 + 页面真实重渲染；`src/api` 为项目既有模块级替身 | verified |

> 回归：`npx tsc --noEmit` 干净；`npx vitest run` → **22 文件 / 167 测试全绿**。
> 同步修改：既有「edits apiKey, supportsTools, and thinking…」与「creates model configs from form fields…」两处精确载荷断言随新增字段更新；fixture 补 `supportsImages`（服务端总会返回该字段）。

### 决策与裁定记录（2026-09-22 已裁定）

- **[已裁定 — user:jahan] S-11 的测试层级**：design §2.4 把 S-11 定为 **E2E**，其「关键真实边界」明确要求 `api.ts` service 层**不得 mock**。但本项目前端测试基础设施是 vitest + jsdom，在**模块级**替身 `src/api`（见 `test/LLM.test.tsx` 的 `vi.mock("../src/api")`），仓库内也没有 MSW / Playwright 等浏览器级 E2E 设施（`requirements.txt` 里的 playwright 是 agent runtime 侧依赖，非 console UI 测试用）。
- 因此 S-11 实际只能以 **integration** 落地（断言对话框真实构造的 PATCH 载荷 + 页面真实重渲染），**未达 design 要求**。按 cf-task 规则，agent 不得自行降级，故此处**不标 verified**、TASK-008 保持 `in-progress`。
- 补偿覆盖（供裁定参考，**不替代**你的决定）：UI→载荷 由本条 integration 覆盖；载荷→API→DB 由 **S-02**（已 verified）覆盖；HTTP 线格式由既有 `test/api.test.ts` 覆盖。缺口仅剩「真实浏览器 + 真实 HTTP」这一段。
- **裁定结果**：采纳 (a)+(c) —— design v0.2 已把 S-11 层级/Boundary 同步改为 integration；真实浏览器 + 真实 HTTP 那一段改由 **TASK-009 的人工验收**覆盖（已加入其 Checklist 与 Acceptance Contract）。未引入新基础设施。

### Log
- [2026-09-22] created (draft)
- [2026-09-22] started (in-progress)
- [2026-09-22] 实现与 5 项场景验证完成，前端 167/167
- [2026-09-22] S-11 层级降级经用户裁定（认可降级 + TASK-009 补人工点击）；design v0.2 已同步
- [2026-09-22] completed (done)

---

## TASK-009: 端到端验收与发布顺序验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-008
- **Source**: `llm-model-image-input.backend.design.md#2.4 验收条件`, `#4.2 风险识别`, `#3.4 性能与容量考量`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001, runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001, runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-03, RISK-B01, RISK-B02

### Description

本任务不产出生产代码，负责验证整条链路真实成立并核对发布顺序风险。

**S-03 是本次修复的最终验收**：必须打通 API → Store → runtimeapply → pod 内**真实生成的 openclaw.json** → OpenClaw model catalog，再发一张真实图片确认图片进入模型上下文。任一环不得 mock。

> ⚠️ **该场景含 pod 级操作**（勾选后 apply、发送真实图片），**需要用户单独授权**才能执行；未授权前本任务保持 draft。CI 内可自动化的部分（渲染产物含 `input`）由 TASK-005 的 S-01 覆盖。

### Checklist

- [x] 确认 `runtime-isolation-and-security#RULE-runtime-security-001`：本改动不新增凭证通道，apiKey 仍由控制面注入、绝不进镜像、绝不出现在日志
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-001`：确认本次未触及 Skill 分层/激活/telemetry/并发（该 spec 由 `bin/*.mjs` 目录邻近匹配，非真实触碰）
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-layering-001`：确认未涉及 system/public/private 解析顺序
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-log-injection-001`：确认未新增 tool/plugin 模块、未改日志注入方式
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-log-prefix-001`：确认未新增日志行、未涉及模块前缀
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-fail-loud-001`：确认未新增 Skill 脚本
- [x] `[RISK-B01][integration]` 断言旧 worker schema 收到未知 key 时 `assertExactKeys` 拒绝，且默认不勾时字段不出现在 DTO（存量 pod 零影响）
- [x] `[S-03][E2E]` **经用户授权后**：对目标 pod 勾选 `supportsImages` 并 apply（2026-09-22 已执行）
- [x] `[S-03]` 在 pod 内执行 `node openclaw.mjs models list`，断言 `Input` 列显示 `text+image`
- [x] `[S-03]` 向该 agent 发送一张真实图片，断言 trajectory 中 `content[].type` 出现 `image`
- [x] `[S-03]` 断言 不再出现 `openclaw-staged` / `[media attached:]` offload 标记；不再出现 `exec` 触发的 OCR 工具调用（8.5 分钟长尾消失）
- [x] `[MANUAL-F01][manual]` **经用户授权后**：在**真实 console**（浏览器）打开编辑模型 → 勾选「文本+图片」→ 保存 → 列表该行「模型能力」列出现 `文本+图片` Tag（2026-09-22 用户已在真实 console 完成勾选保存：provider 的 `input` 字段被置位可证（pod01/pod02 均如此）；列表 Tag 的浏览器内渲染由组件测试 S-12 覆盖，见下文「决策与裁定记录」）
- [x] 记录发布顺序结论：console 先行、worker 镜像跟上；并记录 `RISK-B02`（误勾选导致 provider 层 400）的人工验证结果
- [x] 运行 verifier 并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-03 | **E2E** | 同上 | ① catalog `Input` = `text+image` ② user message 出现 `image` 块 ③ 无 offload 标记 ④ 无 exec OCR | 手工验收记录（见下方实测结果；pod01 重启后 + pod02 双复核） | 手动执行 | verified |
| RISK-B01 | integration | 旧版 schema（未知 key 拒绝）+ 真实 DTO 序列化 | ① 未勾选时 DTO 不含 `supportsImages` ② 旧 schema 收到未知 key 报错 | 已由 TASK-004 的 E-02（未知 key 被拒）与 TASK-003 的 S-04（`omitempty` 缺省不含该键）分别覆盖 | `cd bin && node --test test/*.test.mjs` | verified |
| RISK-B02 | **manual** | 外部 LLM provider 行为 | 对不支持视觉的模型勾选后 provider 层返回 400 的确认记录 | 手工记录 | 手动执行 | confirmed-manual (user:jahan, 2026-09-22) |
| MANUAL-F01 | **manual** | 真实 console（浏览器）+ 真实 HTTP + 真实 pod | 勾选「文本+图片」保存后该设置生效（`input` 字段被置位） | 用户 2026-09-22 在真实 console 操作；可观测结果：`openclaw.json` 中 `input=['text','image']` | 手动执行 | verified（用户确认） |

> RISK-B02 为 `manual` 的理由：属于外部 provider 的运行时行为，无法在 CI 内自动化。**已由用户确认**（user:jahan，2026-09-22）。

### Acceptance Evidence

> **S-03 结论：verified** —— 首轮（仅热重载）FAILED，重启 pod01 后 PASS，pod02 双复核 PASS，另经 **Mattermost 通道**复核 PASS（证明与通道无关）。分阶段证据见下。

#### S-03 实测结果（2026-09-22）

镜像 `muad-openclaw:dev-1790054838`（本需求最终产出的 app 镜像）。**结论：PASS**；但过程中暴露一条必须记住的运维约束。

##### 第一轮：热重载生效后仍 FAILED（pod01，`muad-oc-pod01-7ff6f8c969-9n7tz`）

| 断言 | 结果 | 证据 |
|------|------|------|
| ① catalog `Input = text+image` | **PASS** | `openclaw.json` 中 `input=['text','image']`；`models list` 显示 `text+image`；13:30:47 日志有 `config hot reload applied (models.providers.…)` |
| ② user message 含 `image` 块 | **FAIL** | 会话 `9ad5f787-…jsonl` 中带图消息 `content` 为裸字符串（`'图片里面有什么内容'`），**无 image 块** |
| ③ 无 offload 标记 | **FAIL** | prompt 仍为 `[media attached: <fs path>]` |
| ④ 无 exec OCR | **FAIL** | 该轮走 `exec: which tesseract…` → `pip install pytesseract/rapidocr` → OCR，整轮 ~2.4 分钟 |

##### 第二轮：**重启 pod01 后 PASS**

重启方式：deployment template 注解 `muad/restartedAt` 置位 → 新 ReplicaSet（`-968c84584-` 取代 `-7ff6f8c969-`）→ pod 于 14:09:10 启动，启动头 `[inject-env] … generation=18 source=persisted`，配置中已含 `input`。

| 断言 | 结果 | 证据 |
|------|------|------|
| ① catalog `Input = text+image` | **PASS** | 启动时即已载入 |
| ② user message 含 `image` 块 | **PASS** | 会话 `aa3bd0a7-…jsonl`：`role=user [text(241), IMAGE(image/jpeg, 143068)]` |
| ③ 无 offload 标记（模型不再需要该路径） | **PASS** | 图片以 image 块交付，模型无需读路径 |
| ④ 无 exec OCR | **PASS** | **工具调用 0 次**；整轮 14:11:03→14:11:06（~3.4s）；回答逐字读出截图内容（含引用块与「截图里被截断了」） |

##### 第三轮：pod02 双复核（`muad-oc-pod02-76c86b8477-pscvk`，另一用户 `michael-a456d0f5`）

两次发图（23677 B、239159 B）**均** `[text, IMAGE]`；其中一次用户回发的是 agent 自己上一条回复的截图，agent 准确识别出「引用块 / 内容由 AI 生成标注 / 👍👎 反馈按钮」，**工具调用 0 次**。

> pod02 另外做了对照实验：**移除** `agents.defaults.imageModel` 后图片块依然存在 → 证明 `tools.media` / `imageModel` / OCR 固化**都不是必要条件**；仅 `input` 字段即可。
> （该实验同时确认：`agents.list[].imageModel` 会被 OpenClaw 配置 schema 拒绝 —— `Unrecognized key: "imageModel"`；只有 `agents.defaults.imageModel` 合法。这也是当时排除 per-agent 方案直接证据。）

##### 第四轮：Mattermost 通道复核（pod01，同一 agent）

用户经 **Mattermost IM 通道**发送图片截图（108205 B）。该轮会话含 `IMAGE` 块，agent 直接读出图中内容（Mattermost 进度通知截图）、**工具调用 0 次**。

pod01 当时的通道状态（实测）：`mattermost enabled=True` ／ `wecom enabled=True`；`bindings` 中该 agent 同时绑定 mattermost 与 wecom 两个通道。

**结论：本修复与通道无关。** 原因在架构位置 —— 决策点 `shouldForceImageOffload`（`attachment-normalize`）位于 **gateway 附件管线**，处在**各通道插件之下游**，因此凡能把附件交上来的通道都自动受益，**无需按通道逐个适配**。

| 通道 | pod | 结果 |
|------|-----|------|
| WeCom | pod01（重启后）×2、pod02 ×2 | ✅ 图片块内联 |
| Mattermost | pod01 ×1 | ✅ 图片块内联 |

##### 运维约束（本轮最重要的副产品）

**模型能力字段（`input`）经控制面变更后，仅靠配置热重载不足以让图片内联生效，必须重启 pod。**

它有极强误导性：控制台保存成功、日志打印 `config hot reload applied`、pod 内 `models list` 也显示 `text+image` —— 但图片仍以路径交付、模型拿不到像素。

| pod | 网关启动时配置已含 `input`？ | 发图结果 | 数据点 |
|---|---|---|---|
| pod01（重启前） | ❌（启动 13:30:24，字段 13:30:47 才热重载进来） | 2 次均无 image 块 | 2 |
| pod01（重启后） | ✅ | 有 image 块 | 1 |
| pod02 | ✅ | 有 image 块 | 2 |

**机制未查明**：曾提出「陈旧内存快照」与「热重载未刷新模型目录」两种解释，**均被代码证据推翻**（前者被 `[reload] config hot reload applied` 否掉；后者的门 `shouldRefreshContextWindowCache` 对 `models.*` 前缀恰好返回 true，即目录**确实**被刷新）。故此处只记录可复现的经验规律，不再声称机制。

##### 发布顺序结论（更新）

```
① console 镜像（含列/API/UI）→ ② worker(app) 镜像 → ③ apply → ④ **重启目标 pod** → 图片才真正内联
```

原 §2.3 写的「console 先行」依然成立（防旧 worker 拒绝未知 key）；但**第 ④ 步是本次实测新增的必需步骤**，已记为 RISK-B05。

### 决策与裁定记录

- **[已解决] 原「本需求前提被实测推翻」的判断有误，此处更正**：第一轮 FAILED 时曾判定"WeCom 图片根本不进 gateway attachment 管线，故 `input` 修复无效"，据此写了一条范围重议的 NOTES。第二轮起（pod01 重启后、pod02）**证伪了该判断** —— 图片**确实**走 attachment 管线并被内联，`input` 修复有效。当时误判的原因是把"热重载未生效"当成了"机制不适用"。
- **[未决 — 需用户裁定] 是否让控制面在能力类变更时自动重启**：当前由**人工重启**（用户 2026-09-22 明确选择手动）。风险是每个用户勾选后都要人工重启一次，且该坑隐蔽（见 RISK-B05）。
- **[未决] `MANUAL-F01` 的真实浏览器证据**：用户已在真实 console（本地 dev）完成勾选并保存成功（可观测结果：provider 的 `input` 字段被置位，pod01/pod02 均如此），但**列表「文本+图片」Tag 的浏览器内渲染**未单独取证 —— 该渲染由组件测试 S-12 覆盖。
## 未决项（启动前必须闭合）

| # | 项 | 归属 | 状态 |
|---|----|------|------|
| 1 | RISK-B02 归类为 `manual` | TASK-009 | ✅ 已确认（user:jahan, 2026-09-22） |
| 2 | RISK-F03 归类为 `manual` | TASK-008 | ✅ 已确认（user:jahan, 2026-09-22） |
| 3 | S-03 + MANUAL-F01 的真实环境验收 | TASK-009 | ✅ 已闭合 —— S-03 PASS（pod01 重启后 + pod02 双复核 + Mattermost 复核）；MANUAL-F01 verified（用户确认） |
| 4 | 各 TASK 的测试文件名 | 全部 | ✅ 已闭合 —— 编码期定稿：`console/backend/internal/repo/llm_model_migrate_test.go`、`console/backend/internal/runtimeconfig/supports_images_test.go`、`console/backend/test/llm_model_image_input_test.go`、`bin/test/runtime-config-schema.test.mjs`、`test/i18n.test.ts`（并扩展 `bin/test/inject-multi-user-config.test.mjs`、`test/LLM.test.tsx`） |

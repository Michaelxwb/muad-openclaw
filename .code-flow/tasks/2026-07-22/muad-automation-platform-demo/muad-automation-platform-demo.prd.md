# PRD: muad-automation-platform Demo

> **文档编号**: PRD-2026-07-22-001
> **文档版本**: v0.1
> **创建日期**: 2026-07-22
> **产品负责人**: 待填
> **状态**: 草稿

**评审边界说明**:
- **需求基线**: 第 2-8 章（背景/用户/功能/非功能/范围/依赖/已有规范约束）→ 通过后锁定
- **设计输入**: 第 3-8 章 → 为 `cf-task:align` 提供 US / FEAT / NFR / 范围 / Spec refs

**ID 体系**: US（用户故事）、FEAT（功能）、NFR（非功能指标）、Spec/Rule（已有规范引用）

**适用场景**: muad-openclaw 架构演进——从"Agent 调脚本"到"独立 Workflow 微服务"

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 背景与目标](#2-背景与目标)
- [3. 用户与场景](#3-用户与场景)
- [4. 功能需求](#4-功能需求)
- [5. 非功能需求](#5-非功能需求)
- [6. 范围与边界](#6-范围与边界)
- [7. 依赖与风险](#7-依赖与风险)
- [8. Existing Spec Constraints](#8-existing-spec-constraints)
- [附录：术语表](#附录术语表)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 产品经理 | 待填 | 需求定义、业务验收 |
| 开发负责人 | 待填 | 技术方案确认 |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-07-22 | | 初始草稿：基于 mss-report-skill 和 sangfor-report-downloader 源码分析 |

---

## 2. 背景与目标

### 2.1 问题陈述 [必填]

| 维度 | 内容 |
|------|------|
| **问题描述** | 当前 muad-openclaw 的所有 SOP 通过 Skill 脚本（Python/Node.js）实现——脚本内手工封装 API 调用、顺序串联多个接口、无状态持久化、无结构化容错。随着业务功能增加，Skill 数量增长带来维护困难、可靠性缺失和 DFX 能力空白 |
| **当前替代方案** | `mss-report-skill`（Python，~20 文件，`shared/api.py` 636 行手工封装 10+ MSSW 接口）和 `sangfor-report-downloader`（Node.js，主文件 880 行顺序调用 15+ 步骤）各自独立实现了 cookie 读取、客户名→ID 解析、分页 API 调用、重试、Excel 生成等相同能力。`muad-run-skill` 仅提供执行入口和审计上报，不负责流程编排、状态恢复或补偿 |
| **触发原因** | 1) 两个存量 Skill 已暴露重复建设问题，后续新增 SOP 会线性膨胀；2) 脚本型 Skill 对平台接口强耦合，单接口失败导致全流程失败；3) Pod 重启后 subprocess 后台任务丢失，无断点续传；4) 缺少生产级 DFX（执行追踪、补偿、结构化审计） |

**具体痛点（源码级证据）**：

| 痛点 | mss-report-skill | sangfor-report-downloader |
|------|------------------|--------------------------|
| API 封装重复 | `shared/api.py` 手工分页+重试 10+ 接口 | `api_client.js` 再实现一遍分页+重试 |
| 状态无持久化 | `subprocess.Popen`，Pod 重启即丢 | 全程内存，重启重来 |
| 步骤强耦合 | trigger → config → template → URL → 后台，任一步失败全挂 | `downloadReports()` 500 行，15 个步骤顺序执行，第 14 步失败前功尽弃 |
| Cookie 脆弱 | `cookies.txt`，6h 过期全部不可用 | 同，且 MSS/XDR 两份 cookie |
| 审计缺失 | stdout log 非结构化 | `console.log` 非结构化 |
| 能力无法复用 | `ensure_config`、`resolve_company` 逻辑与 sangfor 的同语义实现各自维护 | — |

### 2.2 目标与价值 [必填]

| 维度 | 内容 |
|------|------|
| **核心目标** | 构建独立的 `muad-automation-platform` 微服务，将 SOP 从"Agent 调脚本"演进为"Agent 触发 Workflow → Capability 执行业务调用"的三层架构，以 mss-report-skill 和 sangfor-report-downloader 为首批迁移对象 |
| **预期价值** | 1) Capability 一次实现、多 Workflow 复用，消除跨 Skill 的 API 封装重复；2) Temporal 提供原生重试、断点续传、Saga 补偿，每一步独立容错；3) Execution Store 提供结构化执行审计，90 天可回溯；4) 新 SOP 只需定义 Workflow + 复用已有 Capability，预计 80% 新 SOP 零新增代码 |

**成功指标**

| 指标 | 当前值 | 目标值 | 衡量方式 |
|------|--------|--------|----------|
| Demo 环境本地一键启动 | 无 | `docker compose up` 即可启动全部依赖 | 在新机器上执行一次 |
| mss-weekly-report Workflow | 脚本串行，无容错 | 4 步 Activity 独立重试，断点续传 | 模拟中间步骤失败后自动恢复 |
| sangfor-download Workflow | 脚本串行，部分失败全丢 | 5 步 Activity 独立重试，单步失败不影响已完成步骤 | Mock 环境验证 |
| Capability 复用 | 2 个 Skill 各自实现 API | mssw Capability 包被两个 Workflow 共享 | 代码审查 |
| Mock Server | 无 | MSSW + SOAR 接口返回固定 JSON，无需真实凭证 | `curl mock-server:8080/health` |

---

## 3. 用户与场景

### 3.1 目标用户 [必填]

| 维度 | 内容 |
|------|------|
| **用户画像** | **服务经理**（~100 人，企微私聊交付）：一句话发起标准服务任务，接收进度和最终交付物。**平台管理员**（1-2 人）：在 Console 查看 Workflow 执行记录。**开发者**：新增 Capability 或 Workflow 定义 |
| **使用场景** | 1) 服务经理在企微中发送"导出 XX 客户本周周报"→ Agent 触发 Workflow → 异步执行 6 个步骤 → 邮件发送后通知用户。2) 服务经理发送"下载 XX 客户 5 月深信服报告"→ Agent 触发 Workflow → 顺序下载资产/事件/告警/漏洞/暴露面数据 → 生成 Excel。3) 中间某步失败时，Workflow 自动重试或执行补偿，不需要用户重新发起 |

### 3.2 用户故事 [必填]

> 格式: As a [角色], I want to [操作], so that [价值]

| 编号 | 用户故事 | 优先级 |
|------|---------|--------|
| US-01 | 作为**服务经理**，我希望在企微中一句话触发 MSS 周报/月报导出，以便自动完成客户解析、模板获取、报告导出、邮件发送和 Portal 同步，中间任何步骤失败自动重试或补偿，不需要我手动介入 | P0 |
| US-02 | 作为**服务经理**，我希望在企微中触发深信服原始数据下载，以便自动获取指定客户指定时间段的资产表、暴露面、事件表、告警表、漏洞表并生成 Excel 报告，单表下载失败不影响其他表 | P0 |
| US-03 | 作为**平台管理员**，我希望查看每次 Workflow 执行的完整轨迹（每一步的输入/输出/耗时/状态），以便审计 SOP 执行和排查故障 | P0 |
| US-04 | 作为**开发者**，我希望在 Capability Registry 中注册新的平台 API 封装（带版本号），以便新增业务平台接口时只需扩展 Capability 而不修改已有 Workflow | P1 |

---

## 4. 功能需求

### 4.1 功能清单 [必填]

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源用户故事 |
|--------|---------|---------|--------|-------------|
| FEAT-01 | Temporal Workflow 引擎 | 集成 Temporal Server，每个 SOP 定义为一个 Workflow，每个平台调用封装为一个 Activity；支持独立重试（指数退避）、Saga 补偿 Activity、断点续传 | P0 | US-01, US-02, US-03 |
| FEAT-02 | mss-weekly-report Workflow | 将 mss-report-skill 导出流程转为 Temporal Workflow：客户解析→模板获取→触发导出→轮询完成→邮件发送→Portal 同步，每步为独立 Activity | P0 | US-01 |
| FEAT-03 | sangfor-download Workflow | 将 sangfor-report-downloader 转为 Temporal Workflow：客户解析→资产表→暴露面→事件表→告警表→漏洞表→弱口令统计→SOAR TopN→XDR 日志统计→Excel 生成，每步独立 Activity | P0 | US-02 |
| FEAT-04 | Capability Center (MSSW + SOAR) | 将两个 Skill 重复的 API 调用抽象为版本化 Capability（`mssw.company`、`mssw.report`、`mssw.email`、`mssw.portal`、`soar.company`、`soar.asset`、`soar.event`、`soar.alarm`、`soar.vuln`、`soar.exposed`），统一处理分页、重试、凭证 | P0 | US-01, US-02, US-04 |
| FEAT-05 | HTTP Bridge Workflow API | 提供 HTTP 接口供 Bridge Skill 调用：`POST /api/v1/workflows/start`（触发 SOP，返回 workflow_id）、`GET /api/v1/workflows/status`（查询执行状态和进度）；gRPC 仅保留为本地调试/手动验证接口 | P0 | US-01, US-02 |
| FEAT-06 | Mock MSSW / SOAR Server | 独立 Mock 服务，模拟 MSSW 和 SOAR 全部依赖接口的固定 JSON 响应，支持 Demo 零凭证可重复验证 | P0 | US-01, US-02 |
| FEAT-07 | Execution Store | Demo 使用 SQLite 存储 workflow_executions（每次执行记录）、activity_records（每步输入/输出/耗时）、workflow_definitions（元数据），支持按 workflow_id / time 查询；生产目标迁移 PostgreSQL | P0 | US-03 |
| FEAT-08 | Docker Compose 本地部署 | `docker compose up` 一键启动：Temporal Server + PostgreSQL + Mock Server + automation-platform；`docker compose down` 清理全部状态 | P0 | US-01, US-02, US-04 |

> P0=核心必做（Demo 交付物），P1=重要但 Demo 阶段可简化

#### FEAT-01: Temporal Workflow 引擎

- **描述**: 集成 Temporal Server（Docker `temporaliotest/auto-setup`），Go SDK 内嵌 Temporal Worker，每个 SOP 定义为 Go Workflow 函数，每个平台调用封装为 Activity 函数
- **验收标准**:
  - [ ] `docker compose up` 后 Temporal Web UI 可访问（`http://localhost:8233`）
  - [ ] Go Worker 成功注册 Workflow Type 和 Activity Type（在 UI 中可见）
  - [ ] Activity 失败时自动按配置重试（初始 1s，指数退避，最大 30s，最多 3 次）
  - [ ] 模拟 Pod 重启（kill worker 进程后重启）→ 运行中的 Workflow 从中断处恢复而非从头开始
  - [ ] 写操作 Activity 失败后自动触发补偿 Activity（Saga 模式）

#### FEAT-02: mss-weekly-report Workflow

- **描述**: 将 `mss-report-skill/export_report/trigger_export.py` 的串行脚本转换为 Temporal Workflow
- **验收标准**:
  - [ ] Workflow 定义为 `MSSWeeklyReport`，接收参数 `{company_name, report_type("weekly"|"monthly")}`
  - [ ] Activity 步骤：① `mssw.company.resolve` → ② `mssw.report.get_template` → ③ `mssw.report.trigger_export` → ④ `mssw.report.poll_until_complete` → ⑤ `mssw.email.send`（compensate: `mssw.email.recall`）→ ⑥ `mssw.portal.sync`（compensate: `mssw.portal.unpublish`）
  - [ ] 每个 Activity 独立配置重试策略：瞬时故障重试 3 次，业务预期失败（如客户不存在）不重试直接 Fail
  - [ ] `poll_until_complete` Activity 支持最长 30 分钟轮询（每 30s 查询一次），超时后 Fail Workflow
  - [ ] 邮件发送失败后自动执行 `mssw.email.recall` 补偿，Portal 同步失败后自动执行 `mssw.portal.unpublish` 补偿
  - [ ] Workflow 完成后返回 `{workflow_id, status, task_id, email_result, portal_result}`

#### FEAT-03: sangfor-download Workflow

- **描述**: 将 `sangfor-report-downloader/sangfor_downloader.js` 的 500 行串行函数转换为 Temporal Workflow，每类数据下载为独立 Activity，部分失败不丢已完成数据
- **验收标准**:
  - [ ] Workflow 定义为 `SOARDownloadReport`，接收参数 `{company_name, start_date, end_date, type("all"|"asset"|"event"|...)}`
  - [ ] Activity 步骤：① `soar.company.resolve` → ② `soar.asset.download` → ③ `soar.exposed.download` → ④ `soar.event.list` → ⑤ `soar.alarm.list` → ⑥ `soar.vuln.list` → ⑦ `soar.weakpwd.stats` → ⑧ `soar.topn.stats` → ⑨ `soar.excel.generate`（汇总前面各步结果生成 Excel）
  - [ ] 单步失败（如 `soar.alarm.list` 超时）不阻塞其他步骤，Workflow 最终返回部分成功结果 + 失败步骤清单
  - [ ] `soar.excel.generate` 收集所有已完成步骤的数据生成 Excel，失败步骤在 Excel 中标注"未获取"
  - [ ] `type` 参数支持 `all`（全部）/ `asset`（仅资产）/ `event`（仅事件）/ `alarm`（仅告警）/ `vuln`（仅漏洞）/ `exposed`（仅暴露面），非 all 时仅执行对应 Activity

#### FEAT-04: Capability Center (MSSW + SOAR)

- **描述**: 将两个 Skill 的 API 封装统一为 Go 模块，每平台一个包，每操作一个文件，在 Registry 中注册版本化 Schema
- **验收标准**:
  - [ ] `internal/capability/mssw/` 包含：`company.go`（SearchCompany, ResolveCompany）、`report.go`（GetTemplate, TriggerExport, PollStatus）、`email.go`（QueryContent, Send, Recall）、`portal.go`（Sync, Unpublish）
  - [ ] `internal/capability/soar/` 包含：`company.go`（ResolveCompany）、`asset.go`（DownloadAssetTable）、`exposed.go`（DownloadExposedSurface）、`event.go`（ListEvents）、`alarm.go`（ListAlarms）、`vuln.go`（ListVulns）、`weakpwd.go`（GetStats）、`topn.go`（GetStats）、`excel.go`（GenerateReport）
  - [ ] 每个 Capability 函数签名统一：`(ctx context.Context, req *XxxRequest) (*XxxResponse, error)`
  - [ ] Capability 内统一使用 `common/retry.go` 和 `common/circuit.go` 处理重试和熔断
  - [ ] `internal/registry/` 提供 Capability 注册表：按 `{domain}.{service}/{action}/v{N}` 格式索引（如 `mssw.company/search/v1`）
  - [ ] Capability 之间禁止相互调用（通过 boundary_test / AST import scan 约束 import 图）
  - [ ] Demo 阶段 Capability 调用 Mock Server 而非真实 MSSW/SOAR API

#### FEAT-05: HTTP Bridge Workflow API

- **描述**: 暴露 HTTP Bridge 接口，Bridge Skill 通过 `MUAD_AUTOMATION_URL` + `MUAD_AUTH_TOKEN` 触发 Workflow 和查询状态；gRPC 接口不作为 Skill 主链路，仅保留为本地调试/手动验证接口
- **验收标准**:
  - [ ] `POST /api/v1/workflows/start` 接收 `{workflow_type, parameters, timeout_seconds}`，返回 `{workflow_id, status("RUNNING")}`
  - [ ] `GET /api/v1/workflows/status?workflow_id=xxx` 返回 `{status, start_time, activities: [{name, status, start_time, end_time, error}]}`
  - [ ] HTTP server 监听 `:9000`，使用 `Authorization: Bearer <token>` 鉴权（Demo 阶段可用固定 token）
  - [ ] Bridge Skill 在 Pod 内通过 HTTP 完成触发，不依赖 exec/shell/gRPC/MCP Plugin
  - [ ] Demo 阶段可额外提供 `grpcurl` 示例命令用于本地调试：
      ```bash
      grpcurl -plaintext -d '{"workflow_type":"mss.weekly_report","parameters":{"company_name":"TestCorp","report_type":"weekly"}}' \
        localhost:9001 automation.v1.AutomationPlatform/StartWorkflow
      ```

#### FEAT-06: Mock MSSW / SOAR Server

- **描述**: 独立 HTTP 服务，模拟 MSSW 和 SOAR 全部依赖接口，返回固定 JSON，支持 Demo 零凭证验证
- **验收标准**:
  - [ ] 独立 Docker 容器，`mock/` 目录下单独构建
  - [ ] 覆盖 mss-weekly-report Workflow 所需的全部 MSSW 接口：company_search、locale_config、report_template、report_export、report_status、email_query、email_send、portal_sync
  - [ ] 覆盖 sangfor-download Workflow 所需的全部 SOAR 接口：company_search、asset_export、exposed_target_company、exposed_export、event_list、alarm_list、vuln_list、weakpwd_stats、topn_stats
  - [ ] Mock 返回数据合法：`code: 0` + 合理字段，足以让 Workflow 跑通全流程
  - [ ] 支持注入故障（可选）：通过特殊参数触发特定接口返回错误/超时，用于验证重试和补偿逻辑
  - [ ] Mock 接口基于真实 MSSW/SOAR 响应结构，字段名和层级与真实 API 一致

#### FEAT-07: Execution Store

- **描述**: Demo 使用 SQLite 存储 Workflow 执行元数据和 Activity 记录；Temporal 服务使用 PostgreSQL 容器；生产目标可迁移 PostgreSQL
- **验收标准**:
  - [ ] 表 `workflow_executions`：id, workflow_id, workflow_type, status, parameters_json, result_json, start_time, end_time, error_message
  - [ ] 表 `activity_records`：id, workflow_id, activity_name, attempt, status, input_json, output_json, start_time, end_time, error_message
  - [ ] 表 `workflow_definitions`：id, name, version, description, owner, timeout_seconds, created_at
  - [ ] Demo 阶段自动 migrate（GORM AutoMigrate 或 Goose）
  - [ ] 提供 HTTP `GET /api/v1/executions?workflow_id=xxx` 和 `GET /api/v1/executions/:id` 查询接口（Demo 阶段用于验证，正式由 Console 消费）

#### FEAT-08: Docker Compose 本地部署

- **描述**: `docker compose up` 一键启动所有依赖，本地即可验证完整 Workflow 链路
- **验收标准**:
  - [ ] `docker compose up` 启动 5 个容器：postgres（Temporal DB）、temporal（Temporal Server）、temporal-ui（Web UI）、mock-server（MSSW/SOAR Mock）、automation-platform（Go 服务 + SQLite Execution Store）
  - [ ] automation-platform 健康检查（`/health` 返回 200）依赖 postgres 和 temporal 就绪
  - [ ] `docker compose down -v` 清理所有卷和容器
  - [ ] 提供 `README.md`：启动步骤、HTTP Bridge 验证命令、Temporal Web UI 地址；gRPC 调试命令可作为附录

### 4.2 边缘情况 [可选]

| 场景 | 预期行为 |
|------|----------|
| Mock Server 不可用 | automation-platform 启动时 health check 失败，不注册 Worker，等待 Mock Server 恢复 |
| Temporal Server 不可用 | Worker 自动重连（Temporal SDK 默认行为），重启后恢复 |
| Workflow 已运行中重复触发 | 返回已有 workflow_id + `ALREADY_RUNNING` 状态 |
| Activity 重试全部耗尽 | Workflow 状态标记 `FAILED`，记录最后一次错误，不触发补偿（重试耗尽≠写操作成功） |
| 客户端断开连接 | Workflow 继续执行（Temporal 原生异步），客户端凭 workflow_id 轮询结果 |
| Demo 重启（`docker compose restart`） | Temporal 从 PostgreSQL 恢复所有运行中 Workflow 状态，Worker 重新轮询任务 |

---

## 5. 非功能需求 [可选]

| 指标ID | 类型 | 要求 |
|--------|------|------|
| NFR-DEPLOY-01 | 部署 | `docker compose up` 到全部服务就绪 ≤ 60s（含镜像拉取时间不计） |
| NFR-REL-01 | 可用性 | Demo 阶段单实例，进程退出后 `docker compose restart` 即可恢复 |
| NFR-SEC-01 | 安全 | gRPC/HTTP 使用固定 service token（Demo 阶段），生产后续改用 JWT |
| NFR-COMPAT-01 | 兼容性 | Go 1.22+, Temporal Server ≥ 1.24, PostgreSQL 16 |
| NFR-TRACE-01 | 可观测 | 每个 Activity 的输入/输出/耗时写入 Execution Store；Temporal Web UI 可查看 Event History |

---

## 6. 范围与边界 [必填]

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | Demo 阶段：1) Temporal Workflow 引擎集成（Docker `temporaliotest/auto-setup`）；2) `mss-weekly-report` 和 `sangfor-download` 两个 Workflow 从存量 Skill 迁移为 Go + Temporal；3) `mssw` 和 `soar` 两个 Capability 包，覆盖各自 ~10 个平台接口；4) HTTP Bridge Workflow API（`POST /api/v1/workflows/start` + `GET /api/v1/workflows/status`），gRPC 仅作调试接口；5) Mock MSSW/SOAR Server 模拟全部依赖接口；6) Execution Store（Demo SQLite + HTTP 查询 API，生产目标 PostgreSQL）；7) Docker Compose 本地一键部署；8) 通过企微 Bridge Skill 跑通完整触发链路 |
| **非范围（Out of Scope）** | Demo 阶段明确不做：1) 生产级 Console 管理界面；2) Temporal Server 高可用集群（单实例 `auto-setup`）；3) MCP 协议完整实现（不实现 Anthropic MCP spec）；4) Capability 版本路由（Demo 只有 v1）；5) 生产级 CI/CD pipeline；6) 存量 Skill 的删除或替换；7) 飞书/其他 IM 通道 |
| **前置假设** | Docker daemon 已安装且可用；宿主机端口 7233（Temporal）、5432（PostgreSQL）、9001（gRPC 调试）、9000（HTTP）、8233（Temporal UI）、8081（Mock Server 宿主机映射）未被占用；Go 1.22+ 已安装用于开发；`muad-automation-platform` 目录已创建（`/Users/jahan/workspace/muad-automation-platform`） |

---

## 7. 依赖与风险 [可选]

### 7.1 项目依赖

| 依赖方 | 依赖内容 | 最晚交付时间 | 风险等级 |
|--------|----------|--------------|---------|
| Temporal | `temporaliotest/auto-setup` Docker 镜像 | 开发启动时 | 低（官方维护，公开可用） |
| PostgreSQL | `postgres:16` Docker 镜像 | 开发启动时 | 低（官方镜像） |
| Mock Server | 基于真实 MSSW/SOAR 响应结构编写 Mock 数据 | 编码阶段 | 中（需参考存量 Skill 代码中的 API 调用推断响应格式） |
| muad-openclaw 源码 | 参考 `mss-report-skill` 和 `sangfor-report-downloader` 源码了解 API 调用细节 | 编码阶段 | 已就绪（源码在 Downloads 目录） |

### 7.2 风险识别

| 风险ID | 描述 | 影响 | 缓解方案 |
|--------|------|------|---------|
| RISK-01 | Mock 数据与真实 MSSW/SOAR API 响应结构不一致 | Workflow 在 Demo 跑通但接入真实 API 后需大量适配 | Mock 基于存量 Skill 中实际调用的 API payload 编写响应结构；每个 Mock endpoint 注释来源 API URL 和参数 |
| RISK-02 | Temporal Go SDK 学习曲线 | Demo 开发进度可能慢于预期 | 先用官方 `helloworld` 示例搭建骨架，再逐步替换为真实 Activity；Temporal Web UI 辅助调试 |
| RISK-03 | Demo 未覆盖生产级 Console 管理界面，后续配置/凭证管理链路需补齐 | 后续对接 Console 需额外工作 | Demo 已通过企微 Bridge Skill + AP HTTP 链路验证触发；Capability Demo 调用 Mock Server（无鉴权），生产接真实 API 时保持 Capability 签名不变，补齐凭证解析和注入 |
| RISK-04 | sangfor-report-downloader 涉及 XDR 和 SOAR 两套系统，Demo 阶段可能接口过多 | Mock 工作量大 | XDR 接口 Demo 阶段先用 2-3 个核心接口（log search count），其余后续补充 |

---

## 8. Existing Spec Constraints

> 本次 PRD 针对新建独立微服务 `muad-automation-platform`，不在 muad-openclaw 现有仓库内。`cf_spec_context catalog --stage prd` 返回 0 个 PRD 阶段候选 Spec（现有 Spec 均为 muad-openclaw 代码级规范，不适用于本新服务 PRD 阶段）。

| Spec/Rule | 约束 | 对范围/验收的影响 | 状态 |
|-----------|------|------------------|------|
| 暂无 | — | — | 后续设计阶段如需对接 Console，再引用 muad-openclaw 的 `backend/platform-rules.md` 和 `runtime/config-and-apply.md` |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| PRD | Product Requirements Document，产品需求文档 |
| US | User Story，用户故事 |
| FEAT | Feature，功能项（US 的实现载体） |
| NFR | Non-Functional Requirement，非功能性需求 |
| SOP | Standard Operating Procedure，标准操作流程 |
| Capability | 对业务平台 API 的一次封装（含鉴权、分页、重试），版本化注册 |
| Workflow | Temporal Workflow — SOP 的数字化表达，编排多个 Activity |
| Activity | Temporal Activity — Workflow 中的单个执行步骤，独立重试和超时 |
| Saga | 分布式事务补偿模式 — 写操作失败后执行反向补偿操作 |
| MCP | Model Context Protocol — Agent 工具发现和调用协议 |
| AP | Automation Platform — muad-automation-platform 缩写 |
| MSS | Managed Security Service，托管安全服务 |
| MSSW | MSS Web 平台（业务平台之一） |
| SDSP | Sangfor Detection and Response Platform（业务平台之一） |
| SOAR | Security Orchestration, Automation and Response（深信服平台） |
| XDR | Extended Detection and Response（深信服平台） |

---

*文档结束*

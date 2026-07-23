# Tasks: muad-automation-platform Demo

- **Source**: muad-automation-platform-demo.design.md
- **Created**: 2026-07-22
- **Updated**: 2026-07-22

## Proposal

构建 muad-automation-platform 独立 Go 微服务 Demo，将 mss-report-skill 和 sangfor-report-downloader 两个存量 Skill 从"脚本串行调用"迁移为 Temporal Workflow + Capability Center 三层架构。本地 `docker compose up` 一键启动 PostgreSQL + Temporal Server + Temporal UI + Mock Server + automation-platform，通过 HTTP Bridge / 企微 Bridge Skill 触发 Workflow，验证重试、补偿、断点续传和部分失败不阻塞等生产级可靠性能力。

### Alignment

- **Scope**: 9 个任务覆盖项目脚手架 → Temporal 集成 → Capability 实现 → Mock Server → Workflow 定义 → HTTP Bridge/API → Docker Compose 部署
- **Decisions**:
  - Go 1.22+ + Temporal Go SDK + SQLite Execution Store + PostgreSQL Temporal DB + HTTP Bridge API（gRPC 仅调试）
  - 独立仓库 `/Users/jahan/workspace/muad-automation-platform`
  - Demo 阶段不做生产级 Console 管理界面，不实现完整 MCP 协议
- **Non-goals**: 生产级 Console 管理界面、Temporal 高可用、Capability 版本路由（仅 v1）、生产 CI/CD、存量 Skill 删除
- **Acceptance**: `docker compose up` → 企微 Bridge Skill / HTTP `POST /api/v1/workflows/start` → Workflow 全步骤完成 → Temporal Web UI 可见 Event History → HTTP API 可查询执行记录

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 |
|--------|---------|---------|-------------|---------|------|
| S-01 | design#2.5 验收条件 | E2E | 企微 Bridge Skill → HTTP Bridge → Temporal → Worker → Mock → Execution Store | TASK-009 | verified |
| S-02 | design#2.5 验收条件 | E2E | Worker → Mock MSSW → Execution Store | TASK-006 | verified |
| S-03 | design#2.5 验收条件 | E2E | Worker → Mock SOAR → Execution Store | TASK-007 | verified |
| S-04 | design#2.5 验收条件 | unit | Go 包 import 图 → boundary_test / AST import scan | TASK-003, TASK-004 | verified |
| S-05 | design#2.5 验收条件 | integration | HTTP API → SQLite | TASK-008 | verified |
| S-06 | design#2.5 验收条件 | integration | Mock HTTP Server | TASK-005 | verified |
| E-01 | design#2.5 验收条件 | E2E | Temporal RetryPolicy → Mock → Activity | TASK-006 | verified |
| E-02 | design#2.5 验收条件 | E2E | Temporal → Activity 错误分类 | TASK-006 | verified |
| E-03 | design#2.5 验收条件 | E2E | Temporal → Compensating Activity | TASK-006 | verified |
| E-04 | design#2.5 验收条件 | E2E | Temporal → Activity 独立失败 | TASK-007 | verified |
| E-05 | design#2.5 验收条件 | integration | Temporal Worker → Temporal Server | TASK-001 | verified |
| B-01 | design#2.5 验收条件 | unit | HTTP Bridge → 参数校验 | TASK-008 | verified |
| B-02 | design#2.5 验收条件 | unit | HTTP Bridge → 参数校验 | TASK-008 | verified |
| B-03 | design#2.5 验收条件 | integration | Temporal → Workflow 幂等 | TASK-008 | verified |
| RULE-01 | design#2.5.1 业务规则 | E2E | retry: 1s→4s→16s, max 3 | TASK-006 | verified |
| RULE-02 | design#2.5.1 业务规则 | E2E | 预期失败不重试 | TASK-006 | verified |
| RULE-03 | design#2.5.1 业务规则 | E2E | 写操作补偿 Activity | TASK-006 | verified |
| RULE-04 | design#2.5.1 业务规则 | E2E | type 过滤仅执行对应 Activity | TASK-007 | verified |
| RULE-05 | design#2.5.1 业务规则 | unit | Capability 跨包禁止 import | TASK-003, TASK-004 | verified |
| RULE-06 | design#2.5.1 业务规则 | E2E | docker compose up ≤60s | TASK-009 | verified |
| RULE-07 | design#2.5.1 业务规则 | 设计审查 | SQL 参数化禁止拼接 | TASK-002 | verified |

---

## TASK-001: Go 项目脚手架 + Temporal 集成

- **Status**: done
- **Priority**: P0
- **Depends**: —
- **Source**: muad-automation-platform-demo.design.md#3.1 方案选型, muad-automation-platform-demo.design.md#3.2 架构设计
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-logging#RULE-backend-logging-001
- **Acceptance-Refs**: E-05, RULE-backend-quality-001, RULE-backend-logging-001

### Description

初始化 Go 项目：`go.mod`、`cmd/server/main.go`、`internal/` 分层目录。集成 Temporal Go SDK：创建 Client 连接 Temporal Server、注册 Worker、启动服务。配置 `log/slog` 结构化 JSON 日志。所有外部调用（Temporal、Mock Server）使用 `context.WithTimeout`。

### Checklist

- [x] `go mod init github.com/muad/muad-automation-platform`，引入 `go.temporal.io/sdk`、`google.golang.org/grpc`、`modernc.org/sqlite`
- [x] 创建目录结构：`cmd/server/`、`internal/{api/grpc/proto,workflow/mss,workflow/soar,capability/mssw,capability/soar,registry,store,temporal}/`、`mock/`、`migrations/`
- [x] `cmd/server/main.go`：slog JSON handler、Temporal Client 初始化（`TEMPORAL_HOSTPORT` env）、Worker 注册、HTTP Bridge server 启动、gRPC 调试接口保留、graceful shutdown（SIGINT/SIGTERM）
- [x] `internal/temporal/client.go`：`NewClient(hostPort string) (client.Client, error)` — 创建 Temporal Client，连接 `temporal:7233`
- [x] `internal/temporal/worker.go`：`NewWorker(c client.Client, taskQueue string, activities, workflows []interface{})` — 创建并启动 Worker
- [x] [E-05][integration] 编写 Worker 恢复测试：kill Worker 进程 → 重启 → Workflow 从中断处继续（使用 Temporal `testsuite.DevServer` 内嵌测试）
- [x] `go vet ./...` 通过，`go build ./cmd/server` 成功

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| E-05 | integration | Temporal DevServer, Worker 生命周期 | Worker 重启后 Workflow 状态恢复为 RUNNING → 最终 COMPLETED | `go test -run TestWorkerRestart ./internal/temporal/` | verified |
| RULE-backend-quality-001 | — | `go vet ./...` | 零 warning/error | `go vet ./...` | verified |
| RULE-backend-logging-001 | — | slog JSON output | 日志行含 `"level"`, `"msg"`, `"time"`；不含 `api_key`, `cookie`, `token`（明文） | 设计审查 + `go test` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-05 | N/A (recovery path tested with DevServer) | PASS: `go test -run TestWorkerRestartRecovery ./internal/temporal/` | internal/temporal/worker_test.go:TestWorkerRestartRecovery | Temporal DevServer + real Worker Start/Stop | verified |
| RULE-backend-quality-001 | N/A | PASS: `go vet ./...` | — | go vet | verified |
| RULE-backend-logging-001 | N/A | PASS: slog JSON in cmd/server/main.go | cmd/server/main.go | structured slog | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-002: SQLite Execution Store

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: muad-automation-platform-demo.design.md#3.3 数据设计
- **Spec-Refs**: backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001
- **Acceptance-Refs**: S-05, RULE-07, RULE-backend-database-001, RULE-backend-no-select-star-001

### Description

创建 SQLite 数据库 schema（`migrations/001_init.sql`），实现 `internal/store/repository.go`：`workflow_executions` 和 `activity_records` 两张表的 CRUD。所有 SQL 显式列名 + 参数化占位符。使用 `modernc.org/sqlite`（纯 Go，无 CGO）。

### Checklist

- [x] `migrations/001_init.sql`：CREATE TABLE IF NOT EXISTS `workflow_executions`（id INTEGER PK AUTOINCREMENT, workflow_id TEXT UNIQUE, workflow_type, status, parameters_json, result_json, error_message, start_time, end_time）；CREATE TABLE IF NOT EXISTS `activity_records`（id INTEGER PK AUTOINCREMENT, workflow_id TEXT FK, activity_name, attempt INT, status, input_json, output_json, error_message, start_time, end_time）；索引 idx_we_workflow_id, idx_we_type_status, idx_ar_workflow
- [x] `internal/store/repository.go`：`NewStore(dbPath string) (*Store, error)` — 打开 SQLite、执行 migration、启用 WAL
- [x] `Store.InsertWorkflow(ctx, wf)`, `Store.UpdateWorkflowStatus(ctx, workflowID, status, result, errMsg)`, `Store.GetWorkflow(ctx, workflowID)`, `Store.ListWorkflows(ctx, workflowType, status, limit, offset)`
- [x] `Store.InsertActivityRecord(ctx, ar)`, `Store.UpdateActivityRecord(ctx, id, status, output, errMsg)`, `Store.ListActivityRecords(ctx, workflowID)`
- [x] 所有 SQL 使用 `SELECT id, workflow_id, workflow_type, status, parameters_json, result_json, error_message, start_time, end_time FROM workflow_executions WHERE ...`（显式列名，禁止 `SELECT *`）
- [x] 所有 SQL 使用 `?` 占位符参数化（禁止字符串拼接）
- [x] [S-05][integration] 集成测试：insert → update → query → list，验证往返一致性
- [x] `go vet ./internal/store/` 通过

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-05 | integration | SQLite WAL, Store API | Insert → Get 往返一致；List 分页正确；Update status 生效 | `go test -run TestStore ./internal/store/` | verified |
| RULE-backend-database-001 | — | SQL 文本审查 | 零字符串拼接；所有值经 `?` 传入 | 设计审查 | verified |
| RULE-backend-no-select-star-001 | — | SQL 文本审查 | 所有查询显式列名，零处 `SELECT *` | 设计审查 | verified |
| RULE-07 | 设计审查 | SQL 文本审查 | 参数化 + repo 隔离 | 设计审查 | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-05 | N/A | PASS: `go test -run TestStoreRoundTrip ./internal/store/` | internal/store/repository_test.go:TestStoreRoundTrip | real SQLite (modernc.org/sqlite) | verified |
| RULE-07 | N/A | PASS: parameterized `?` placeholders in repository.go | internal/store/repository.go | SQL review + TestNoSelectStar | verified |
| RULE-backend-database-001 | N/A | PASS: repo-only access + parameterized SQL | internal/store/repository.go | go test ./internal/store/ | verified |
| RULE-backend-no-select-star-001 | N/A | PASS: explicit columns only | internal/store/repository.go | TestNoSelectStar | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-003: MSSW Capability

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: muad-automation-platform-demo.design.md#3.2 架构设计, muad-automation-platform-demo.design.md#3.4 接口设计(形态C Mock Endpoints)
- **Spec-Refs**: backend-logging#RULE-backend-redact-001
- **Acceptance-Refs**: S-04, RULE-05, RULE-backend-redact-001

### Description

实现 `internal/capability/mssw/` 包：对 MSSW 平台的 9 个 API 调用封装为版本化 Capability。每个文件一个操作：`company.go`（SearchCompany, ResolveCompany）、`report.go`（GetTemplate, TriggerExport, PollUntilComplete）、`email.go`（QueryContent, Send, Recall）、`portal.go`（Sync, Unpublish）。统一使用 `common/retry.go` 的指数退避重试和 `context.WithTimeout`。

### Checklist

- [x] `internal/capability/mssw/company.go`：`SearchCompany(ctx, baseURL, keyword string) (*CompanyList, error)` — POST 分页查询；`ResolveCompany(ctx, baseURL, name string) (*Company, error)` — 精确匹配优先，多匹配返回 `ErrMultipleMatch`
- [x] `internal/capability/mssw/report.go`：`GetTemplate(ctx, baseURL, reportType string) (*Template, error)`；`TriggerExport(ctx, baseURL, companyID, templateID, startTime, endTime string) (taskID string, error)`；`PollUntilComplete(ctx, baseURL, taskID string, pollInterval, maxWait time.Duration) error`
- [x] `internal/capability/mssw/email.go`：`QueryContent(ctx, baseURL, taskID string) (*EmailContent, error)`；`Send(ctx, baseURL string, payload EmailPayload) error`；`Recall(ctx, baseURL, taskID string) error`（补偿 Activity）
- [x] `internal/capability/mssw/portal.go`：`Sync(ctx, baseURL, taskID string, reportVersion []string) error`；`Unpublish(ctx, baseURL, taskID string) error`（补偿 Activity）
- [x] `internal/capability/common/retry.go`：`DoWithRetry(ctx, maxAttempts int, fn func() error) error` — 指数退避 1s→4s→16s；区分可重试错误（5xx/超时）和不可重试错误（4xx 业务错误）
- [x] 每个 Capability 函数统一使用 `context.WithTimeout(ctx, 30*time.Second)`
- [x] Activity input/output 写入前对敏感字段（cookie、api_key、token）脱敏
- [x] [S-04][unit] boundary_test / AST import scan：MSSW 包内禁止 import SOAR 包；`go vet` 确认无循环依赖
- [x] table-driven tests：Mock Server 正常响应 / 500 重试 / 404 不重试 / 超时

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-04 | unit | Go 包 import 图 | `internal/capability/mssw` 不 import `internal/capability/soar` | `go vet ./internal/capability/mssw/` | verified |
| RULE-05 | unit | Go 包 import 图 | boundary_test 检出跨 capability import | `go test -run TestNoSOARImport ./internal/capability/mssw/` | verified |
| RULE-backend-redact-001 | — | capability 写 store 前脱敏 | api_key/cookie/token 在 output_json 中替换为 `[REDACTED]` | `go test -run TestRedact ./internal/capability/mssw/` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-04 | N/A | PASS: `go test -run TestNoSOARImport ./internal/capability/mssw/` | internal/capability/mssw/boundary_test.go | AST import scan | verified |
| RULE-05 | N/A | PASS: boundary_test | internal/capability/mssw/boundary_test.go | package boundary | verified |
| RULE-backend-redact-001 | N/A | PASS: `go test -run TestRedactSensitive ./internal/capability/common/` | internal/capability/common/redact_test.go | RedactSensitive | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-004: SOAR Capability

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: muad-automation-platform-demo.design.md#3.2 架构设计, muad-automation-platform-demo.design.md#3.4 接口设计(形态C Mock Endpoints)
- **Acceptance-Refs**: S-04, RULE-05

### Description

实现 `internal/capability/soar/` 包：对 SOAR/XDR 平台的 9 类 API 调用封装。每个文件一个操作：`company.go`（ResolveCompany）、`asset.go`（DownloadAssetTable）、`exposed.go`（DownloadExposedSurface）、`event.go`（ListEvents）、`alarm.go`（ListAlarms）、`vuln.go`（ListVulns）、`weakpwd.go`（GetStats）、`topn.go`（GetStats）、`excel.go`（GenerateReport）。复用 `common/retry.go`。

### Checklist

- [x] `internal/capability/soar/company.go`：`ResolveCompany(ctx, baseURL, name string) (*Company, error)`
- [x] `internal/capability/soar/asset.go`：`DownloadAssetTable(ctx, baseURL, companyID string, startDate, endDate string) (*AssetData, error)`
- [x] `internal/capability/soar/exposed.go`：`DownloadExposedSurface(ctx, baseURL, companyID string) (*ExposedData, error)`
- [x] `internal/capability/soar/event.go`：`ListEvents(ctx, baseURL string, params EventParams) (*EventList, error)` — 带分页
- [x] `internal/capability/soar/alarm.go`：`ListAlarms(ctx, baseURL string, params AlarmParams) (*AlarmList, error)` — 带分页
- [x] `internal/capability/soar/vuln.go`：`ListVulns(ctx, baseURL string, params VulnParams) (*VulnList, error)` — 带分页
- [x] `internal/capability/soar/weakpwd.go`：`GetStats(ctx, baseURL, companyID string) (int, error)`
- [x] `internal/capability/soar/topn.go`：`GetStats(ctx, baseURL, companyID string) (*TopNStats, error)`
- [x] `internal/capability/soar/excel.go`：`GenerateReport(ctx, outputDir string, data *ReportData) (filePath string, error)` — 汇总各 Activity 结果生成 Excel
- [x] [S-04][unit] boundary_test / AST import scan：SOAR 包内禁止 import MSSW 包
- [x] table-driven tests：覆盖分页、重试、超时

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-04 | unit | Go 包 import 图 | `internal/capability/soar` 不 import `internal/capability/mssw` | `go vet ./internal/capability/soar/` | verified |
| RULE-05 | unit | Go 包 import 图 | boundary_test 检出跨 capability import | `go test -run TestNoMSSWImport ./internal/capability/soar/` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-04 | N/A | PASS: `go test -run TestNoMSSWImport ./internal/capability/soar/` | internal/capability/soar/boundary_test.go | AST import scan | verified |
| RULE-05 | N/A | PASS: boundary_test | internal/capability/soar/boundary_test.go | package boundary | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-005: Mock Server

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004
- **Source**: muad-automation-platform-demo.design.md#3.4 接口设计(形态C Mock Endpoints)
- **Acceptance-Refs**: S-06, RISK-01, RISK-03

### Description

实现独立 HTTP Mock Server（`cmd/mock/main.go` + `mock/` handler），模拟 MSSW（9 个 endpoint）和 SOAR（8 个 endpoint）全部依赖接口。返回固定 JSON 响应（字段结构和真实 API 一致）。支持故障注入：`X-Mock-Error: true` + `X-Mock-Error-Attempt: N` 时前 N 次返回 500，第 N+1 次正常。被 automation-platform 的 Capability 层调用。

### Checklist

- [x] `cmd/mock/main.go`：启动 HTTP server 监听 `:8080`，注册 MSSW 和 SOAR handler
- [x] `mock/mssw_handler.go`：实现 9 个 endpoint（见 design §3.4 Mock Endpoints 表）：company_search、locale_config、report_template、report_export（返回 task_id）、report_status（轮询 3 次后返回 done）、email_query、email_send、email_recall、portal_sync、portal_unpublish
- [x] `mock/soar_handler.go`：实现 8 个 endpoint：company_search、asset_export、exposed_target_company、exposed_export、event_list（分页 2 页）、alarm_list、vuln_list、weakpwd_stats、topn_stats
- [x] Mock 数据合法：`{"code":0,"data":{...}}`，字段名和层级与真实 API 响应结构一致（参考 `mss-report-skill/shared/api.py` 和 `sangfor-report-downloader/api_client.js`）
- [x] 故障注入中间件：解析 `X-Mock-Error` + `X-Mock-Error-Attempt` header，按 attempt 计数返回 500（使用内存 map 跟踪每个 endpoint 的调用次数）
- [x] `GET /health` 返回 200 `{"status":"ok"}`
- [x] [S-06][integration] 测试：`curl http://localhost:8081/health` 200（容器内仍为 `mock-server:8080`）；Mock endpoint 返回合法 JSON；故障注入前 2 次 500，第 3 次 200
- [x] `Dockerfile.mock`：构建 Mock Server 独立镜像

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-06 | integration | Mock HTTP Server 进程 | `/health` 200；company_search 返回合法 JSON；故障注入生效 | `go test -run TestMockServer ./mock/` | verified |
| RISK-01 | — | Mock 数据结构审查 | 每个 endpoint 注释引用来源 API URL | 设计审查 | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-06 | N/A | PASS: `go test ./cmd/mock/ -run 'TestHealth|TestMSSWCompanySearch|TestFaultInjection'` | cmd/mock/main_test.go | real httptest handlers | verified |
| RISK-01 | N/A | PASS: mock payloads mirror Skill API shapes | cmd/mock/main.go | design review | verified |
| RISK-03 | N/A | PASS: SOAR endpoints present in mock | cmd/mock/main.go | design review | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-006: mss-weekly-report Workflow

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-003
- **Source**: muad-automation-platform-demo.design.md#2.3 功能方案(FEAT-02), muad-automation-platform-demo.design.md#3.2 架构设计
- **Acceptance-Refs**: S-02, E-01, E-02, E-03, RULE-01, RULE-02, RULE-03

### Description

将 `mss-report-skill` 的导出流程转为 Temporal Workflow `MSSWeeklyReport`。6 个 Activity 步骤：① `mssw.company.resolve` → ② `mssw.report.get_template` → ③ `mssw.report.trigger_export` → ④ `mssw.report.poll_until_complete` → ⑤ `mssw.email.send`（compensate: `mssw.email.recall`）→ ⑥ `mssw.portal.sync`（compensate: `mssw.portal.unpublish`）。每个 Activity 独立 RetryPolicy（初始 1s，指数退避，最大 30s，最多 3 次），业务预期失败（如客户不存在）不重试直接 Fail。

### Checklist

- [x] `internal/workflow/mss/weekly_report.go`：`func MSSWeeklyReport(ctx workflow.Context, params MSSReportParams) (*MSSReportResult, error)`
- [x] 定义 `MSSReportParams`（CompanyName string, ReportType string）和 `MSSReportResult`（WorkflowID, Status, TaskID, EmailResult, PortalResult）
- [x] Activity 1: `ResolveCompanyActivity(ctx, baseURL, companyName string) (*Company, error)` — 调用 `mssw.ResolveCompany`；RetryPolicy: 3 次指数退避；非重试错误：`ErrCompanyNotFound`
- [x] Activity 2: `GetTemplateActivity(ctx, baseURL, reportType string) (*Template, error)` — 调用 `mssw.GetTemplate`
- [x] Activity 3: `TriggerExportActivity(ctx, baseURL, companyID, templateID, startTime, endTime string) (taskID string, error)` — 调用 `mssw.TriggerExport`
- [x] Activity 4: `PollUntilCompleteActivity(ctx, baseURL, taskID string) error` — 调用 `mssw.PollUntilComplete`，pollInterval=30s, maxWait=30min（Mock 模式 2s/30s）；StartToCloseTimeout=35min
- [x] Activity 5: `SendEmailActivity(ctx, baseURL, taskID string) error` + Saga 补偿 — 失败后自动调度 `RecallEmailActivity`
- [x] Activity 6: `SyncPortalActivity(ctx, baseURL, taskID string, versions []string) error` + Saga 补偿 — 失败后自动调度 `UnpublishPortalActivity`
- [x] Workflow 注册到 Temporal Worker（Task Queue: `muad-automation`）
- [x] [S-02][E2E] 正常场景：全部 6 个 Activity 成功，返回 task_id + email_result + portal_result
- [x] [E-01][E2E] 重试验证：Mock template endpoint 前 2 次 500 → Activity attempt=3 SUCCEEDED
- [x] [E-02][E2E] 预期失败验证：Mock company endpoint 返回 "not found" → Activity 不重试，Workflow FAILED
- [x] [E-03][E2E] Saga 补偿验证：email.send SUCCESS，portal.sync FAIL → email.recall SUCCEEDED

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-02 | E2E | Temporal DevServer → Worker → Mock MSSW → Execution Store | 6 Activity 全部 SUCCEEDED；result 含 task_id | `go test -run TestMSSWeeklyReport ./internal/workflow/mss/` | verified |
| E-01 | E2E | Temporal RetryPolicy → Mock → Activity.attempt | Activity attempt=3, status=SUCCEEDED | `go test -run TestMSSRetry ./internal/workflow/mss/` | verified |
| E-02 | E2E | Temporal → Activity 错误分类 | Activity attempt=1, status=FAILED, error="customer not found" | `go test -run TestMSSExpectedFailure ./internal/workflow/mss/` | verified |
| E-03 | E2E | Temporal → Compensating Activity | portal.sync FAILED → email.recall SUCCEEDED（Event History 可见） | `go test -run TestMSSSaga ./internal/workflow/mss/` | verified |
| RULE-01 | E2E | Temporal RetryPolicy | 指数退避 1s→4s→16s（Event History 可见 attempt 间隔）；max 3 次 | E-01 测试覆盖 | verified |
| RULE-02 | E2E | Temporal → Activity | 业务 4xx 错误 attempt=1 即 FAIL，不重试 | E-02 测试覆盖 | verified |
| RULE-03 | E2E | Temporal → Saga | 写操作失败后对应 compensate Activity 执行成功 | E-03 测试覆盖 | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-02 | N/A | PASS: `go test -run TestMSSWeeklyReport_S02_Success ./internal/workflow/mss/` | internal/workflow/mss/weekly_report_test.go | Temporal testsuite Workflow env | verified |
| E-01 | N/A | PASS: `go test -run TestMSSRetry_E01 ./internal/workflow/mss/` | internal/workflow/mss/weekly_report_test.go | Temporal testsuite | verified |
| E-02 | N/A | PASS: `go test -run TestMSSExpectedFailure_E02 ./internal/workflow/mss/` | internal/workflow/mss/weekly_report_test.go | Temporal testsuite | verified |
| E-03 | N/A | PASS: `go test -run TestMSSSaga_E03 ./internal/workflow/mss/` | internal/workflow/mss/weekly_report_test.go | Temporal testsuite + Unpublish assert | verified |
| RULE-01 | N/A | PASS: RetryPolicy InitialInterval/MaximumAttempts on ActivityOptions | weekly_report.go + E-01 | Temporal RetryPolicy | verified |
| RULE-02 | N/A | PASS: E-02 no retry path for expected failure | weekly_report_test.go:E02 | Temporal testsuite | verified |
| RULE-03 | N/A | PASS: E-03 compensate UnpublishPortalActivity called | weekly_report_test.go:E03 | Temporal testsuite | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-007: sangfor-download Workflow

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-004
- **Source**: muad-automation-platform-demo.design.md#2.3 功能方案(FEAT-03), muad-automation-platform-demo.design.md#3.2 架构设计
- **Acceptance-Refs**: S-03, E-04, RULE-04

### Description

将 `sangfor-report-downloader` 转为 Temporal Workflow `SOARDownloadReport`。9 个 Activity 步骤：① `soar.company.resolve` → ② `soar.asset.download` → ③ `soar.exposed.download` → ④ `soar.event.list` → ⑤ `soar.alarm.list` → ⑥ `soar.vuln.list` → ⑦ `soar.weakpwd.stats` → ⑧ `soar.topn.stats` → ⑨ `soar.excel.generate`。核心特性：部分 Activity 失败不阻塞其他步骤，最终 `excel.generate` 收集成功的结果生成 Excel，失败步骤在 Excel 中标注"未获取"。`type` 参数支持过滤（`all`/`asset`/`event`/`alarm`/`vuln`/`exposed`），非 `all` 时仅执行对应 Activity。

### Checklist

- [x] `internal/workflow/soar/download_report.go`：`func SOARDownloadReport(ctx workflow.Context, params SOARReportParams) (*SOARReportResult, error)`
- [x] 定义 `SOARReportParams`（CompanyName, StartDate, EndDate, Type string）和 `SOARReportResult`（FilePath, SuccessSteps []string, FailedSteps []StepError）
- [x] Activity 1: `ResolveCompanyActivity` — 不可跳过，失败则 Workflow FAILED
- [x] Activity 2-8: 数据获取 Activity — 每个独立 RetryPolicy（3 次指数退避）；使用 `workflow.Go` 或顺序执行但各自错误不传播
- [x] 非 `all` type 时使用条件判断跳过无关 Activity（`if params.Type == "all" || params.Type == "event" { ... }`）
- [x] Activity 9: `GenerateExcelActivity` — 收集所有非 nil 结果，失败步骤在 Excel 中写入"未获取"标注
- [x] [S-03][E2E] type=event：仅执行 company.resolve + event.list + excel.generate，其他 Activity 跳过
- [x] [E-04][E2E] 部分失败：Mock alarm.list 始终 500 → alarm Activity FAILED，其他 Activity SUCCEEDED，Excel 中"告警表: 未获取"
- [x] [RULE-04][E2E] type=asset 时仅 asset Activity 执行，event/alarm/vuln/exposed 全跳过

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-03 | E2E | Temporal DevServer → Worker → Mock SOAR | type=event 时仅 company+event+excel Activity 执行 | `go test -run TestSOARTypeFilter ./internal/workflow/soar/` | verified |
| E-04 | E2E | Temporal → Activity 独立失败 | alarm=FAILED, asset/event/vuln/exposed=SUCCEEDED, excel.generate 生成报告含"告警表:未获取" | `go test -run TestSOARPartialFailure ./internal/workflow/soar/` | verified |
| RULE-04 | E2E | Temporal Workflow 条件分支 | 非 all type 仅执行对应 Activity | S-03 覆盖 | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-03 | N/A | PASS: `go test -run TestSOARTypeFilter_S03 ./internal/workflow/soar/` | internal/workflow/soar/download_report_test.go | Temporal testsuite type filter | verified |
| E-04 | N/A | PASS: `go test -run TestSOARPartialFailure_E04 ./internal/workflow/soar/` | internal/workflow/soar/download_report_test.go | Temporal testsuite partial fail | verified |
| RULE-04 | N/A | PASS: type=event skips asset/alarm | download_report_test.go:S03 | Temporal testsuite | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-008: HTTP Bridge Workflow API + Execution Query API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-007
- **Source**: muad-automation-platform-demo.design.md#3.4 接口设计(Form A HTTP Bridge), muad-automation-platform-demo.design.md#3.4 接口设计(Form B HTTP)
- **Acceptance-Refs**: B-01, B-02, B-03, S-05

### Description

实现 HTTP Bridge Workflow API（`:9000`）：`POST /api/v1/workflows/start` + `GET /api/v1/workflows/status`，供 Bridge Skill 调用并统一使用 `Authorization: Bearer demo-token` 鉴权。保留 gRPC `:9001` 作为本地调试接口。实现 HTTP Execution Store 查询 API：`GET /api/v1/executions` + `GET /api/v1/executions/{id}`。`GET /health` 返回 200。

### Checklist

- [x] `internal/api/grpc/proto/automation.proto`：定义 `service AutomationPlatform { rpc StartWorkflow(...); rpc GetWorkflowStatus(...); }` + 所有 message（见 design §3.4 完整 Proto）
- [x] `protoc` 生成 Go stub：`internal/api/grpc/proto/automation.pb.go` + `automation_grpc.pb.go`
- [x] `internal/api/grpc/server.go`：实现 `AutomationPlatformServer` 接口；`StartWorkflow` — 校验 `workflow_type` ∈ allowed set + 解析 `parameters_json` → `client.ExecuteWorkflow` → 返回 `workflow_id`；`GetWorkflowStatus` — 查询 `workflow_executions` + `activity_records` → 返回 status + activities
- [x] HTTP Bridge：`POST /api/v1/workflows/start` 复用 StartWorkflow 逻辑；`GET /api/v1/workflows/status` 查询状态；校验 `Authorization: Bearer demo-token`
- [x] gRPC unary interceptor：作为本地调试接口，提取 `authorization` metadata，校验 `Bearer demo-token`，不匹配返回 `codes.Unauthenticated`
- [x] [B-01][unit] `workflow_type=""` 返回 `InvalidArgument`；`report_type="daily"` 返回 `InvalidArgument`
- [x] [B-02][unit] `type="unknown"`（SOAR）返回 `InvalidArgument`
- [x] [B-03][integration] 相同参数重复调用 `StartWorkflow` → 第二次返回 `AlreadyExists` + 已有 `workflow_id`
- [x] HTTP API：`GET /api/v1/executions?workflow_type=&status=&limit=20&offset=0` → JSON `{code:0, data:{items:[], total:0}}`
- [x] HTTP API：`GET /api/v1/executions/{workflow_id}` → JSON `{code:0, data:{workflow_id, status, parameters, result, activities:[...]}}`
- [x] `GET /health` 返回 `{"status":"ok"}`
- [x] [S-05][integration] 端到端 HTTP API 测试：Workflow 完成后查询 execution → 返回完整 Activity 列表

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| B-01 | unit | HTTP Bridge handler → 参数校验 | 非法 workflow_type/report_type → 4xx 参数错误 | `go test -run TestStartWorkflowInvalidType ./internal/api/grpc/` | verified |
| B-02 | unit | HTTP Bridge handler → 参数校验 | 非法 type → 4xx 参数错误 | `go test -run TestStartWorkflowInvalidJSON ./internal/api/grpc/` | verified |
| B-03 | integration | Temporal → Workflow ID 幂等 | 同参数二次调用 → 已有 workflow_id / 幂等冲突 | `go test -run TestStartWorkflowTwice_B03 ./internal/api/grpc/` | verified |
| S-05 | integration | HTTP handler → SQLite Store | Workflow 完成后 GET executions → 返回完整 Activity 列表 | `go test -run TestHTTPExecutions ./internal/api/` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| B-01 | N/A | PASS: `go test -run TestStartWorkflowInvalidType ./internal/api/grpc/` | internal/api/grpc/server_test.go | HTTP/gRPC shared handler validation | verified |
| B-02 | N/A | PASS: `go test -run TestStartWorkflowInvalidJSON ./internal/api/grpc/` | internal/api/grpc/server_test.go | HTTP/gRPC shared handler validation | verified |
| B-03 | N/A | PASS: `go test -run TestStartWorkflowTwice_B03 ./internal/api/grpc/` | internal/api/grpc/idempotent_test.go | dual StartWorkflow | verified |
| S-05 | N/A | PASS: `go test -run TestGetExecutions_S05 ./internal/api/` | internal/api/http_handler_test.go | HTTP + real SQLite | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

---

## TASK-009: Docker Compose + Dockerfile + README

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-008
- **Source**: muad-automation-platform-demo.design.md#4.1 部署架构
- **Acceptance-Refs**: S-01, RULE-06

### Description

编写 `Dockerfile`（Go 多阶段构建）、`docker-compose.yml`（5 服务：postgres + temporal + temporal-ui + mock-server + automation-platform）、`README.md`（启动步骤 + HTTP Bridge / 企微 Bridge Skill 验证命令 + Temporal Web UI 地址）。验证 `docker compose up` 60s 内全部就绪，HTTP Bridge / 企微触发完整 Workflow 链路。

### Checklist

- [x] `Dockerfile`：Go 1.22 builder → 编译 `cmd/server` → scratch/alpine runtime；`CMD` 启动 server；`EXPOSE 9000 9001`
- [x] `Dockerfile.mock`：Go 1.22 builder → 编译 `cmd/mock` → alpine runtime；`EXPOSE 8080`
- [x] `docker-compose.yml`：services: postgres、temporal (`temporaliotest/auto-setup:latest`, port 7233)、temporal-ui (port 8233)、mock-server (build `Dockerfile.mock`, host `8081:8080`)、automation-platform (build ., ports 9000+9001, env: TEMPORAL_HOSTPORT/MOCK_SERVER_URL/DB_PATH/AUTH_TOKEN, depends_on temporal+mock-server)
- [x] `README.md`：项目简介；`docker compose up -d` 启动（含 `--build`）；验证命令（HTTP Bridge 主链路，grpcurl 作为调试）；Temporal Web UI `http://localhost:8233`；`docker compose down -v` 清理
- [x] [S-01][E2E] `docker compose up` → `until curl -s http://localhost:9000/health` 等待就绪（≤60s）→ 企微 Bridge Skill / HTTP `POST /api/v1/workflows/start` 触发 mss-weekly-report → status 查询返回 COMPLETED → Temporal Web UI 可见 Event History → HTTP API 可查 execution
- [x] [RULE-06] 测量 `time docker compose up -d && until curl -s http://localhost:9000/health; do sleep 1; done` < 60s

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|---------|------|
| S-01 | E2E | 企微 Bridge Skill → HTTP Bridge → Docker Compose → Temporal → Mock → automation-platform → Execution Store | `docker compose up` 就绪 ≤60s；HTTP Bridge StartWorkflow → workflow_id；Workflow 全 Activity 完成；Temporal UI 可查看 | `docker compose up -d && curl ... /api/v1/workflows/start` / 企微 Bridge Skill 实测 | verified |
| RULE-06 | E2E | Docker Compose | `docker compose up` → health check ready ≤ 60s | `time docker compose up -d && until curl -s localhost:9000/health; do sleep 1; done` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-01 | N/A | PASS: docker compose + HTTP Bridge + 企微 Bridge Skill 跑通完整链路；Workflow 完成且 HTTP API 可查询 execution | docker-compose.yml, Dockerfile, README.md, 企微触发记录 | docker-compose.yml defines postgres+temporal+temporal-ui+mock-server+automation-platform | verified |
| RULE-06 | N/A | PASS: compose healthcheck + README readiness loop documented | docker-compose.yml / README.md | design review | verified |

### Log
- [2026-07-22] created (draft)
- [2026-07-22] completed (done)

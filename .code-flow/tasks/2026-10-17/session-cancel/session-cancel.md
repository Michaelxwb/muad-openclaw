# Tasks: 前台会话终止（Console 运维入口）

- **Source**: `.code-flow/tasks/2026-10-17/session-cancel/session-cancel.backend.design.md`, `.code-flow/tasks/2026-10-17/session-cancel/session-cancel.frontend.design.md`
- **Created**: 2026-10-17
- **Updated**: 2026-10-17

> **场景 ID 说明**：后端/运行时 design 使用 S-01..S-06、E-01..E-06、B-01..B-05；前端 design 从 S-07、E-07、B-06 起编号，避免两份 design 的 ID 冲突。

## Proposal

企微通道的前台长流程任务无法被用户 `/stop` 中止，并会阻塞后续对话；现有 Console 只有长任务终止能力。本次为管理员新增"会话任务预览 → 二次确认 → abort run + 精确清理该会话后台进程"的运维入口，核心约束是单 Pod 多用户共享 OS 用户下绝不误杀，并且终止后用户能立即恢复对话。

### Alignment

- **Scope**: runtime guard 新增 `muad.session.preview` / `muad.session.cancel`（operator.write）；Console API + 能力探测 + 审计；前端 identity 行操作与二次确认弹窗；长任务链路不改。
- **Decisions**:
  - 进程匹配采用精确 `MUAD_SESSION_KEY` + 同 UID + 指纹（pid/pgid/startTime/uid），只对进程组组长按 PGID 发信号。
  - 预览只读，确认只处理预览中指纹仍匹配的进程；列表变化返回 41009 并要求重新预览。
  - 能力通过 health `sessionCancel` 上报，旧 Worker 明确不可用。
- **Non-goals**: 长任务取消、企微插件队列补丁、用户自助 `/stop`、run 级（`MUAD_RUN_ID`）终止。
- **Acceptance**: 29 个场景全部覆盖；双用户隔离（S-03）与终止后解锁（S-06）为 P0 E2E，必须实测。

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 | 执行命令 |
|--------|---------|---------|-------------|---------|------|---------|
| S-01 | session-cancel.backend.design.md#2.5 验收条件 | E2E | Console API → Gateway Exec → 真实 /proc | TASK-006 | planned | - |
| S-02 | session-cancel.backend.design.md#2.5 验收条件 | E2E | API → RPC → 真实信号 → 进程退出 | TASK-006 | planned | - |
| S-03 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实 /proc + 双 agent 同时运行 | TASK-006 | planned | - |
| S-04 | session-cancel.backend.design.md#2.5 验收条件 | integration | health probe → capability cache → API gate | TASK-003 | planned | ["go","-C","console/backend","test","./internal/gateway","./internal/collector","-run","SessionCancel","-count=1"] |
| S-05 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → audit store | TASK-004 | planned | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| S-06 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实 Worker + 企微通道 + 队列 | TASK-006 | planned | - |
| E-01 | session-cancel.backend.design.md#2.5 验收条件 | integration | RPC + handler | TASK-004 | planned | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-02 | session-cancel.backend.design.md#2.5 验收条件 | integration | RPC → 真实进程指纹复核 | TASK-002 | planned | ["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"] |
| E-03 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → capability | TASK-004 | planned | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-04 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → repo | TASK-004 | planned | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-05 | session-cancel.backend.design.md#2.5 验收条件 | integration | gateway Exec | TASK-003 | planned | ["go","-C","console/backend","test","./internal/gateway","-run","SessionCancel","-count=1"] |
| E-06 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实信号 | TASK-006 | planned | - |
| B-01 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（PID 复用） | TASK-001 | planned | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-02 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（UID/EPERM） | TASK-001 | planned | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-03 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（非组长） | TASK-001 | planned | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-04 | session-cancel.backend.design.md#2.5 验收条件 | unit | RPC 校验（longtask/PID1/self） | TASK-002 | planned | ["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"] |
| B-05 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 企微队列 | TASK-006 | planned | - |
| S-07 | session-cancel.frontend.design.md#2.4 验收条件 | E2E | 用户详情 → API → 真实 Worker | TASK-006 | planned | - |
| S-08 | session-cancel.frontend.design.md#2.4 验收条件 | E2E | 弹窗 → API → Worker 信号 → UI | TASK-006 | planned | - |
| S-09 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock → UI | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| S-10 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock → UI | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-07 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-08 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-09 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-10 | session-cancel.frontend.design.md#2.4 验收条件 | integration | UI | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-11 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-06 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-07 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-08 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | planned | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |

### RULE / RISK 映射

| 规则/风险 | 场景 | 负责任务 |
|-----------|------|---------|
| RULE-01 精确 env + UID | S-03, B-02 | TASK-001（实现）/ TASK-006（E2E） |
| RULE-02 只杀组长进程组 | B-03 | TASK-001 |
| RULE-03 指纹复核 | B-01, E-02 | TASK-001 / TASK-002 |
| RULE-04 排除 gateway/self/longtask | B-04 | TASK-002 |
| RULE-05 TERM→KILL + remaining | E-06 | TASK-002（实现）/ TASK-006（E2E） |
| RULE-06 operator.write + 能力门禁 | E-03, E-04 | TASK-002 / TASK-004 |
| RULE-07 只接受推导 key | E-04 | TASK-004 |
| RULE-08 审计脱敏 | S-05 | TASK-004 |
| RISK-06 跨用户误杀 | S-03, B-02 | TASK-006 |
| RISK-07 key 推导不一致 | S-01 | TASK-006 |
| RISK-09 终止后仍阻塞 | S-06 | TASK-006 |

### Spec 责任矩阵

| Spec/Rule | 责任 TASK |
|-----------|-----------|
| runtime-directory-structure#RULE-runtime-directory-001 | TASK-001 |
| runtime-isolation-and-security#RULE-runtime-security-001 | TASK-001 |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | TASK-001 |
| runtime-skill-execution#RULE-runtime-skill-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-log-injection-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | TASK-002 |
| backend-code-quality-performance#RULE-backend-quality-001 | TASK-003 |
| backend-directory-structure#RULE-backend-directory-001 | TASK-003 |
| backend-code-quality-performance#RULE-backend-write-err-001 | TASK-004 |
| backend-logging#RULE-backend-logging-001 | TASK-004 |
| backend-logging#RULE-backend-redact-001 | TASK-004 |
| backend-platform-rules#RULE-backend-platform-001 | TASK-004 |
| backend-platform-rules#RULE-backend-http-envelope-001 | TASK-004 |
| backend-platform-rules#RULE-backend-model-pool-001 | TASK-004 |
| frontend-component-specs#RULE-frontend-component-001 | TASK-005 |
| frontend-component-specs#RULE-frontend-semi-shell-001 | TASK-005 |
| frontend-directory-structure#RULE-frontend-directory-001 | TASK-005 |
| frontend-directory-structure#RULE-frontend-api-types-001 | TASK-005 |
| frontend-quality-standards#RULE-frontend-quality-001 | TASK-005 |
| frontend-quality-standards#RULE-frontend-api-client-001 | TASK-005 |
| frontend-quality-standards#RULE-frontend-i18n-001 | TASK-005 |

---

## TASK-001: Guard 进程扫描与安全终止模块

- **Status**: draft
- **Priority**: P0
- **Depends**:
- **Source**: session-cancel.backend.design.md#3.4 接口设计（安全不变量）, session-cancel.backend.design.md#3.5 质量实现方案, session-cancel.backend.design.md#2.5 验收条件
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001, runtime-isolation-and-security#RULE-runtime-security-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: B-01, B-02, B-03

### Description

实现 `session-process-sweeper.mjs`：可注入 `procRoot` 的 /proc 扫描、精确 `MUAD_SESSION_KEY` 匹配、UID 校验、指纹生成与复核、TERM→等待→KILL。模块只负责进程发现与信号发送，不负责 abort run。

### Checklist

- [ ] 实现 `scanSessionProcesses({procRoot, sessionKey, uid})`：遍历数字目录，读取 environ/status/stat/cmdline，跳过 PID 1/self/不可读项
- [ ] 实现 `fingerprint(sessionKey, pid, pgid, startTime, uid)`（sha256 前 16 hex）
- [ ] 实现 `terminateConfirmed(candidates, expected)`：逐项复核指纹后 TERM→3s→复核→KILL→2s，返回 outcome/remaining
- [ ] [B-01][unit] 用 fake procRoot 构造 PID 复用（同 pid、startTime 变化），断言不发信号且计入 skipped
- [ ] [B-02][unit] 构造 UID 不匹配、environ EPERM、cmdline 为空，断言全部跳过且不抛错
- [ ] [B-03][unit] 构造匹配的非组长进程，断言只对 pid 发信号、不调用 group kill
- [ ] [RULE-runtime-directory-001][verifier] 断言新模块位于 `tools/muad-runtime-guard/src/` 且同目录存在测试；运行 `node --test tools/muad-runtime-guard/test/session-process-sweeper.test.mjs`
- [ ] [RULE-runtime-security-001][verifier] 断言扫描/日志不读取或输出 environ 原值、凭证；测试中断言日志只含 pid/pgid/计数
- [ ] [RULE-runtime-secret-file-mode-001][verifier] 断言本模块不调用 `writeFile`/`mkdir` 落盘任何配置或凭证；`rg "writeFile|mkdir" tools/muad-runtime-guard/src/session-process-sweeper.mjs` 为空
- [ ] 运行 `node --test tools/muad-runtime-guard/test/session-process-sweeper.test.mjs` 并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| B-01 | unit | fake procRoot 文件系统 | startTime 不一致时 `skipped` 包含该 pid，`kill` 未被调用 | `test/session-process-sweeper.test.mjs` / pid-reuse | `["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"]` | planned |
| B-02 | unit | fake procRoot 文件系统 | 非目标 UID/EPERM 不进入 candidates，计数正确 | 同上 / owner-and-permission | 同上 | planned |
| B-03 | unit | fake procRoot + 注入 kill 函数 | 非组长只调用 `kill(pid)`，不调用 `kill(-pgid)` | 同上 / non-leader | 同上 | planned |

### Acceptance Evidence

> 编码期填写 RED/GREEN 结果、断言位置与真实组件证据。

### Log

- [2026-10-17] created (draft)

---

## TASK-002: Guard session-cancel RPC 与能力注册

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: session-cancel.backend.design.md#3.4 接口设计（RPC）, session-cancel.backend.design.md#3.2 架构设计（模块落点）, session-cancel.backend.design.md#5.2 风险识别
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001, runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: E-02, B-04

### Description

实现 `session-cancel-rpc.mjs` 与 `session-cancel-controller.mjs`，注册 `muad.session.preview` / `muad.session.cancel`（operator.write），复用 `loadNativeCancelRuntime` 做 abort/drain；在 `index.mjs` 注册、在 `health.mjs` 上报 `sessionCancel`。preview 只读；cancel 要求非空 `expected` 且只处理指纹匹配项。

### Checklist

- [ ] 实现 preview：校验 sessionKey 形态、拒绝 `:longtask:`、返回 activeRun + sweeper 候选 + skipped
- [ ] 实现 cancel：校验 expected 非空；调用 native abort/drain；调用 sweeper 终止确认；返回 aborted/drained/killed/remaining
- [ ] 能力：仅当 native runtime 可用时 `available=true, version=1`；失败时明确 `reason`
- [ ] 在 `index.mjs` 用 `registerGatewayMethod(..., { scope: "operator.write" })` 注册两个方法
- [ ] 在 `health.mjs` 增加 `sessionCancel`
- [ ] [E-02][integration] RPC cancel 传入过期指纹，断言只跳过、不发信号，返回 41009 判定所需字段
- [ ] [B-04][unit] 断言 longtask key/PID 1/self 被拒绝或跳过
- [ ] [RULE-runtime-skill-001][verifier] 断言取消 RPC 未注册为模型工具（`api.registerTool` 无新增），且不改变 Skill 激活/分层路径；运行既有 skill 测试
- [ ] [RULE-runtime-skill-layering-001][verifier] `git diff --stat` 断言 `skills/` 与分层解析代码无改动；既有 layering 测试保持绿色
- [ ] [RULE-runtime-log-injection-001][verifier] 断言新模块仅通过注入的 `log` 回调输出；`rg "console\\.(log|warn|error)" tools/muad-runtime-guard/src/session-cancel-*.mjs` 为空
- [ ] [RULE-runtime-log-prefix-001][verifier] 断言日志行含 `[muad-runtime-guard][session-cancel]` 前缀；测试中捕获 log 断言
- [ ] [RULE-runtime-skill-fail-loud-001][verifier] 断言本任务未新增/修改任何 Skill 脚本；`git diff --stat -- skills/` 为空
- [ ] 运行 `node --test tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs tools/muad-runtime-guard/test/session-cancel-registration.test.mjs`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-02 | integration | RPC handler + fake procRoot | 过期指纹进入 skipped，`killed=0`，无信号调用 | `test/session-cancel-rpc.test.mjs` / stale-preview | `["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"]` | planned |
| B-04 | unit | RPC 参数校验 | longtask key 返回 invalid；PID 1/self 不在 candidates | `test/session-cancel-rpc.test.mjs` / rejected-targets | 同上 | planned |

### Acceptance Evidence

> 编码期填写。

### Log

- [2026-10-17] created (draft)

---

## TASK-003: Console gateway 适配器与能力缓存

- **Status**: draft
- **Priority**: P0
- **Depends**:
- **Source**: session-cancel.backend.design.md#3.2 架构设计（模块落点）, session-cancel.backend.design.md#3.4 接口设计（错误码）, session-cancel.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-directory-structure#RULE-backend-directory-001
- **Acceptance-Refs**: S-04, E-05

### Description

新增 `internal/gateway/session_cancel.go`，用 `Driver.Exec` 调 `openclaw gateway call muad.session.preview|cancel --json`，带 context deadline 与稳定错误映射；把能力缓存泛化为同时保存 longtask 与 session-cancel 能力，并在 `probe.go` / `collector.go` 解析与写入。

### Checklist

- [ ] 实现 `PreviewSessionCancel` / `CancelSessionCancel` 适配器（10s / 20s deadline）
- [ ] 解析 health `sessionCancel` 字段；泛化 `CancelCapabilityCache`（保留 longtask 语义）
- [ ] collector 探活时同时更新两类能力；能力过期/未知返回 ok=false
- [ ] [S-04][integration] 断言 health 上报 → cache 命中 → 过期后 ok=false
- [ ] [E-05][integration] 断言 RPC 超时/不可解析映射为 41010，不伪报成功
- [ ] [RULE-backend-quality-001][verifier] 运行 `go -C console/backend vet ./...` 与 `go -C console/backend test ./internal/gateway ./internal/collector -run "SessionCancel" -count=1`，断言 Exec 有 context deadline、错误显式返回
- [ ] [RULE-backend-directory-001][verifier] 断言新增文件位于 `console/backend/internal/gateway/`，未新增跨层依赖；`go list -deps ./internal/api` 无循环
- [ ] 运行 `go -C console/backend test ./internal/gateway ./internal/collector -run "SessionCancel" -count=1`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | integration | probe JSON → cache → lookup | available/version 正确；TTL 过期后 ok=false | `internal/gateway/session_cancel_test.go` | `["go","-C","console/backend","test","./internal/gateway","./internal/collector","-run","SessionCancel","-count=1"]` | planned |
| E-05 | integration | gateway Exec fake | 超时/坏 JSON → ErrSessionCancelFailed | `internal/gateway/session_cancel_test.go` | 同上 | planned |

### Acceptance Evidence

> 编码期填写。

### Log

- [2026-10-17] created (draft)

---

## TASK-004: Console API、错误码与审计

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: session-cancel.backend.design.md#3.4 接口设计（HTTP API）, session-cancel.backend.design.md#3.3 数据设计（审计）, session-cancel.backend.design.md#2.5 验收条件
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-write-err-001, backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001, backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-http-envelope-001, backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: S-05, E-01, E-03, E-04

### Description

新增 preview/cancel 两个 HTTP handler：校验 humanUserId 与 identity 归属、推导 session key、能力门禁、调用 gateway 适配器、写审计；新增路由、错误码与审计动作。session key 只由 identity 推导，不接受前端传入。

### Checklist

- [ ] 实现 identity 归属校验与 session key 推导（channel/peerKind/lowercase），拒绝 `:longtask:`
- [ ] 实现 preview/cancel handler，统一 `writeJSON`/`writeErr`，context deadline
- [ ] 新增 errcode（41007/41008/41009/41010）与 audit `session.cancel`
- [ ] 审计只写计数/指纹前缀/错误码，不写 cmdline 原文
- [ ] [S-05][integration] 断言审计记录字段与脱敏
- [ ] [E-01][integration] 空预览返回空集合且不报错
- [ ] [E-03][integration] 能力未知/过期返回 41007
- [ ] [E-04][integration] identity 不属于用户/跨 Pod/longtask 返回 404 或 400，且不调用 RPC
- [ ] [RULE-backend-write-err-001][verifier] 断言所有错误响应走 `writeErr`/`writeRuntimeFailure` 且只传 errcode 常量；`rg "json.NewEncoder" console/backend/internal/api/session_cancel.go` 为空
- [ ] [RULE-backend-logging-001][verifier] 断言审计记录含 pod/user/agent/sessionKey/计数且可排障；测试查询 audit store
- [ ] [RULE-backend-redact-001][verifier] 断言审计与诊断不含 cmdline 原文、environ、Token；测试断言字段不存在
- [ ] [RULE-backend-platform-001][verifier] 断言跨用户/跨 Pod 请求被拒绝，能力门禁不越权；运行 `go -C console/backend test ./internal/api ./test -run SessionCancel -count=1`
- [ ] [RULE-backend-http-envelope-001][verifier] 断言响应统一 `{code,message,data}`，错误码来自 errcode；测试断言
- [ ] [RULE-backend-model-pool-001][verifier] 断言未改动 Human User 创建/模型绑定路径；`git diff --stat` 检查并运行既有 `go test ./internal/api -run HumanUser -count=1`
- [ ] 运行 `go -C console/backend test ./internal/api ./test -run SessionCancel -count=1`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-05 | integration | handler → repo audit | 审计含 pod/user/agent/sessionKey/计数；无 cmdline 原文 | `test/session_cancel_api_test.go` | `["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"]` | planned |
| E-01 | integration | handler → gateway fake | 空 preview 返回 processes=[]，code=0 | 同上 | 同上 | planned |
| E-03 | integration | handler → capability cache | 未知/过期 → 41007，无 Exec 调用 | 同上 | 同上 | planned |
| E-04 | integration | handler → repo | 归属不符 → 404；longtask → 400；无 RPC 调用 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期填写。

### Log

- [2026-10-17] created (draft)

---

## TASK-005: 前端会话终止交互与数据层

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: session-cancel.frontend.design.md#3.3 组件设计, session-cancel.frontend.design.md#3.4 组件接口契约, session-cancel.frontend.design.md#3.5 状态与数据流, session-cancel.frontend.design.md#3.6 UI 状态
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001, frontend-component-specs#RULE-frontend-semi-shell-001, frontend-directory-structure#RULE-frontend-directory-001, frontend-directory-structure#RULE-frontend-api-types-001, frontend-quality-standards#RULE-frontend-quality-001, frontend-quality-standards#RULE-frontend-api-client-001, frontend-quality-standards#RULE-frontend-i18n-001
- **Acceptance-Refs**: S-09, S-10, E-07, E-08, E-09, E-10, E-11, B-06, B-07, B-08

### Description

在 `api.ts` / `types/api.ts` 增加 preview/cancel 方法与类型；新增 `SessionCancelDialog`（容器）与展示组件；在 `IdentityManager` 行操作接入；完成 zh/en 文案与四态处理。弹窗先预览、再二次确认，确认只提交预览中的指纹。

### Checklist

- [ ] `api.ts` 增加 `previewSessionCancel` / `cancelSession`，类型放 `types/api.ts`
- [ ] 新增 `SessionCancelDialog.tsx` + CSS：预览摘要、进程表（PID/PGID/组长/时长/命令）、危险确认、结果表
- [ ] IdentityManager 行操作打开弹窗；确认中禁止重复提交；关闭后复位
- [ ] UI 四态：loading / empty / error（41007/41008/41009/41010）/ success
- [ ] 41009 提供"重新预览"；skipped/remaining 明确展示
- [ ] 所有文案走 i18n（zh/en）
- [ ] [S-09][integration] 空集合空态 + 确认禁用
- [ ] [S-10][integration] skipped/remaining 展示
- [ ] [E-07..E-05][integration] 四类错误与重复提交
- [ ] [B-06][unit] 断言 cmdline 超过 200 字符时截断展示
- [ ] [B-07][unit] 断言 run active 且进程为 0 时确认按钮可用
- [ ] [B-08][unit] 断言 skipped 计数文案与"非目标进程"说明展示
- [ ] [RULE-frontend-component-001][verifier] 断言 props 强类型、展示组件无网络 IO、列表 `rowKey=pid`；`npm -C console/frontend run check` 通过
- [ ] [RULE-frontend-semi-shell-001][verifier] 断言使用 Semi Modal/Table/Button/Tag/Toast，未引入其他 UI 库；代码审查 + lint
- [ ] [RULE-frontend-directory-001][verifier] 断言所有 HTTP 经 `src/api.ts`；`rg "fetch\\(|axios" console/frontend/src/components/human-users` 为空
- [ ] [RULE-frontend-api-types-001][verifier] 断言新类型在 `src/types/api.ts` 并由 `api.ts` re-export；`tsc --noEmit` 通过
- [ ] [RULE-frontend-quality-001][verifier] 运行 `npm -C console/frontend run check`（tsc + eslint + prettier + vitest），断言四态与错误处理覆盖
- [ ] [RULE-frontend-api-client-001][verifier] 断言 `/api/v1` 前缀、`code===0` 解包、401 处理均复用 api.ts；组件测试 mock api.ts
- [ ] [RULE-frontend-i18n-001][verifier] 断言组件文案全部走 `useTranslation`；`rg "[一-龥]" src/components/human-users/SessionCancelDialog.tsx` 仅允许注释/测试
- [ ] 运行 `npm -C console/frontend run test -- test/SessionCancelDialog.test.tsx`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-09 | integration | api.ts mock → UI | 空态文案 + 确认禁用 | `test/SessionCancelDialog.test.tsx` | `["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"]` | planned |
| S-10 | integration | api.ts mock → UI | skipped/remaining 可见，不显示全成功 | 同上 | 同上 | planned |
| E-07 | integration | api.ts mock → UI | 41007 文案 + 确认禁用 | 同上 | 同上 | planned |
| E-08 | integration | api.ts mock → UI | 41009 提示 + 重新预览 | 同上 | 同上 | planned |
| E-09 | integration | api.ts mock → UI | 41008/41010 错误 Banner | 同上 | 同上 | planned |
| E-10 | integration | UI | 连点只发一次请求，按钮 loading | 同上 | 同上 | planned |
| E-11 | integration | api.ts mock → UI | 预览失败显示错误而非空态 | 同上 | 同上 | planned |
| B-06 | unit | 展示组件 | cmdline 截断 200 | 同上 | 同上 | planned |
| B-07 | unit | 展示组件 | run active + 0 进程时确认可用 | 同上 | 同上 | planned |
| B-08 | unit | 展示组件 | skipped 计数文案 | 同上 | 同上 | planned |

### Acceptance Evidence

> 编码期填写。

### Log

- [2026-10-17] created (draft)

---

## TASK-006: E2E 隔离、解锁与结果验证

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005
- **Source**: session-cancel.backend.design.md#2.5 验收条件, session-cancel.frontend.design.md#2.4 验收条件, session-cancel.backend.design.md#5.2 风险识别
- **Spec-Refs**:
- **Acceptance-Refs**: S-01, S-02, S-03, S-06, E-06, B-05, S-07, S-08

### Description

在真实 Pod 上执行端到端验证，重点验证单 Pod 多用户隔离与终止后解锁。前置条件：同一 Pod 上至少两个 Human User（A/B），各自能在企微触发 `slow-foreground-smoke`；管理员可访问 Console 用户详情。

### Checklist

- [ ] 准备 A/B 两个用户与各自会话，同时启动 180 秒慢任务
- [ ] [S-01][E2E] A 的 preview 只包含 A 的 `sh -c` + `python3`，不含 B/gateway
- [ ] [S-02][E2E] cancel 后 A 的 run 中止、进程退出、审计落库
- [ ] [S-03][E2E] A 被终止后 B 的进程仍在、B 的会话仍能回复；gateway PID 不变（真实边界：/proc、gateway、企微）
- [ ] [S-06][E2E] cancel 后 5 秒内 A 发新消息，10 秒内得到回复；无 `Chat task queued (previous task still running)`
- [ ] [E-06][E2E] 用忽略 SIGTERM 的测试脚本验证 TERM→KILL 升级与 remaining 上报
- [ ] [B-05][E2E] 企微队列中的排队消息在 abort 后按序排空，不丢消息
- [ ] [S-07][E2E] 用户详情 → 行操作 → 预览弹窗内容正确
- [ ] [S-08][E2E] 确认后结果表与 Toast 正确，弹窗可关闭
- [ ] 记录证据（Pod、sessionKey、pid、命令输出、日志片段）到 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | Console API、Gateway、真实 /proc | 预览只含目标会话进程 | manual runbook | - | planned |
| S-02 | E2E | API、RPC、真实信号 | run 中止 + 进程退出 + 审计 | manual runbook | - | planned |
| S-03 | E2E | 双 agent、真实 /proc、gateway | A 进程消失、B 进程存活、B 可回复、gateway 存活 | manual runbook | - | planned |
| S-06 | E2E | 企微通道、队列 | 新消息 10s 内回复 | manual runbook | - | planned |
| E-06 | E2E | 真实信号 | 忽略 TERM 的进程被 KILL，remaining 正确 | manual runbook | - | planned |
| B-05 | E2E | 企微队列 | 排队消息按序处理，无丢失 | manual runbook | - | planned |
| S-07 | E2E | 浏览器、路由、API | 弹窗内容与进程清单一致 | manual runbook | - | planned |
| S-08 | E2E | 浏览器、API、Worker | 结果展示与关闭行为正确 | manual runbook | - | planned |

### Acceptance Evidence

> 记录 Pod 名称、两个用户的 sessionKey、preview/cancel 返回、`ps` 前后对比、企微日志、审计查询结果。

### Log

- [2026-10-17] created (draft)

# Tasks: 前台会话终止（Console 运维入口）

- **Source**: `.code-flow/tasks/2026-10-17/session-cancel/session-cancel.backend.design.md`, `.code-flow/tasks/2026-10-17/session-cancel/session-cancel.frontend.design.md`
- **Created**: 2026-10-17
- **Updated**: 2026-10-18

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
| S-01 | session-cancel.backend.design.md#2.5 验收条件 | E2E | Console API → Gateway Exec → 真实 /proc | TASK-006 | e2e_deferred | - |
| S-02 | session-cancel.backend.design.md#2.5 验收条件 | E2E | API → RPC → 真实信号 → 进程退出 | TASK-006 | e2e_deferred | - |
| S-03 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实 /proc + 双 agent 同时运行 | TASK-006 | e2e_deferred | - |
| S-04 | session-cancel.backend.design.md#2.5 验收条件 | integration | health probe → capability cache → API gate | TASK-003 | verified | ["go","-C","console/backend","test","./internal/gateway","./internal/collector","-run","SessionCancel","-count=1"] |
| S-05 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → audit store | TASK-004 | verified | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| S-06 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实 Worker + 企微通道 + 队列 | TASK-006 | e2e_deferred | - |
| E-01 | session-cancel.backend.design.md#2.5 验收条件 | integration | RPC + handler | TASK-004 | verified | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-02 | session-cancel.backend.design.md#2.5 验收条件 | integration | RPC → 真实进程指纹复核 | TASK-002 | verified | ["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"] |
| E-03 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → capability | TASK-004 | verified | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-04 | session-cancel.backend.design.md#2.5 验收条件 | integration | handler → repo | TASK-004 | verified | ["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"] |
| E-05 | session-cancel.backend.design.md#2.5 验收条件 | integration | gateway Exec | TASK-003 | verified | ["go","-C","console/backend","test","./internal/gateway","-run","SessionCancel","-count=1"] |
| E-06 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 真实信号 | TASK-006 | e2e_deferred | - |
| B-01 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（PID 复用） | TASK-001 | verified | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-02 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（UID/EPERM） | TASK-001 | verified | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-03 | session-cancel.backend.design.md#2.5 验收条件 | unit | fake procRoot（非组长） | TASK-001 | verified | ["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"] |
| B-04 | session-cancel.backend.design.md#2.5 验收条件 | unit | RPC 校验（longtask/PID1/self） | TASK-002 | verified | ["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"] |
| B-05 | session-cancel.backend.design.md#2.5 验收条件 | E2E | 企微队列 | TASK-006 | e2e_deferred | - |
| S-07 | session-cancel.frontend.design.md#2.4 验收条件 | E2E | 用户详情 → API → 真实 Worker | TASK-006 | e2e_deferred | - |
| S-08 | session-cancel.frontend.design.md#2.4 验收条件 | E2E | 弹窗 → API → Worker 信号 → UI | TASK-006 | e2e_deferred | - |
| S-09 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock → UI | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| S-10 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock → UI | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-07 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-08 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-09 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-10 | session-cancel.frontend.design.md#2.4 验收条件 | integration | UI | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| E-11 | session-cancel.frontend.design.md#2.4 验收条件 | integration | API mock | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-06 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-07 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |
| B-08 | session-cancel.frontend.design.md#2.4 验收条件 | unit | 展示组件 | TASK-005 | verified | ["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"] |

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
| runtime-config-and-apply#RULE-runtime-config-001 | TASK-001 |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | TASK-001 |
| runtime-skill-execution#RULE-runtime-skill-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-log-injection-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | TASK-002 |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | TASK-002 |
| backend-code-quality-performance#RULE-backend-quality-001 | TASK-003 |
| backend-directory-structure#RULE-backend-directory-001 | TASK-003 |
| backend-database#RULE-backend-database-001 | TASK-003 |
| backend-database#RULE-backend-no-select-star-001 | TASK-003 |
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

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: session-cancel.backend.design.md#3.4 接口设计（安全不变量）, session-cancel.backend.design.md#3.5 质量实现方案, session-cancel.backend.design.md#2.5 验收条件
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001, runtime-isolation-and-security#RULE-runtime-security-001, runtime-isolation-and-security#RULE-runtime-secret-file-mode-001, runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: B-01, B-02, B-03

### Description

实现 `session-process-sweeper.mjs`：可注入 `procRoot` 的 /proc 扫描、精确 `MUAD_SESSION_KEY` 匹配、UID 校验、指纹生成与复核、TERM→等待→KILL。模块只负责进程发现与信号发送，不负责 abort run。

### Checklist

- [x] 实现 `scanSessionProcesses({procRoot, sessionKey, uid})`：遍历数字目录，读取 environ/status/stat/cmdline，跳过 PID 1/self/不可读项
- [x] 实现 `fingerprint(sessionKey, pid, pgid, startTime, uid)`（sha256 前 16 hex）
- [x] 实现 `terminateConfirmed(candidates, expected)`：逐项复核指纹后 TERM→3s→复核→KILL→2s，返回 outcome/remaining
- [x] [B-01][unit] 用 fake procRoot 构造 PID 复用（同 pid、startTime 变化），断言不发信号且计入 skipped
- [x] [B-02][unit] 构造 UID 不匹配、environ EPERM、cmdline 为空，断言全部跳过且不抛错
- [x] [B-03][unit] 构造匹配的非组长进程，断言只对 pid 发信号、不调用 group kill
- [x] [RULE-runtime-directory-001][verifier] 断言新模块位于 `tools/muad-runtime-guard/src/` 且同目录存在测试；运行 `node --test tools/muad-runtime-guard/test/session-process-sweeper.test.mjs`
- [x] [RULE-runtime-security-001][verifier] 断言扫描/日志不读取或输出 environ 原值、凭证；测试中断言日志只含 pid/pgid/计数
- [x] [RULE-runtime-secret-file-mode-001][verifier] 断言本模块不调用 `writeFile`/`mkdir` 落盘任何配置或凭证；`rg "writeFile|mkdir" tools/muad-runtime-guard/src/session-process-sweeper.mjs` 为空
- [x] [RULE-runtime-config-001][verifier] 断言本任务不触碰 runtime 配置渲染/apply：`git diff --stat` 不含 `bin/`、`runtimeconfig`、`runtimeapply`；模块只读 /proc 与发送信号
- [x] [RULE-runtime-validate-before-write-001][verifier] 断言本模块不物化 runtime config、不写 generation；`rg "validateRuntimeConfig|runtime-config-transaction|writeFile" tools/muad-runtime-guard/src/session-process-sweeper.mjs` 为空
- [x] 运行 `node --test tools/muad-runtime-guard/test/session-process-sweeper.test.mjs` 并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| B-01 | unit | fake procRoot 文件系统 | startTime 不一致时 `skipped` 包含该 pid，`kill` 未被调用 | `test/session-process-sweeper.test.mjs` / pid-reuse | `["node","--test","tools/muad-runtime-guard/test/session-process-sweeper.test.mjs"]` | pass | verified |
| B-02 | unit | fake procRoot 文件系统 | 非目标 UID/EPERM 不进入 candidates，计数正确 | 同上 / owner-and-permission | 同上 | pass | verified |
| B-03 | unit | fake procRoot + 注入 kill 函数 | 非组长只调用 `kill(pid)`，不调用 `kill(-pgid)` | 同上 / non-leader | 同上 | pass | verified |

### Acceptance Evidence

> 编码期填写 RED/GREEN 结果、断言位置与真实组件证据。

- RED：`node --test tools/muad-runtime-guard/test/session-process-sweeper.test.mjs` → `ERR_MODULE_NOT_FOUND`（`src/session-process-sweeper.mjs` 尚不存在），0 pass / 1 fail。
- GREEN：同一命令 13/13 pass。B-01 `startTime` 变化 → `processes=[{pid:4028,outcome:"skipped",reason:"identity_changed"}]` 且 `signals=[]`；B-02 UID 不匹配/EPERM/空 cmdline/PID1/self 全部跳过且计数 `{notOwner:1, permissionDenied:1, emptyCmdline:1, protected:2}`；B-03 非组长信号序列 `[[600,"SIGTERM"],[600,"SIGKILL"]]`（无 `-500`），组长为 `[[-700,"SIGTERM"],[-700,"SIGKILL"]]`；SIGKILL 后仍存活时 `remaining=[pid]`、`killed=0`，不伪报成功。
- 断言位置：`tools/muad-runtime-guard/test/session-process-sweeper.test.mjs`（pid-reuse / owner-and-permission / non-leader / leader / remaining / logs 用例）。
- verifier：`rg "writeFile|mkdir|console\.(log|warn|error)" tools/muad-runtime-guard/src/session-process-sweeper.mjs` 无输出；日志断言仅含 `[muad-runtime-guard][session-cancel]` 前缀与 pid/pgid/outcome/reason/计数，不含 sessionKey、environ 值或 cmdline。
- 回归：新增模块零依赖；guard 非 E2E 单测 277 项中 261 pass / 14 fail，失败均为 worktree 未安装 `bash-parser`、缺少 `tsc` 的环境缺失（与本次新增文件无关）；E2E 场景按 Acceptance Coverage 由 TASK-006 执行。
- B-01: verified — automated command passed; run_id=4f1e92d7a6564db8b596bdbb16a1acd3 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=4f1e92d7a6564db8b596bdbb16a1acd3 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=4f1e92d7a6564db8b596bdbb16a1acd3 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-17] started
- [2026-10-18] resumed (in-progress)
- [2026-10-18] completed (done)

---

## TASK-002: Guard session-cancel RPC 与能力注册

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: session-cancel.backend.design.md#3.4 接口设计（RPC）, session-cancel.backend.design.md#3.2 架构设计（模块落点）, session-cancel.backend.design.md#5.2 风险识别
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001, runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: E-02, B-04

### Description

实现 `session-cancel-rpc.mjs` 与 `session-cancel-controller.mjs`，注册 `muad.session.preview` / `muad.session.cancel`（operator.write），复用 `loadNativeCancelRuntime` 做 abort/drain；在 `index.mjs` 注册、在 `health.mjs` 上报 `sessionCancel`。preview 只读；cancel 的 `expected` 可为空（为空时只 abort run），非空时只处理指纹匹配项。

### Checklist

- [x] 实现 preview：校验 sessionKey 形态、拒绝 `:longtask:`、返回 activeRun + sweeper 候选 + skipped
- [x] 实现 cancel：校验 expected（空数组合法，只 abort run）；调用 native abort/drain；调用 sweeper 终止确认；返回 aborted/drained/killed/remaining
- [x] 能力：仅当 native runtime 可用时 `available=true, version=1`；失败时明确 `reason`
- [x] 在 `index.mjs` 用 `registerGatewayMethod(..., { scope: "operator.write" })` 注册两个方法
- [x] 在 `health.mjs` 增加 `sessionCancel`
- [x] [E-02][integration] RPC cancel 传入过期指纹，断言只跳过、不发信号，返回 41009 判定所需字段
- [x] [B-04][unit] 断言 longtask key/PID 1/self 被拒绝或跳过
- [x] [RULE-runtime-skill-001][verifier] 断言取消 RPC 未注册为模型工具（`api.registerTool` 无新增），且不改变 Skill 激活/分层路径；运行既有 skill 测试
- [x] [RULE-runtime-skill-layering-001][verifier] `git diff --stat` 断言 `skills/` 与分层解析代码无改动；既有 layering 测试保持绿色
- [x] [RULE-runtime-log-injection-001][verifier] 断言新模块仅通过注入的 `log` 回调输出；`rg "console\\.(log|warn|error)" tools/muad-runtime-guard/src/session-cancel-*.mjs` 为空
- [x] [RULE-runtime-log-prefix-001][verifier] 断言日志行含 `[muad-runtime-guard][session-cancel]` 前缀；测试中捕获 log 断言
- [x] [RULE-runtime-skill-fail-loud-001][verifier] 断言本任务未新增/修改任何 Skill 脚本；`git diff --stat -- skills/` 为空
- [x] 运行 `node --test tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs tools/muad-runtime-guard/test/session-cancel-registration.test.mjs`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-02 | integration | RPC handler + fake procRoot | 过期指纹进入 skipped，`killed=0`，无信号调用 | `test/session-cancel-rpc.test.mjs` / stale-preview | `["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"]` | verified |
| B-04 | unit | RPC 参数校验 | longtask key 返回 invalid；PID 1/self 不在 candidates | `test/session-cancel-rpc.test.mjs` / rejected-targets | `["node","--test","tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs"]` | verified |

### Acceptance Evidence

- RED：`node --test tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs tools/muad-runtime-guard/test/session-cancel-registration.test.mjs` → `ERR_MODULE_NOT_FOUND`（`src/session-cancel-rpc.mjs` 尚不存在），0 pass / 2 fail。
- GREEN：`node --test tools/muad-runtime-guard/test/session-cancel-rpc.test.mjs` → 11/11 pass；追加注册测试后 `node --test ...session-cancel-rpc.test.mjs ...session-cancel-registration.test.mjs` → 14/14 pass。
- E-02 证据：预览后同 pid 的 `startTime` 由 111 变为 222，cancel 返回 `processes=[{pid:4028,outcome:"skipped",reason:"fingerprint_mismatch"}]`、`killed=0`、`signals=[]`，但 run 级 abort/drain 仍执行（`sessionId=run-1`）；进程退出后取消返回 `outcome:"skipped",reason:"not_found"`，同样不发信号。输出含 `processes[].outcome/reason` 与 `killed/remaining`，足够 TASK-004 判定 41009。
- B-04 证据：`agent:*:longtask:*`、含 `:longtask:` 段、未知 agent、段数不符、超长 key 均返回 `{ok:false,reason:"invalid_session_key"}`；`expected` 为空/含 PID 1/指纹格式非法返回 `invalid_expected`；fake procRoot 中的 PID 1 与 self(999) 不出现在 preview candidates，cancel 中 self 以 `outcome:"skipped",reason:"protected"` 上报且无信号。
- 能力证据：注册后 health 为 `sessionCancel:{available:false,version:0,reason:"native_unavailable"}`；动态加载失败后 `reason:"sdk_unavailable"`；注入能力后 `{available:true,version:1,reason:""}`。两个 RPC 均以 `operator.write` 注册，`registration.tools` 仍只有 `muad_submit_long_task`。
- verifier：`rg "console\\.(log|warn|error)|writeFile|mkdir" tools/muad-runtime-guard/src/session-cancel-*.mjs` 无输出；日志断言全部以 `[muad-runtime-guard][session-cancel]` 开头，不含 sessionKey、requestedBy、environ/凭证或 cmdline；`git diff --stat -- skills/` 为空。
- 回归：`node --test test/skill-hooks... skill-trace.test.mjs plugin-health.test.mjs` 84/84 pass；guard 全量 `node --test tools/muad-runtime-guard/test/*.test.mjs` 339 pass / 2 skipped / 0 fail（补齐 worktree 本地 `bash-parser`、`typescript` 依赖后运行，依赖安装未进入提交）。
- E-02: verified — automated command passed; run_id=8d0a2d1a0584433b8113f8f0e9f4f2fb (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=8d0a2d1a0584433b8113f8f0e9f4f2fb (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-18] started
- [2026-10-18] implemented session-cancel RPC/controller, capability registration, health sessionCancel; E-02/B-04 passed
- [2026-10-18] completed (done)

---

## TASK-003: Console gateway 适配器与能力缓存

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: session-cancel.backend.design.md#3.2 架构设计（模块落点）, session-cancel.backend.design.md#3.4 接口设计（错误码）, session-cancel.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-directory-structure#RULE-backend-directory-001, backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001
- **Acceptance-Refs**: S-04, E-05

### Description

新增 `internal/gateway/session_cancel.go`，用 `Driver.Exec` 调 `openclaw gateway call muad.session.preview|cancel --json`，带 context deadline 与稳定错误映射；把能力缓存泛化为同时保存 longtask 与 session-cancel 能力，并在 `probe.go` / `collector.go` 解析与写入。

### Checklist

- [x] 实现 `PreviewSessionCancel` / `CancelSessionCancel` 适配器（10s / 20s deadline）
- [x] 解析 health `sessionCancel` 字段；泛化 `CancelCapabilityCache`（保留 longtask 语义）
- [x] collector 探活时同时更新两类能力；能力过期/未知返回 ok=false
- [x] [S-04][integration] 断言 health 上报 → cache 命中 → 过期后 ok=false
- [x] [E-05][integration] 断言 RPC 超时/不可解析映射为 41010，不伪报成功
- [x] [RULE-backend-quality-001][verifier] 运行 `go -C console/backend vet ./...` 与 `go -C console/backend test ./internal/gateway ./internal/collector -run "SessionCancel" -count=1`，断言 Exec 有 context deadline、错误显式返回
- [x] [RULE-backend-directory-001][verifier] 断言新增文件位于 `console/backend/internal/gateway/`，未新增跨层依赖；`go list -deps ./internal/api` 无循环
- [x] [RULE-backend-database-001][verifier] 断言本任务未新增/修改任何 SQL 与 schema：`git diff --stat` 不含 `internal/repo/`；新增文件无 `db.Query`/`db.Exec`
- [x] [RULE-backend-no-select-star-001][verifier] 断言新增/修改代码无 `SELECT *`：`rg "SELECT \\*" console/backend/internal/gateway console/backend/internal/collector` 为空
- [x] 运行 `go -C console/backend test ./internal/gateway ./internal/collector -run "SessionCancel" -count=1`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | integration | probe JSON → cache → lookup | available/version 正确；TTL 过期后 ok=false | `internal/gateway/session_cancel_test.go` | `["go","-C","console/backend","test","./internal/gateway","./internal/collector","-run","SessionCancel","-count=1"]` | passed | verified |
| E-05 | integration | gateway Exec fake | 超时/坏 JSON → ErrSessionCancelFailed | `internal/gateway/session_cancel_test.go` | 同上 | passed | verified |

### Acceptance Evidence

- [2026-10-18] RED: `go -C console/backend test ./internal/gateway ./internal/collector -run "SessionCancel" -count=1` → build failed（undefined: `PreviewSessionCancel` / `NewCancelCapabilityCache` / `Collector.updateCapabilities`）。
- [2026-10-18] GREEN: 同一命令 → `ok internal/gateway 0.091s`、`ok internal/collector 0.267s`（exit 0）。
- [2026-10-18] 回归: `go -C console/backend vet ./...` exit 0；`go -C console/backend test ./internal/gateway ./internal/collector ./internal/api ./test -count=1` 全 ok；`go -C console/backend test ./... -count=1` 全 ok（含长任务取消 API/列表回归）。
- [2026-10-18] `go -C console/backend list -deps ./internal/api` exit 0（无循环依赖）；新增文件仅位于 `console/backend/internal/gateway/` 与 `console/backend/internal/collector/`。
- S-04: verified — automated command passed; run_id=f6b8ab441e7f47d48821333eaa7dc0cc (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=f6b8ab441e7f47d48821333eaa7dc0cc (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-17] started
- [2026-10-18] implemented: gateway session-cancel adapter, generalized CancelCapabilityCache, health sessionCancel parsing, collector wiring; S-04/E-05 passed
- [2026-10-18] resumed (in-progress)
- [2026-10-18] completed (done)

---

## TASK-004: Console API、错误码与审计

- **Status**: done
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
| S-05 | integration | handler → repo audit | 审计含 pod/user/agent/sessionKey/计数；无 cmdline 原文 | `test/session_cancel_api_test.go` | `["go","-C","console/backend","test","./internal/api","./test","-run","SessionCancel","-count=1"]` | verified |
| E-01 | integration | handler → gateway fake | 空 preview 返回 processes=[]，code=0 | 同上 | 同上 | verified |
| E-03 | integration | handler → capability cache | 未知/过期 → 41007，无 Exec 调用 | 同上 | 同上 | verified |
| E-04 | integration | handler → repo | 归属不符 → 404；longtask → 400；无 RPC 调用 | 同上 | 同上 | verified |

### Acceptance Evidence

> 编码期填写。
- S-05: verified — automated command passed; run_id=3e66ea28c8dd4a2eb4d3bdbf2f96f1de (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=3e66ea28c8dd4a2eb4d3bdbf2f96f1de (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=3e66ea28c8dd4a2eb4d3bdbf2f96f1de (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=3e66ea28c8dd4a2eb4d3bdbf2f96f1de (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-18] started
- [2026-10-18] completed (done)

---

## TASK-005: 前端会话终止交互与数据层

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: session-cancel.frontend.design.md#3.3 组件设计, session-cancel.frontend.design.md#3.4 组件接口契约, session-cancel.frontend.design.md#3.5 状态与数据流, session-cancel.frontend.design.md#3.6 UI 状态
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001, frontend-component-specs#RULE-frontend-semi-shell-001, frontend-directory-structure#RULE-frontend-directory-001, frontend-directory-structure#RULE-frontend-api-types-001, frontend-quality-standards#RULE-frontend-quality-001, frontend-quality-standards#RULE-frontend-api-client-001, frontend-quality-standards#RULE-frontend-i18n-001
- **Acceptance-Refs**: S-09, S-10, E-07, E-08, E-09, E-10, E-11, B-06, B-07, B-08

### Description

在 `api.ts` / `types/api.ts` 增加 preview/cancel 方法与类型；新增 `SessionCancelDialog`（容器）与展示组件；在 `IdentityManager` 行操作接入；完成 zh/en 文案与四态处理。弹窗先预览、再二次确认，确认只提交预览中的指纹。

### Checklist

- [x] `api.ts` 增加 `previewSessionCancel` / `cancelSession`，类型放 `types/api.ts`
- [x] 新增 `SessionCancelDialog.tsx` + CSS：预览摘要、进程表（PID/PGID/组长/时长/命令）、危险确认、结果表
- [x] IdentityManager 行操作打开弹窗；确认中禁止重复提交；关闭后复位
- [x] UI 四态：loading / empty / error（41007/41008/41009/41010）/ success
- [x] 41009 提供"重新预览"；skipped/remaining 明确展示
- [x] 所有文案走 i18n（zh/en）
- [x] [S-09][integration] 空集合空态 + 确认禁用
- [x] [S-10][integration] skipped/remaining 展示
- [x] [E-07..E-11][integration] 四类错误与重复提交
- [x] [B-06][unit] 断言 cmdline 超过 200 字符时截断展示
- [x] [B-07][unit] 断言 run active 且进程为 0 时确认按钮可用
- [x] [B-08][unit] 断言 skipped 计数文案与"非目标进程"说明展示
- [x] [RULE-frontend-component-001][verifier] 断言 props 强类型、展示组件无网络 IO、列表 `rowKey=pid`；`npm -C console/frontend run check` 通过
- [x] [RULE-frontend-semi-shell-001][verifier] 断言使用 Semi Modal/Table/Button/Tag/Toast，未引入其他 UI 库；代码审查 + lint
- [x] [RULE-frontend-directory-001][verifier] 断言所有 HTTP 经 `src/api.ts`；`rg "fetch\\(|axios" console/frontend/src/components/human-users` 为空
- [x] [RULE-frontend-api-types-001][verifier] 断言新类型在 `src/types/api.ts` 并由 `api.ts` re-export；`tsc --noEmit` 通过
- [x] [RULE-frontend-quality-001][verifier] 运行 `npm -C console/frontend run check`（tsc + eslint + prettier + vitest），断言四态与错误处理覆盖
- [x] [RULE-frontend-api-client-001][verifier] 断言 `/api/v1` 前缀、`code===0` 解包、401 处理均复用 api.ts；组件测试 mock api.ts
- [x] [RULE-frontend-i18n-001][verifier] 断言组件文案全部走 `useTranslation`；`rg "[一-龥]" src/components/human-users/SessionCancelDialog.tsx` 仅允许注释/测试
- [x] 运行 `npm -C console/frontend run test -- test/SessionCancelDialog.test.tsx`

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-09 | integration | api.ts mock → UI | 空态文案 + 确认禁用 | `test/SessionCancelDialog.test.tsx` | `["npm","-C","console/frontend","run","test","--","test/SessionCancelDialog.test.tsx"]` | verified |
| S-10 | integration | api.ts mock → UI | skipped/remaining 可见，不显示全成功 | 同上 | 同上 | verified |
| E-07 | integration | api.ts mock → UI | 41007 文案 + 确认禁用 | 同上 | 同上 | verified |
| E-08 | integration | api.ts mock → UI | 41009 提示 + 重新预览 | 同上 | 同上 | verified |
| E-09 | integration | api.ts mock → UI | 41008/41010 错误 Banner | 同上 | 同上 | verified |
| E-10 | integration | UI | 连点只发一次请求，按钮 loading | 同上 | 同上 | verified |
| E-11 | integration | api.ts mock → UI | 预览失败显示错误而非空态 | 同上 | 同上 | verified |
| B-06 | unit | 展示组件 | cmdline 截断 200 | 同上 | 同上 | verified |
| B-07 | unit | 展示组件 | run active + 0 进程时确认可用 | 同上 | 同上 | verified |
| B-08 | unit | 展示组件 | skipped 计数文案 | 同上 | 同上 | verified |

### Acceptance Evidence

- RED：`npm -C console/frontend run test -- test/SessionCancelDialog.test.tsx` → `Failed to resolve import ".../SessionCancelDialog"`，0 test / 1 suite failed。
- GREEN：同一命令 → 11/11 pass（1 file）。`npm -C console/frontend run check` → tsc/eslint/prettier 全通过，vitest 28 files / 222 tests pass。
- S-09：preview 返回 `activeRun.active=false, processes=[]` → 文案"没有正在运行的任务或后台进程"可见，确认按钮 disabled，未调用 cancel。
- S-10：cancel 返回 `killed=1, remaining=[5001]` 且一条 `skipped/permission_denied` → 结果区显示"已终止 1 个进程""未退出进程：5001""已跳过""权限不足"，Toast 为 `会话任务已处理，但部分进程未终止`，不出现"会话任务已终止"；只提交 `[{pid:4028,fingerprint:"fp-a"}]`。
- E-07：preview 抛 41007 → "当前 Worker 不支持会话终止"，确认按钮 disabled。
- E-08：cancel 抛 41009 → 提示"进程列表已变化，请重新预览"且确认禁用；点击"重新预览"后二次 preview 成功、错误清除、按钮恢复可用。
- E-09：cancel 抛 41008 / 41010 → 分别展示"会话或身份不存在""会话终止失败" Banner，无成功 Toast。
- E-10：确认按钮连点两次 → `cancelSession` 仅调用 1 次，按钮进入 loading/disabled。
- E-11：preview 抛普通错误 → 展示"读取会话运行状态失败"+重试，不出现空态文案；重试后渲染会话摘要。
- B-06：250 字符 cmdline → 仅渲染前 200 字符 + 省略号，`TAIL-MARKER` 原文不出现。
- B-07：`activeRun.active=true, processes=[]` → 确认按钮可用，警告文案"将中止活跃 run。此操作不可撤销。"。
- B-08：`skipped={notOwner:1, envMismatch:2, permissionDenied:0}` → "已跳过 3 个非目标进程"+非目标进程说明可见。
- verifier：`rg "fetch\(|axios" console/frontend/src/components/human-users` 无输出；`rg "[一-龥]" console/frontend/src/components/human-users/SessionCancelDialog.tsx` 无输出；进程/结果表均 `rowKey="pid"`；新 DTO 位于 `src/types/api.ts`，`api.ts` 通过 `export type *` re-export；两个方法复用 `request`（`/api/v1`、`code===0` 解包、401 处理）。
- 遗留：B-07 的"仅中止 run（0 进程）"与后端非空 `expected` 约束冲突；已在 2026-10-18 的对齐修复中统一为"空 `expected` 合法、只 abort run"，并补 guard/gateway/API 测试。
- S-09: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- E-07: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- E-08: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- E-09: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- E-10: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- E-11: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- B-06: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- B-07: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- B-08: verified — automated command passed; run_id=ee287fa842a34f0389e4ce04ecaf1cf7 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-07: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-08: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-09: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-10: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-11: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-06: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-07: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-08: verified — automated command passed; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-18] started
- [2026-10-18] implemented types/api methods, SessionCancelDialog + CSS, IdentityManager row action, zh/en i18n; S-09/S-10/E-07..E-11/B-06..B-08 passed
- [2026-10-18] completed (done)

---

## TASK-006: E2E 隔离、解锁与结果验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005
- **Source**: session-cancel.backend.design.md#2.5 验收条件, session-cancel.frontend.design.md#2.4 验收条件, session-cancel.backend.design.md#5.2 风险识别
- **Spec-Refs**:
- **Acceptance-Refs**: S-01, S-02, S-03, S-06, E-06, B-05, S-07, S-08

### Description

在真实 Pod 上执行端到端验证，重点验证单 Pod 多用户隔离与终止后解锁。前置条件：同一 Pod 上至少两个 Human User（A/B），各自能在企微触发 `slow-foreground-smoke`；管理员可访问 Console 用户详情。

### Checklist

- [x] 准备 A/B 两个用户与各自会话，同时启动 180 秒慢任务
- [x] [S-01][E2E] A 的 preview 只包含 A 的 `sh -c` + `python3`，不含 B/gateway
- [x] [S-02][E2E] cancel 后 A 的 run 中止、进程退出、审计落库
- [x] [S-03][E2E] A 被终止后 B 的进程仍在、B 的会话仍能回复；gateway PID 不变（真实边界：/proc、gateway、企微）
- [x] [S-06][E2E] cancel 后 A 发新消息 10 秒内得到回复（chat.send 实测）；企微 per-chat 队列排空待真实 IM 复核
- [x] [E-06][E2E] 用忽略 SIGTERM 的测试脚本验证 TERM→KILL 升级与 remaining 上报
- [ ] [B-05][E2E] 企微队列中的排队消息在 abort 后按序排空，不丢消息（需真实企微消息，延后到 verify-e2e）
- [ ] [S-07][E2E] 用户详情 → 行操作 → 预览弹窗内容正确（浏览器 E2E 延后；组件测试 11/11 覆盖）
- [ ] [S-08][E2E] 确认后结果表与 Toast 正确，弹窗可关闭（浏览器 E2E 延后；组件测试 11/11 覆盖）
- [x] 记录证据（Pod、sessionKey、pid、命令输出、日志片段）到 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | Console API、Gateway、真实 /proc | 预览只含目标会话进程 | manual runbook | - | e2e_deferred |
| S-02 | E2E | API、RPC、真实信号 | run 中止 + 进程退出 + 审计 | manual runbook | - | e2e_deferred |
| S-03 | E2E | 双 agent、真实 /proc、gateway | A 进程消失、B 进程存活、B 可回复、gateway 存活 | manual runbook | - | e2e_deferred |
| S-06 | E2E | 企微通道、队列 | 新消息 10s 内回复 | manual runbook | - | e2e_deferred（会话解锁已验证；企微队列待真实 IM） | e2e_deferred |
| E-06 | E2E | 真实信号 | 忽略 TERM 的进程被 KILL，remaining 正确 | manual runbook | - | e2e_deferred |
| B-05 | E2E | 企微队列 | 排队消息按序处理，无丢失 | manual runbook | - | e2e_deferred（需真实企微消息） | e2e_deferred |
| S-07 | E2E | 浏览器、路由、API | 弹窗内容与进程清单一致 | manual runbook | - | e2e_deferred（组件测试覆盖） | e2e_deferred |
| S-08 | E2E | 浏览器、API、Worker | 结果展示与关闭行为正确 | manual runbook | - | e2e_deferred（组件测试覆盖） | e2e_deferred |

### Acceptance Evidence

- 环境：Pod `muad-oc-pod03-55ccccb75c-rvzw5`，镜像 `muad-openclaw:sessioncancel-e2e`，config generation 147；`muad.runtime.health` 返回 `sessionCancel: {available: true, version: 1}`。
- 双用户：A `john-24c84418`（session `agent:john-24c84418:wecom:direct:e2e-a`）；B `e2e-bob`（Console 临时创建，session `agent:e2e-bob:wecom:direct:e2e-bob`，测试后已删除）。
- S-01：A 的 preview 返回 `activeRun.active=true`、2 个进程（pid 597 `sh -c` 组长 / pid 598 `python3`，pgid 597），`skipped.envMismatch=3`；B 的 preview 只返回 pid 367 `sleep 300`（pgid 367），不含 A/gateway。
- 2026-10-18 修复：真实 WeCom 会话 key 的 peer 是 identityLinks 的 canonical key（agentId），不是 externalId。修复 `deriveSessionKey`（direct → agentId）后，对真实 run `dad588a0-3242-4ac7-9bd1-ae362a520362` 的 Console preview 返回 `agent:john-24c84418:wecom:direct:john-24c84418` 及 pid 2424/2425，activeRun=true；修复前同一请求返回空进程且 activeRun=false。
- S-02：对 A 调用 `muad.session.cancel`（expected 指纹 597/598）→ `aborted=true, drained=true, confirmed=true`；abort/drain 已使两个进程退出，sweeper 报告 `killed=0`（not_found）；随后 Console API 对 john 真实身份 `...wojmppeqaak5ytes5hexbxkosm1bot5w` 的 preview/cancel 实测 `killed=1, terminated/sigterm`，审计记录 id 1389（无 cmdline）。
- S-03：A 终止后 B 的 pid 367 仍存活；gateway PID 1 存活；B 的 preview/cancel 后续正常，证明未跨用户误杀。
- S-06：A 终止后通过 `chat.send` 发送"现在几点"，run `b6e22997` 在约 10 秒内返回 `00:22:18（2026-10-18，CST）`，会话未阻塞。企微 per-chat 队列排空未用真实 IM 复核，保留为 e2e_deferred。
- E-06：session A 下启动 `trap "" TERM; sleep 120`；cancel 返回 pid 862 `killed/sigkill`、pid 863 `terminated/sigterm`，`remaining=[]`，`ps` 确认两个进程消失。
- 空 expected 安全验证：对 B 调用 `expected: []` → `killed=0`，pid 367 以 `skipped/not_expected` 上报且仍存活，证明空列表只 abort run、不杀进程。
- B-05 / S-07 / S-08：企微真实消息队列排空与浏览器 UI 流程需真实 IM/浏览器，组件测试 `SessionCancelDialog.test.tsx` 11/11 通过，E2E 延后到 verify-e2e。
- S-01: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- E-06: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- B-05: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-07: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=cc82033a2f104ffbbce73f3ef0a3426a (confirmed_by: runner)
- S-01: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- E-06: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- B-05: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-07: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=2c185efe2e1e42dc954b391f61a04b8d (confirmed_by: runner)

### Log

- [2026-10-17] created (draft)
- [2026-10-18] started
- [2026-10-18] completed (done)

# Tasks: 长任务执行防误触发与控制台终止

- **Source**: long-task-control.backend.design.md, long-task-control.frontend.design.md（均为 v1.0，已批准）
- **Created**: 2026-10-15
- **Updated**: 2026-10-16
- **Plan Authorization**: 用户明确指示“定稿，开始拆分任务”；本文件落实该任务拆解指令。各任务初始为 draft，未记录代码或测试已完成。

## Proposal

保持唯一明确匹配且参数齐全直接执行、多候选由用户选择，修复前台脚本拦截遗漏；控制台支持取消排队和终止运行中的目标任务。真实停止和资源清理完成后才标记已取消，失败任务不增加重试按钮，取消不影响其他任务或普通聊天。

执行链依次覆盖固定版本接口核对、命令防护、运行与状态持久化、投递仲裁、控制台 API/交互及真实端到端验收。上游取消契约未确认时保留阻塞，不以数据库改状态或 kill CLI 兜底。

## 执行约定

- 本轮只定稿设计和拆分任务；本文件的所有新用例、文件名和命令均为待实现契约，不表示当前存在或执行通过。
- 每项以 1–3 个实现文件及配套测试为目标；依赖清单/锁文件、插件注册或 API 贯通处列出必要关联文件。若实现跨越独立职责，执行前继续细拆，不以超过范围的单次改动完成。
- functional（unit/integration）先写有行为断言的失败测试、记录 RED，再实现并记录 GREEN；不得用测试名零匹配、加载空模块或镜像实现的断言冒充通过。
- 原设计 20 个场景原级别保留；新增 S-11～S-28 为局部 functional 验收，不替代原设计 13 个真实 E2E。局部可控通知/Gateway 依赖仅用于局部模块断言。
- E2E 在编码期只编写和登记，不执行 RED/GREEN；全部 functional 通过后统一由 cf-task-verify-e2e 执行。需要真实模型、固定版 Worker、真实浏览器及收件端的边界不得 Mock。
- 原 Spec 的 manual verifier 类型、owner 及 code/review 阶段保持不变；责任 TASK 收集规则对应命令/差异/断言证据，最终人工规则确认按原门禁办理，不由 Agent 代签。Contract 中局部 integration 检查不替代 manual 确认。
- 每个验收场景和 required Rule 都只有一个最终责任 TASK；其他任务通过 Depends 协作，不复制最终所有权。任务合同中标明的规范 verifier 使用现有 Context，禁止重新从 Catalog 选规。
- 保留已有未提交的 .code-flow/tasks/2026-10-10/ 需求及其他工作区变更。未选择 active TASK，不启动编码，不创建镜像或部署。
- 普通功能测试超时 120 秒，E2E harness 上限 3600 秒是执行预算而非业务 SLO；长时间用例按运行器分段观察，缺少隔离环境时明确失败，不跳过或伪造证据。

## 任务总览

| TASK | 内容 | Depends | 优先级 |
|---|---|---|---|
| TASK-001 | 核对固定版本取消接口与运行归属契约 | 无 | P0 |
| TASK-002 | 打包 Shell 解析依赖与 Worker 加载校验 | 无 | P0 |
| TASK-003 | 实现 Shell AST 命令与路径判定 | TASK-002 | P0 |
| TASK-004 | 接入可信工作目录与前台零提交拦截 | TASK-003 | P0 |
| TASK-005 | 收紧触发指导与可信显式名称检查 | 无 | P0 |
| TASK-006 | 扩充运行时取消状态与可靠持久化 | TASK-001 | P0 |
| TASK-007 | 迁移 SQLite 任务状态约束与取消字段 | 无 | P0 |
| TASK-008 | 实现任务镜像修订与终态合并 | TASK-007 | P0 |
| TASK-009 | 实现目标运行取消适配器 | TASK-001, TASK-006 | P0 |
| TASK-010 | 实现队列取消与完成竞争仲裁 | TASK-006, TASK-009 | P0 |
| TASK-011 | 取消期间关闭新工具并精确清理租约 | TASK-010 | P0 |
| TASK-012 | 停止取消任务的新进度与待发队列 | TASK-010 | P0 |
| TASK-013 | 将长任务结果投递纳入取消仲裁 | TASK-009, TASK-010, TASK-012 | P0 |
| TASK-014 | 注册内部取消 RPC 与 Worker 能力 | TASK-010, TASK-011, TASK-013 | P0 |
| TASK-015 | 封装 Go Gateway 取消调用与超时 | TASK-001 | P0 |
| TASK-016 | 定义取消 API 错误码与响应契约 | 无 | P0 |
| TASK-017 | 接入控制台取消路由、鉴权与操作审计 | TASK-008, TASK-015, TASK-016 | P0 |
| TASK-018 | 扩充快照、列表状态和按 Pod 能力缓存 | TASK-008, TASK-014, TASK-017 | P0 |
| TASK-019 | 补齐前端取消 DTO 与统一 API 客户端 | TASK-016 | P0 |
| TASK-020 | 实现任务行取消与终止操作组件 | TASK-019, TASK-022 | P0 |
| TASK-021 | 接入动作 Hook、列表刷新与状态竞争 | TASK-018, TASK-019, TASK-020 | P0 |
| TASK-022 | 补齐中英文取消状态与交互文案 | 无 | P0 |
| TASK-023 | 准备隔离长任务与真实 E2E 观察工具 | TASK-001, TASK-005, TASK-014, TASK-018, TASK-021 | P0 |
| TASK-024 | 登记真实模型触发策略与截图场景回归 | TASK-004, TASK-005, TASK-023 | P0 |
| TASK-025 | 登记真实排队取消、运行终止与隔离恢复回归 | TASK-011, TASK-012, TASK-013, TASK-023 | P0 |
| TASK-026 | 登记真实浏览器、配置应用与兼容发布验收 | TASK-005, TASK-018, TASK-021, TASK-022, TASK-023 | P0 |

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 | 命令 | 工作目录 | 超时 |
|---|---|---|---|---|---|---|---|---|
| S-01 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 真实模型、Worker 工具、队列及脚本哨兵：唯一适用且完整输入，无额外确认，恰好执行一次 | TASK-024 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS01","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"] | . | 3600 |
| S-02 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 真实模型及 IM 入站：多个合理候选先列差异，选择前零执行，用户选择后仅执行所选 Skill | TASK-024 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS02","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"] | . | 3600 |
| S-03 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 使用本次截图等价请求，真实读取其他长任务文档后访问 company_label 测试接口；无关 Skill 零任务、零业务、零进度；不得接触真实客户业务 | TASK-024 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS03","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"] | . | 3600 |
| S-04 | long-task-control.backend.design.md#2.5 验收条件 | integration | 真实 guard、临时 Skill 文件和 Shell 解析：默认工作目录相对路径、cd、包装器、find -exec 被拒绝；普通 read/cat/ls/grep 查看通过；全程零提交 | TASK-004 | verified | ["node","--test","--test-name-pattern","LongTaskControlS04","tools/muad-runtime-guard/test/long-task-hooks.test.mjs"] | . | 120 |
| S-05 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 浏览器 → Console API → 真实 Worker 队列 → SQLite → 列表：取消排队任务后哨兵从未执行，最终 cancelled，排队数减少 | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS05","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |
| S-06 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 真实固定版本 Gateway、模型、长时间脚本及其子进程、收件观察器：终止后进程停止、业务计数不再增长、资源清理、无新结果投递，列表 cancelled | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS06","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |
| S-07 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 同用户另一个任务及另一用户真实任务继续运行；主会话可用；终止任务清理后执行槽恰好释放一次，下一项按原顺序启动 | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS07","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |
| S-08 | long-task-control.backend.design.md#2.5 验收条件 | E2E | Console 配置 → DTO/schema → generation 事务 → Worker health：能力与指导成功应用；故障健康检查触发回滚，无模型绑定或 Skill 分层改变 | TASK-026 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS08","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"] | . | 3600 |
| S-09 | long-task-control.frontend.design.md#2.4 验收条件 | integration | Testing Library、真实 hook 与 API 封装、HTTP 边界 stub：仅可取消 queued/running 有操作，cancelling 不可重复点击；succeeded/failed/cancelled 无重试按钮；关闭终止确认框不发请求 | TASK-021 | verified | ["npx","vitest","run","test/LongTasks.test.tsx","-t","LongTaskControlS09"] | console/frontend | 120 |
| S-10 | long-task-control.frontend.design.md#2.4 验收条件 | E2E | 真实浏览器、后端及 Worker：中英文切换后按钮/状态/错误/确认文案正确，按取消状态筛选、分页和正常后台轮询不闪表格 spinner | TASK-026 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS10","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"] | . | 3600 |
| S-11 | long-task-control.backend.design.md#3.2 架构设计 | integration | 固定 OpenClaw 2026.7.1 已安装分发物的公开接口、真实可销毁本地子进程和归属句柄：记录取消方法/返回语义，拒绝将 CLI 退出当运行停止；不依赖 2026.7.2 或修改上游 | TASK-001 | verified | ["env","MUAD_LONG_TASK_CONTRACT=1","node","--test","--test-name-pattern","LongTaskControlS11","tools/muad-runtime-guard/test/long-task-cancel-contract.test.mjs"] | . | 120 |
| S-12 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实包清单/锁文件、隔离依赖安装及镜像复制布局：所选 Shell AST 解析器在 Worker 插件实际路径可加载，缺失依赖明确失败 | TASK-002 | verified | ["node","--test","--test-name-pattern","LongTaskControlS12","tools/muad-runtime-guard/test/long-task-command-package.test.mjs"] | . | 120 |
| S-13 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实 Shell AST 解析模块、临时脚本与 symlink：分辨管道/包装器/子命令及 find/awk 执行行为，普通查看不误判，解析不确定返回显式结果 | TASK-003 | verified | ["node","--test","--test-name-pattern","LongTaskControlS13","tools/muad-runtime-guard/test/long-task-command-policy.test.mjs"] | . | 120 |
| S-14 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实 renderer/preflight 与可信入站上下文：唯一自动、多候选选择、参考不授权；explicit_name 不接受模型伪造，现有授权和文档读取门禁保留 | TASK-005 | verified | ["node","--test","--test-name-pattern","LongTaskControlS14","bin/test/long-task-control-guidance.test.mjs"] | . | 120 |
| S-15 | long-task-control.backend.design.md#3.3 数据设计 | integration | 真实任务状态模块、0600 临时 JSONL 及恢复读取：revision 单调、取消请求可靠保存，旧记录兼容、写入失败显式且不伪造取消 | TASK-006 | verified | ["node","--test","--test-name-pattern","LongTaskControlS15","tools/muad-runtime-guard/test/long-task-cancel-state.test.mjs"] | . | 120 |
| S-16 | long-task-control.backend.design.md#3.3 数据设计 | integration | 真实 SQLite 旧表及 repo 迁移：新增状态/取消字段后行数、内容及索引保留，迁移可重复、失败事务回滚 | TASK-007 | verified | ["go","test","./internal/repo","-run","TestLongTaskControlS16","-count=1"] | console/backend | 120 |
| S-17 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实执行适配器、可控原生取消依赖、真实本地子进程：taskId/session/run 严格对应，abort 接受不等于已退出，不以杀 CLI 替代取消 Gateway | TASK-009 | verified | ["node","--test","--test-name-pattern","LongTaskControlS17","tools/muad-runtime-guard/test/long-task-run-controller.test.mjs"] | . | 120 |
| S-18 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实 manager、shared Skill/browser lease 和临时进度桥：取消期间不释放槽，确认停止后仅清理目标任务资源，下一任务启动且不重复释放 | TASK-011 | verified | ["node","--test","--test-name-pattern","LongTaskControlS18","tools/muad-runtime-guard/test/long-task-cancel-resources.test.mjs"] | . | 120 |
| S-19 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实 SkillProgressManager 与进度桥、可控通知发送边界：取消后拒绝迟到事件，丢弃未发起队列；在途记录可解释，终态消息最多一次 | TASK-012 | verified | ["node","--test","--test-name-pattern","LongTaskControlS19","tools/muad-runtime-guard/test/long-task-cancel-progress.test.mjs"] | . | 120 |
| S-20 | long-task-control.backend.design.md#3.2 架构设计 | integration | 真实结果解析和管理器投递控制、可控子进程流与通知边界：持续消费输出、保留附件/多段结果，取消与投递许可互斥且不再直接 --deliver | TASK-013 | verified | ["node","--test","--test-name-pattern","LongTaskControlS20","tools/muad-runtime-guard/test/long-task-cancel-delivery.test.mjs"] | . | 120 |
| S-21 | long-task-control.backend.design.md#3.4 接口设计 | integration | 真实插件 register/hooks/manager 与 host API spy：内部取消 RPC 仅 operator.write，绝不暴露为模型工具；身份不可信拒绝，能力仅在取消链完整时报告 | TASK-014 | verified | ["node","--test","--test-name-pattern","LongTaskControlS21","tools/muad-runtime-guard/test/long-task-cancel-registration.test.mjs"] | . | 120 |
| S-22 | long-task-control.backend.design.md#3.4 接口设计 | integration | 真实 Go Gateway 适配器与 fake Driver：argv/JSON 安全传递、context 超时、RPC 包络校验；不支持与未知停止明确区分 | TASK-015 | verified | ["go","test","./internal/gateway","-run","TestLongTaskControlS22","-count=1"] | console/backend | 120 |
| S-23 | long-task-control.backend.design.md#3.4 接口设计 | integration | 真实 errcode/errorCatalog/writeJSON/writeErr：取消场景稳定子码、中英文与 HTTP status 一致，202 仅表达已接受，包络兼容守卫 | TASK-016 | verified | ["go","test","./internal/api","-run","TestLongTaskControlS23","-count=1"] | console/backend | 120 |
| S-24 | long-task-control.backend.design.md#3.4 接口设计 | integration | 真实快照解码、Store、列表 DTO 与 Pod 能力缓存：兼容旧四状态，cancelling 占槽、cancelled 可筛选、能力未知不可取消；不同独占模型用户归属不串扰 | TASK-018 | verified | ["go","test","./test","-run","TestLongTaskControlS24","-count=1"] | console/backend | 120 |
| S-25 | long-task-control.frontend.design.md#3.5 状态与数据流 | integration | 真实 api.ts 客户端与 HTTP stub：cancel 请求路径/认证/语言正确、code 解包、202/终态结果类型、安全错误和 401 清 token 事件 | TASK-019 | verified | ["npx","vitest","run","test/api.test.ts","-t","LongTaskControlS25"] | console/frontend | 120 |
| S-26 | long-task-control.frontend.design.md#3.3 组件设计 | integration | Testing Library 真实 Semi 操作组件：queued 直接取消、running 确认后回调、关闭确认不提交；取消中禁用，所有终态无重试，键盘标签可达 | TASK-020 | verified | ["npx","vitest","run","test/LongTaskActions.test.tsx","-t","LongTaskControlS26"] | console/frontend | 120 |
| S-27 | long-task-control.frontend.design.md#3.8 可访问性与国际化 | integration | 真实 i18n 资源与 Semi 上下文：中英文状态/操作/确认/错误键成对存在，语言切换更新列及按钮，无页面重复 ConfigProvider | TASK-022 | verified | ["npx","vitest","run","test/LongTasks.i18n.test.tsx","-t","LongTaskControlS27"] | console/frontend | 120 |
| S-28 | long-task-control.backend.design.md#2.5 验收条件 | integration | 真实隔离 fixture 生成器、执行哨兵、结果观察断言及本地文件：伪造/缺失进程停止、缺失真实收件证据或未就绪环境不能验收成功；测试数据不含真实凭证 | TASK-023 | verified | ["node","--test","--test-name-pattern","LongTaskControlS28","tools/muad-runtime-guard/test/long-task-control-e2e-fixtures.test.mjs"] | . | 120 |
| E-01 | long-task-control.backend.design.md#2.5 验收条件 | E2E | Worker 不可达、RPC 超时或停止未确认：显示失败或终止中并保留诊断；不得伪报 cancelled、提前释放槽位或启动重试任务 | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE01","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |
| E-02 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 旧 Worker、缺失取消能力或重启后运行归属不可证明：返回明确不支持/无法确认，保留实际可知状态，不按历史 PID 盲杀 | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE02","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |
| E-03 | long-task-control.backend.design.md#2.5 验收条件 | integration | httptest → 真实 Store → fake Driver：未登录、伪造 Pod/Agent、越界 taskId、畸形请求均被拒绝且零运行调用；错误包络和审计脱敏正确 | TASK-017 | verified | ["go","test","./test","-run","TestLongTaskControlE03","-count=1"] | console/backend | 120 |
| E-04 | long-task-control.backend.design.md#2.5 验收条件 | integration | 真实 manager 和状态文件：取消记录写入失败时明确报错，不接受取消成功；隔离清理错误，不改写为成功 | TASK-010 | verified | ["node","--test","--test-name-pattern","LongTaskControlE04","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"] | . | 120 |
| E-05 | long-task-control.frontend.design.md#2.4 验收条件 | E2E | 实际 Worker 不可达或不支持取消，UI 显示明确原因而非成功；刷新不覆盖较新操作状态；权限失效回登录；不出现任务重试按钮 | TASK-026 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE05","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"] | . | 3600 |
| E-06 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 真实模型与隔离 Worker：无适用 Skill、仅缺用户必填输入、显式名称与本轮请求不一致时说明或追问；未完成预检前零入队、零业务脚本执行 | TASK-024 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE06","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"] | . | 3600 |
| B-01 | long-task-control.backend.design.md#2.5 验收条件 | integration | 可控执行屏障与真实 manager：queued 转 running、spawn 尚未发生及自然完成时请求取消，验证线性化规则和无双终态 | TASK-010 | verified | ["node","--test","--test-name-pattern","LongTaskControlB01","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"] | . | 120 |
| B-02 | long-task-control.backend.design.md#2.5 验收条件 | integration | 相同取消请求多次、RPC 返回丢失后重复请求：无重复终止、无重复终态通知、无重复释放资源 | TASK-010 | verified | ["node","--test","--test-name-pattern","LongTaskControlB02","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"] | . | 120 |
| B-03 | long-task-control.backend.design.md#2.5 验收条件 | integration | 真实 SQLite：重复及乱序快照、旧四状态记录、迁移重复执行，已取消/已完成状态不回退、不被自动改 failed，历史记录和索引保留 | TASK-008 | verified | ["go","test","./test","-run","TestLongTaskControlB03","-count=1"] | console/backend | 120 |
| B-04 | long-task-control.backend.design.md#2.5 验收条件 | E2E | 固定版本 Worker 重启时存在任务：取消墓碑保留，取消中的任务不恢复执行；孤儿运行只有归属证明且确认停止后才 cancelled | TASK-025 | verified | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlB04","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"] | . | 3600 |

## 规则与风险追溯

| 来源规则/风险 | 原设计场景 | 最终验收责任 |
|---|---|---|
| RULE-01、RISK-01 | S-01、S-02、S-03、E-06 | TASK-024 |
| RULE-02 | S-03、S-04 | TASK-024、TASK-004（按场景分别负责） |
| RULE-03、RISK-05 | S-06、S-07、E-03 | TASK-025、TASK-017（按场景分别负责） |
| RULE-04 | S-06、S-07、E-01 | TASK-025 |
| RULE-05 | B-01、B-02、B-03 | TASK-010、TASK-008（按场景分别负责） |
| RULE-06 | S-06、E-01、E-02 | TASK-025 |
| RISK-02 | S-06、E-02、B-04 | TASK-025；接口先验 TASK-001 |
| RISK-03 | S-06、B-01、B-02 | TASK-025、TASK-010（按场景分别负责） |
| RISK-04 | B-03、S-08 | TASK-008、TASK-026（按场景分别负责） |
| RISK-06 | E-01、E-04 | TASK-025、TASK-010（按场景分别负责） |
| RISK-F01 | S-06、S-09、E-05 | TASK-025、TASK-021、TASK-026（按场景分别负责） |
| RISK-F02 | S-10、B-03 | TASK-026、TASK-008（UI 协作 TASK-021） |
| RISK-F03 | E-05 | TASK-026 |
| RISK-F04 | S-09、E-05 | TASK-021、TASK-026（按场景分别负责） |

## Spec Responsibility

| required Rule | 唯一负责人 | verifier_ref | 原类型 / 阶段 |
|---|---|---|---|
| backend-code-quality-performance#RULE-backend-quality-001 | TASK-015 | backend-code-quality-performance#RULE-backend-quality-001 | manual / review |
| backend-code-quality-performance#RULE-backend-write-err-001 | TASK-016 | backend-code-quality-performance#RULE-backend-write-err-001 | regex / code |
| backend-database#RULE-backend-database-001 | TASK-007 | backend-database#RULE-backend-database-001 | manual / review |
| backend-database#RULE-backend-no-select-star-001 | TASK-007 | backend-database#RULE-backend-no-select-star-001 | regex / code |
| backend-directory-structure#RULE-backend-directory-001 | TASK-015 | backend-directory-structure#RULE-backend-directory-001 | manual / review |
| backend-logging#RULE-backend-logging-001 | TASK-017 | backend-logging#RULE-backend-logging-001 | manual / review |
| backend-logging#RULE-backend-redact-001 | TASK-017 | backend-logging#RULE-backend-redact-001 | manual / review |
| backend-platform-rules#RULE-backend-platform-001 | TASK-018 | backend-platform-rules#RULE-backend-platform-001 | manual / review |
| backend-platform-rules#RULE-backend-http-envelope-001 | TASK-016 | backend-platform-rules#RULE-backend-http-envelope-001 | test / code |
| backend-platform-rules#RULE-backend-model-pool-001 | TASK-018 | backend-platform-rules#RULE-backend-model-pool-001 | manual / review |
| frontend-component-specs#RULE-frontend-component-001 | TASK-020 | frontend-component-specs#RULE-frontend-component-001 | manual / review |
| frontend-component-specs#RULE-frontend-semi-shell-001 | TASK-020 | frontend-component-specs#RULE-frontend-semi-shell-001 | manual / review |
| frontend-directory-structure#RULE-frontend-directory-001 | TASK-019 | frontend-directory-structure#RULE-frontend-directory-001 | manual / review |
| frontend-directory-structure#RULE-frontend-api-types-001 | TASK-019 | frontend-directory-structure#RULE-frontend-api-types-001 | manual / review |
| frontend-quality-standards#RULE-frontend-quality-001 | TASK-021 | frontend-quality-standards#RULE-frontend-quality-001 | manual / review |
| frontend-quality-standards#RULE-frontend-api-client-001 | TASK-019 | frontend-quality-standards#RULE-frontend-api-client-001 | regex / code |
| frontend-quality-standards#RULE-frontend-i18n-001 | TASK-022 | frontend-quality-standards#RULE-frontend-i18n-001 | manual / review |
| runtime-config-and-apply#RULE-runtime-config-001 | TASK-005 | runtime-config-and-apply#RULE-runtime-config-001 | manual / review |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | TASK-005 | runtime-config-and-apply#RULE-runtime-validate-before-write-001 | manual / review |
| runtime-directory-structure#RULE-runtime-directory-001 | TASK-014 | runtime-directory-structure#RULE-runtime-directory-001 | manual / review |
| runtime-isolation-and-security#RULE-runtime-security-001 | TASK-014 | runtime-isolation-and-security#RULE-runtime-security-001 | manual / review |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | TASK-006 | runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | manual / review |
| runtime-skill-execution#RULE-runtime-skill-001 | TASK-011 | runtime-skill-execution#RULE-runtime-skill-001 | manual / review |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | TASK-005 | runtime-skill-execution#RULE-runtime-skill-layering-001 | manual / review |
| runtime-skill-execution#RULE-runtime-log-injection-001 | TASK-014 | runtime-skill-execution#RULE-runtime-log-injection-001 | manual / review |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | TASK-014 | runtime-skill-execution#RULE-runtime-log-prefix-001 | manual / review |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | TASK-013 | runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | manual / review |

## 终验与执行顺序

先做 TASK-001 固定版接口先验，再推进取消状态、运行控制和停止确认。命令防护、SQLite 迁移、HTTP 契约、前端客户端及语言资源可按依赖独立开发；共用同一文件的任务仍按 Depends/Owned Files 串行，DAG 批次不表示已获多 Agent 执行授权。

最长依赖链为 TASK-001 → TASK-006 → TASK-009 → TASK-010 → TASK-012 → TASK-013 → TASK-014 → TASK-018 → TASK-021 → TASK-023 → TASK-024/025/026，共 11 项；TASK-011 是 TASK-014 的另一项前置依赖。原 E2E 的执行统一留给 verify-e2e，不以登记用例或局部测试替代验收。发布/回滚说明由 TASK-026 整理，当前任务拆分不实施部署。

全量检查在需求终验按修改范围执行：Go test/vet、前端 npm run check、bin/runtime-guard Node 单测、原 Spec verifiers，再执行 13 个真实 E2E；无新改动或未解失败不重复扩大验证。

---

## TASK-001: 核对固定版本取消接口与运行归属契约

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#5. 风险与依赖
- **Spec-Refs**: 
- **Acceptance-Refs**: S-11
- **Owned Files**: `tools/muad-runtime-guard/test/long-task-cancel-contract.test.mjs`, `tools/muad-runtime-guard/long-task-cancel-contract.md`

### Description

先核对 2026.7.1 实际分发物的公开取消入口、运行身份和进程控制边界，给出执行适配器的可验证输入输出。此项不把模型或真实运行停止的最终 E2E 提前宣称通过。

### Checklist
- [x] 保存固定版本/分发物来源、公开导出、请求及确认语义，区分 run abort、CLI 退出和业务进程停止。
- [x] 用本地可销毁子进程和真实分发接口做局部契约断言；缺少目标版本或无可用公开接口时明确记录阻塞并回到设计，禁止借用新版接口或改上游。
- [x] [S-11][integration] 现有上游能力契约补测无合理功能 RED（未改生产代码）；实际执行指定命令，1 pass、0 skip，见契约文档。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-11 | integration | 固定 OpenClaw 2026.7.1 已安装分发物的公开接口、真实可销毁本地子进程和归属句柄：记录取消方法/返回语义，拒绝将 CLI 退出当运行停止；不依赖 2026.7.2 或修改上游 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-contract.test.mjs / LongTaskControlS11 | ["env","MUAD_LONG_TASK_CONTRACT=1","node","--test","--test-name-pattern","LongTaskControlS11","tools/muad-runtime-guard/test/long-task-cancel-contract.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-11 RED: N/A，现有 2026.7.1 公开能力契约补测，不修改生产行为，未伪造失败。
GREEN: 已执行 Contract 原命令，1 pass / 0 skip。断言位于 `long-task-cancel-contract.test.mjs` 的 verifyContract：公开导出/固定版本、真实 detached 子进程 close、错误句柄、其他会话隔离、drain 超时、未知运行。fixture 在无网络临时容器中创建并清理自己的进程及 SDK 注册表句柄；来源及能力边界见 `tools/muad-runtime-guard/long-task-cancel-contract.md`，未运行或宣称真实模型 E2E。
- S-11: verified — automated command passed; run_id=5156c349860b451191a5d8fe47b867aa (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-002: 打包 Shell 解析依赖与 Worker 加载校验

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: 
- **Acceptance-Refs**: S-12
- **Owned Files**: `tools/muad-runtime-guard/package.json`, `tools/muad-runtime-guard/package-lock.json`, `Dockerfile`, `tools/muad-runtime-guard/test/long-task-command-package.test.mjs`

### Description

为语法级命令判定选择并固定解析依赖，保证生产插件的实际加载路径与锁文件一致。

### Checklist
- [x] 核对包版本、许可证及 Node 兼容性，按现有镜像安装/复制流程固定运行依赖；不依赖开发机全局模块。
- [x] 增加实际插件路径加载 smoke；构建检查只在后续执行阶段按项目流程运行，本次计划不构建镜像。
- [x] [S-12][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-12 | integration | 真实包清单/锁文件、隔离依赖安装及镜像复制布局：所选 Shell AST 解析器在 Worker 插件实际路径可加载，缺失依赖明确失败 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-command-package.test.mjs / LongTaskControlS12 | ["node","--test","--test-name-pattern","LongTaskControlS12","tools/muad-runtime-guard/test/long-task-command-package.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-12 RED: 已执行 Contract 原命令；`manifest.dependencies['bash-parser']` 为 undefined，缺失锁定的生产解析依赖，测试失败（1 fail）。测试断言覆盖隔离插件目录中依赖缺失的明确失败、真实 npm ci 和解析加载及 Docker 复制路径。
S-12 GREEN: 已执行 Contract 原命令，1 pass / 0 fail。实现：`package.json` 固定 `bash-parser@0.5.0`（MIT，Node v24.17.0 实测加载），`package-lock.json` 锁定全部传递依赖；Dockerfile 新增 `runtime-guard-deps` 阶段（`npm ci --omit=dev --ignore-scripts`）并复制 `node_modules` 至 `/opt/muad/muad-runtime-guard/node_modules`。断言位于 `long-task-command-package.test.mjs`：manifest 锁定版本、隔离插件路径依赖缺失 MODULE_NOT_FOUND、真实 npm ci 后解析 `cd scripts && env X=1 python run.py` 为 Script 且 resolve 落在插件 node_modules、Dockerfile 两条复制布局正则。真实边界：真实包清单/锁文件、临时插件目录 npm ci、Dockerfile 文本；本次未构建镜像。RED 后修正测试内 Dockerfile 相对路径深度以到达布局断言。
- S-12: verified — automated command passed; run_id=1840eaf4208a4bffa52cb8c796fb454c (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-003: 实现 Shell AST 命令与路径判定

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: long-task-control.backend.design.md#3.2 架构设计
- **Spec-Refs**: 
- **Acceptance-Refs**: S-13
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-command-policy.mjs`, `tools/muad-runtime-guard/test/long-task-command-policy.test.mjs`

### Description

将路径及操作分析从钩子抽离为单一职责模块，正确识别常见执行形式和安全查看。

### Checklist
- [x] 解析 cd、管道、包装器、嵌套调用与命令替换，使用 realpath 和真实生效工作目录定位授权业务文件。
- [x] 按实际选项判断 find/awk/sed 等行为；不确定且涉及授权入口时返回明确拒绝依据，纯 read/cat/ls/grep 查看保持可用。
- [x] [S-13][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-13 | integration | 真实 Shell AST 解析模块、临时脚本与 symlink：分辨管道/包装器/子命令及 find/awk 执行行为，普通查看不误判，解析不确定返回显式结果 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-command-policy.test.mjs / LongTaskControlS13 | ["node","--test","--test-name-pattern","LongTaskControlS13","tools/muad-runtime-guard/test/long-task-command-policy.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-13 RED: 已执行 Contract 原命令；`../src/long-task-command-policy.mjs` 尚未实现（ERR_MODULE_NOT_FOUND），4 个行为用例全部失败（1 fail）。
S-13 GREEN: 已执行 Contract 原命令，4 pass / 0 fail。实现 `long-task-command-policy.mjs`（真实 bash-parser AST）：`analyzeShellCommand` 解析 cd/管道/包装器/命令替换/`-c` 嵌套/find -exec/awk system/sed e 命令并做 realpath 解析；`matchAuthorizedExecution` 与授权根比对并返回显式依据（execution / indeterminate）。断言位置：`long-task-command-policy.test.mjs` 四个用例分别覆盖（1）cwd、cd、赋值前缀、env/timeout/sudo 包装、`bash -c` 嵌套、`$()`/反引号替换、subshell、if 体；（2）find -exec/-execdir/覆盖根范围/固定脚本/直接 `{}`、awk system、sed e、stdin 重定向、cat|bash；（3）symlink 双向 realpath 与普通查看（ls/cat/grep/find/awk/sed/管道/`-c`）不误判；（4）解析不确定（未闭合引号）与动态/缺失操作数的显式结果。真实边界：真实 bash-parser、临时脚本与真实 symlink、真实 fs.realpath。RED 后按契约补充 find -exec 固定脚本与直接 `{}` 两组断言，重新执行仍全绿。
- S-13: verified — automated command passed; run_id=20fa5421324847a2839279d04f203d9d (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-004: 接入可信工作目录与前台零提交拦截

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: long-task-control.backend.design.md#3.2 架构设计
- **Spec-Refs**: 
- **Acceptance-Refs**: S-04
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-hooks.mjs`, `tools/muad-runtime-guard/test/long-task-hooks.test.mjs`

### Description

把新命令判定接入实际工具上下文，修复默认工作目录下相对路径漏拦，读取行为仍不触发提交。

### Checklist
- [x] 从可信 Agent/工具上下文得到默认 CWD，并按原生工具语义处理显式 workdir；拒绝伪造或无法解析的执行目标。
- [x] 覆盖绝对/相对脚本、cd、env/timeout 等包装及 find -exec；所有拒绝均零入队，查看材料不修改工具读取路径。
- [x] [S-04][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-04 | integration | 真实 guard、临时 Skill 文件和 Shell 解析：默认工作目录相对路径、cd、包装器、find -exec 被拒绝；普通 read/cat/ls/grep 查看通过；全程零提交 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-hooks.test.mjs / LongTaskControlS04 | ["node","--test","--test-name-pattern","LongTaskControlS04","tools/muad-runtime-guard/test/long-task-hooks.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-04 RED: 已执行 Contract 原命令；默认工作目录相对脚本 `python3 skills/report/scripts/run.py` 未被拦截（beforeToolCall 返回 undefined），复现设计描述的漏拦缺陷（1 fail）。
S-04 GREEN: 已执行 Contract 原命令，1 pass / 0 fail；全量 guard 套件 247 pass / 0 fail / 1 既有 skip。实现：`long-task-hooks.mjs` 改用 `long-task-command-policy.mjs` 分析命令，`findGrantForCommand` 使用可信默认 CWD（新增 `resolveDefaultCwd` 注入，`index.mjs` 接 `resolveAgentWorkspaceDir`）并按原生语义处理显式 workdir（相对值落在默认 CWD 上）；删除旧正则拆段实现，读取路径不变。断言位置：`long-task-hooks.test.mjs` 的 LongTaskControlS04 用例：相对脚本、cd 变体、env/timeout 包装、find -exec、`bash -c` 嵌套均拒绝且零入队/零提交；ls/cat/grep/find（无 exec）/缺失目标/仅提及均放行；既有 PreflightE03 用例保持通过。真实边界：真实 guard、临时 Skill 文件与 workspace、真实 Shell AST 解析。
- S-04: verified — automated command passed; run_id=30fd5d5e57b1404bae7433e8d57f7ae7 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-005: 收紧触发指导与可信显式名称检查

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001, runtime-skill-execution#RULE-runtime-skill-layering-001
- **Acceptance-Refs**: S-14
- **Owned Files**: `bin/openclaw-config-renderer.mjs`, `tools/muad-runtime-guard/src/long-task-preflight.mjs`, `bin/test/long-task-control-guidance.test.mjs`

### Description

保留唯一匹配自动执行、多候选选择，并强化用户原目标和参考边界；不引入普遍确认或逐 Skill 参数 Schema。

### Checklist
- [x] 固定指导增加截图等价正反例和缺参/无适用 Skill 规则；explicit_name 核对可信入站命令，保留本轮读取、有效授权及完整输入检查。
- [x] 验证 renderer 确定性、validateRuntimeConfig、generation 原子落盘及有效 Skill 分层；无自报布尔授权或隐式模型回退。
- [x] [S-14][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-runtime-config-001] verifier=runtime-config-and-apply#RULE-runtime-config-001（原 manual/review）：输入实际 renderer/DTO 与隔离 apply：确认 schema、事务、health/rollback；局部跑 LongTaskControlS14，最终保留 S-08。 原人工确认不由 Agent 代签。
- [x] [RULE-runtime-validate-before-write-001] verifier=runtime-config-and-apply#RULE-runtime-validate-before-write-001（原 manual/review）：输入 renderer/inject 差异和临时配置：断言 validateRuntimeConfig 在原子写前、generation 单调、0600；局部跑 LongTaskControlS14。 原人工确认不由 Agent 代签。
- [x] [RULE-runtime-skill-layering-001] verifier=runtime-skill-execution#RULE-runtime-skill-layering-001（原 manual/review）：输入有效 system/public/private 同名授权：断言 protected 优先、无 allow_override 不覆盖；局部跑 LongTaskControlS14，最终 S-08。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-14 | integration | 真实 renderer/preflight 与可信入站上下文：唯一自动、多候选选择、参考不授权；explicit_name 不接受模型伪造，现有授权和文档读取门禁保留 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | bin/test/long-task-control-guidance.test.mjs / LongTaskControlS14 | ["node","--test","--test-name-pattern","LongTaskControlS14","bin/test/long-task-control-guidance.test.mjs"]（cwd=.） | verified |
| RULE-runtime-config-001 | integration（局部证据；原 verifier=manual） | 输入实际 renderer/DTO 与隔离 apply：确认 schema、事务、health/rollback；局部跑 LongTaskControlS14，最终保留 S-08。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-14 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS14","bin/test/long-task-control-guidance.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-runtime-validate-before-write-001 | integration（局部证据；原 verifier=manual） | 输入 renderer/inject 差异和临时配置：断言 validateRuntimeConfig 在原子写前、generation 单调、0600；局部跑 LongTaskControlS14。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-14 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS14","bin/test/long-task-control-guidance.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-runtime-skill-layering-001 | integration（局部证据；原 verifier=manual） | 输入有效 system/public/private 同名授权：断言 protected 优先、无 allow_override 不覆盖；局部跑 LongTaskControlS14，最终 S-08。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-14 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS14","bin/test/long-task-control-guidance.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-14 RED: 已执行 Contract 原命令；固定指导缺少正反例/参考不授权/explicit_name 复核规则（指导断言不匹配），preflight 对模型自报 explicit_name 直接放行（4 个用例失败）。
S-14 GREEN: 已执行 Contract 原命令，5 pass / 0 fail；bin 套件 120 pass / 0 fail；guard 套件 247 pass / 0 fail / 1 既有 skip。实现：`openclaw-config-renderer.mjs` 固定指导新增“触发判定正反例（截图等价）/参考不授权运行/explicit_name 可信来源”三条规则，保留唯一自动与多候选选择；`long-task-preflight.mjs` 对 selectionBasis=explicit_name 用可信入站消息核对 explicitSkillName，模型自报或“参考”场景一律 explicit_name_untrusted。断言位置：`bin/test/long-task-control-guidance.test.mjs` 五个用例：指导规则与幂等写入、explicit_name 可信/伪造、授权+manifest+文档读取+缺参门禁、渲染确定性+generation 校验+0600 候选、grant 唯一性与目录 grant 不进入可执行授权。
RULE-runtime-config-001 局部证据: 真实 renderer 两次渲染 deepEqual；prepareTransaction 在隔离目录生成 candidate（generation/configHash）；回滚与健康恢复需真实 openclaw CLI/Worker，保留 S-08 与项目负责人确认。
RULE-runtime-validate-before-write-001 局部证据: renderOpenClawConfig/readRuntimeConfig 入口先 validateRuntimeConfig（generation=0 即拒绝）；prepare 候选文件 0600、generation 单调传入插件配置；原人工确认保留。
RULE-runtime-skill-layering-001 局部证据: 同 Agent 同名 grant 被 DTO schema 拒绝（不静默双绑/覆盖）；system 精确 name/rootPath 透传，public/private 仅目录 grant 且不进入可执行 longTask 授权；system protected 与 allow_override 的完整语义在控制面并由 S-08 终验，原人工确认保留。
跨任务修正: TASK-002 引入运行依赖后 `bin/runtime-image-self-check.mjs` 的 offline-safe 校验会拒绝镜像构建；本次回归修正为“构建期已打包 node_modules 时允许 dependencies，peerDependencies 仍拒绝”，并补 bin 单测用例；镜像内自检与运行验证留待 TASK-026 发布检查。
- S-14: verified — automated command passed; run_id=8d7a500cb47e4d049100beb9abe01c55 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] note: TASK-002 运行依赖触发 image self-check 拒绝，本次按“构建期打包 node_modules 允许 dependencies”修正并补测。
- [2026-10-15] completed (done)
## TASK-006: 扩充运行时取消状态与可靠持久化

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: long-task-control.backend.design.md#3.3 数据设计
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-15
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-cancel-state.mjs`, `tools/muad-runtime-guard/src/long-task-manager.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-state.test.mjs`

### Description

定义取消请求、修订号和恢复语义，为后续 manager 提供可靠的状态边界。

### Checklist
- [x] 保存 cancelling/cancelled、cancelRequestedAt/cancelRequestedBy/cancelledAt 和单调 revision；接受取消前必须可靠写入。
- [x] 保留 0600 状态/临时材料、原子收敛和旧四状态记录兼容；重启不能把取消中任务重新执行，归属不明不得猜测停止。
- [x] [S-15][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-runtime-secret-file-mode-001] verifier=runtime-isolation-and-security#RULE-runtime-secret-file-mode-001（原 manual/review）：输入实际 JSONL/临时材料及重启记录：stat 断言 0600、取消墓碑保留，token 仍为规范 0400；跑 LongTaskControlS15。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-15 | integration | 真实任务状态模块、0600 临时 JSONL 及恢复读取：revision 单调、取消请求可靠保存，旧记录兼容、写入失败显式且不伪造取消 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-state.test.mjs / LongTaskControlS15 | ["node","--test","--test-name-pattern","LongTaskControlS15","tools/muad-runtime-guard/test/long-task-cancel-state.test.mjs"]（cwd=.） | verified |
| RULE-runtime-secret-file-mode-001 | integration（局部证据；原 verifier=manual） | 输入实际 JSONL/临时材料及重启记录：stat 断言 0600、取消墓碑保留，token 仍为规范 0400；跑 LongTaskControlS15。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-15 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS15","tools/muad-runtime-guard/test/long-task-cancel-state.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-15 RED（顺序说明：本任务实现先行，RED 以回放实现前状态补录——新模块不存在、manager 未接入）：Contract 原命令 1 fail（加载失败），新状态边界与墓碑语义均未实现。
S-15 GREEN: 已执行 Contract 原命令，4 pass / 0 fail；guard 全量 251 pass / 0 fail / 1 既有 skip。实现：新增 `long-task-cancel-state.mjs`（状态词汇 queued/running/cancelling/cancelled/succeeded/failed；`normalizeTaskRecord` 兼容旧记录 revision=0/空取消字段；`nextTaskRecord` 每次落盘严格递增 revision；`requestTaskCancellation`/`confirmTaskCancellation` 校验合法迁移并写入 cancelRequestedAt/By 与 cancelledAt；`recoverInterruptedRecord` 保留 cancelling 墓碑；0600 JSONL 追加/原子收敛/容错读取，写失败显式抛错）；`long-task-manager.mjs` 接入模块：恢复时 queued/running→failed（revision 递增、孤儿诊断保留）、cancelling 墓碑保留且零重跑，快照新增 stateRevision/cancelRequestedAt/cancelRequestedBy/cancelledAt。断言位置：`long-task-cancel-state.test.mjs` 四个用例：revision 0→1→2→3 单调与取消请求可靠落盘、写失败显式且不伪造取消、旧记录恢复/墓碑/原子收敛、manager 连续两次重启零重跑。
RULE-runtime-secret-file-mode-001 局部证据: 状态 JSONL 与其临时收敛文件均 stat 0600（三个用例断言）；服务 token 0400 断言仍在 bin/test/runtime-image-self-check.test.mjs 覆盖，本次未改动相关代码；原人工确认保留项目负责人。
- S-15: verified — automated command passed; run_id=a31caac6e77d469e954f345cadedb9e1 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-007: 迁移 SQLite 任务状态约束与取消字段

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.backend.design.md#3.3 数据设计, long-task-control.backend.design.md#4. 部署与运维
- **Spec-Refs**: backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001
- **Acceptance-Refs**: S-16
- **Owned Files**: `console/backend/internal/repo/long_task_migrations.go`, `console/backend/internal/repo/long_tasks.go`, `console/backend/internal/repo/long_task_migrations_test.go`

### Description

通过 repo 事务迁移扩充 CHECK 约束和取消元数据，保留历史任务与索引。

### Checklist
- [x] 按设计新增 state_revision/cancel_requested_at/cancel_requested_by/cancelled_at，显式列复制及行数/索引校验。
- [x] 迁移版本化且可重复执行；模拟失败验证回滚，不使用 writable_schema、拼接用户 SQL 或删除旧记录。
- [x] [S-16][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-backend-database-001] verifier=backend-database#RULE-backend-database-001（原 manual/review）：输入旧 SQLite、迁移异常和重复执行：断言保数据/索引/事务回滚、repo-only 参数化 SQL；跑 TestLongTaskControlS16。 原人工确认不由 Agent 代签。
- [x] [RULE-backend-no-select-star-001] verifier=backend-database#RULE-backend-no-select-star-001（原 regex/code）：输入本需求 repo/迁移 SQL：按原 regex 扫描且显式列复制；跑 TestLongTaskControlS16 验证实际数据。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-16 | integration | 真实 SQLite 旧表及 repo 迁移：新增状态/取消字段后行数、内容及索引保留，迁移可重复、失败事务回滚 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/internal/repo/long_task_migrations_test.go / TestLongTaskControlS16 | ["go","test","./internal/repo","-run","TestLongTaskControlS16","-count=1"]（cwd=console/backend） | verified |
| RULE-backend-database-001 | integration（局部证据；原 verifier=manual） | 输入旧 SQLite、迁移异常和重复执行：断言保数据/索引/事务回滚、repo-only 参数化 SQL；跑 TestLongTaskControlS16。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-16 对应用例与差异审查 | ["go","test","./internal/repo","-run","TestLongTaskControlS16","-count=1"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-backend-no-select-star-001 | integration（局部证据；原 verifier=regex） | 输入本需求 repo/迁移 SQL：按原 regex 扫描且显式列复制；跑 TestLongTaskControlS16 验证实际数据。 | 保留原 code verifier 与确认要求，不以局部命令替代 | S-16 对应用例与差异审查 | ["go","test","./internal/repo","-run","TestLongTaskControlS16","-count=1"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-16 RED（顺序说明：实现先行，RED 以回放实现前状态补录）：单测引用的 LongTaskCancelling/StateRevision/cancel 字段与新迁移均不存在，`go test ./internal/repo -run TestLongTaskControlS16` build failed（undefined: LongTaskCancelling 等）。
S-16 GREEN: 已执行 Contract 原命令，2 pass / 0 fail；`go build ./...`、`go vet ./internal/repo` 通过；后端全量 `go test ./...` 12 包全绿。实现：新增 `long_task_migrations.go`（`longTaskTableDDL` 六状态 CHECK + 4 新列；`migrateLongTaskStatusConstraint` 在 sqlite_master 缺 'cancelling' 时单事务重建：rename → 新 DDL → 显式列 INSERT..SELECT → 行数校验 → drop legacy → 重建三索引；已迁移短路，失败整体回滚保留原表），`long_tasks.go` 读写携带 state_revision/cancel_requested_at/cancel_requested_by/cancelled_at，cancelling 单向门状态机（仅 cancelled 前进）；`models.go` 增加 LongTaskCancelling/LongTaskCancelled 与字段。断言位置：`long_task_migrations_test.go` 两个用例：旧四状态库迁移后行数/内容/索引保全、新列默认 0/空、cancelling 快照可读写、二次 Open 幂等且无 legacy 残表；脏历史状态使迁移失败后旧表结构/行数/脏值原样保留。
RULE-backend-database-001 局部证据: 迁移与全部长任务 SQL 在 repo 内执行，事务包裹、显式列复制、保数据与索引，失败回滚用例通过；Upsert/List/计数全部参数化，无拼接用户输入；原人工确认保留。
RULE-backend-no-select-star-001 局部证据: 本需求 repo/迁移 SQL 全部显式列（longTaskColumns、INSERT/UPDATE 列表、COUNT/PRAGMA），无 SELECT *；code-stage regex 校验随 Done Gate 执行，实际数据侧由 TestLongTaskControlS16 断言。
- S-16: verified — automated command passed; run_id=9d7ab88ae19f496bb3506115d2c4de1b (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-008: 实现任务镜像修订与终态合并

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-007
- **Source**: long-task-control.backend.design.md#3.3 数据设计
- **Spec-Refs**: 
- **Acceptance-Refs**: B-03
- **Owned Files**: `console/backend/internal/repo/models.go`, `console/backend/internal/repo/long_tasks.go`, `console/backend/test/long_tasks_test.go`

### Description

修复旧快照回退导致终态被写成 failed 的行为，支持新取消状态和旧记录。

### Checklist
- [x] 加入状态/取消字段与 revision 合并；终态不回退，相同 revision 幂等，旧格式不能覆盖新取消终态。
- [x] 校验重复/乱序快照、旧四状态数据与迁移重复执行；保持任务历史与池计数可查询。
- [x] [B-03][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| B-03 | integration | 真实 SQLite：重复及乱序快照、旧四状态记录、迁移重复执行，已取消/已完成状态不回退、不被自动改 failed，历史记录和索引保留 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/test/long_tasks_test.go / TestLongTaskControlB03 | ["go","test","./test","-run","TestLongTaskControlB03","-count=1"]（cwd=console/backend） | verified |

### Acceptance Evidence

B-03 RED: 已执行 Contract 原命令，2 用例失败：succeeded 终态被迟到的 running/queued 快照改写成 failed（terminal_reason=status_regressed: failed -> queued），复现设计缺陷。
B-03 GREEN: 已执行 Contract 原命令，2 pass / 0 fail；`go build ./...`、`go vet ./internal/repo ./test` 通过；后端全量 `go test ./...` 12 包全绿。实现：`long_tasks.go` 新增 `mergeLongTaskTaskTx`/`observeLongTaskTaskTx`——终态（cancelled/succeeded/failed）永不被快照改写；低于现有 state_revision 的旧格式/乱序快照不采纳状态与计数；同 revision 幂等且仅在合法前进时整体更新；被跳过的快照只推进 last_seen_at，删除 status_regressed→failed 的旧转换。断言位置：`console/backend/test/long_tasks_test.go` 两个用例：完整取消链 queued→running→cancelling→cancelled、重复快照幂等、终态抗回退（含旧 rev=0 快照）、乱序快照不拉回、cancelling 单向门不回退且不伪 failed、旧 Worker rev0 合法前进兼容；旧四状态库两次 Open 后历史行/终态/三个索引保留。
- B-03: verified — automated command passed; run_id=7918cb5480624fc2b62917b7f532a86a (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-009: 实现目标运行取消适配器

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001, TASK-006
- **Source**: long-task-control.backend.design.md#3.2 架构设计
- **Spec-Refs**: 
- **Acceptance-Refs**: S-17
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-run-controller.mjs`, `tools/muad-runtime-guard/src/long-task-manager.mjs`, `tools/muad-runtime-guard/test/long-task-run-controller.test.mjs`

### Description

按已核对的公开契约控制真实 run，并持续跟踪该任务进程退出；CLI 只作辅助证据。

### Checklist
- [x] 以 taskId/后台 sessionKey/真实 runId/Worker 实例绑定运行句柄，取消未知归属时明确拒绝，禁止全局 kill。
- [x] 区分取消请求接受、停止确认与失败；调用超时有界；补齐原生接口未覆盖的归属进程清理，发现接口缺口回到设计。
- [x] [S-17][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-17 | integration | 真实执行适配器、可控原生取消依赖、真实本地子进程：taskId/session/run 严格对应，abort 接受不等于已退出，不以杀 CLI 替代取消 Gateway | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-run-controller.test.mjs / LongTaskControlS17 | ["node","--test","--test-name-pattern","LongTaskControlS17","tools/muad-runtime-guard/test/long-task-run-controller.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-17 RED: 已执行 Contract 原命令；`../src/long-task-run-controller.mjs` 尚未实现（ERR_MODULE_NOT_FOUND），5 个行为用例全部失败（1 fail）。
S-17 GREEN: 已执行 Contract 原命令，5 pass / 0 fail；guard 全量 256 pass / 0 fail / 1 既有 skip。实现：新增 `long-task-run-controller.mjs`——`bind` 校验 taskId↔sessionKey↔owned child 严格对应，`cancel` 只接受本 controller 注册的 binding（未知/伪造/跨 Worker 一律 unknown_run 且零信号）；真实 sessionId 只在取消时由 `resolveActiveEmbeddedRunSessionId` 按可信 sessionKey 解析；`abortAndDrainAgentHarnessRun` 固定 `forceClear:false`，aborted（接受）≠ drained（原生清理）≠ 进程已退出；drained 后等真实退出，未退出只对本 Worker detached 进程组补发 SIGKILL 并继续等 exit，drain 超时/forceCleared/退出未确认均不确认停止；所有原生调用有界超时。`long-task-manager.mjs`：CLI 以 detached 自有进程组启动并 onChild 绑定句柄，`#finish` 释放绑定，watchdog 超时同时清自有进程组。断言位置：`long-task-run-controller.test.mjs` 五个用例（abort 接受≠退出、drained 后真实组退出确认含孙进程、未知/伪造/跨 Worker 拒绝零信号、无活跃句柄 run_not_active、既退出进程辅助证据）。真实边界：真实 detached 本地子进程与进程组、真实 signal/exit 事件；原生取消依赖按 TASK-001 契约以可控 stub 注入。
接口接线要求（回到设计的缺口记录）: 生产取消（TASK-014）必须让 abort/drain 在持有该运行注册表的进程内调用；跨进程不一致时不得宣称停止，最终由 S-06/E-02/B-04 E2E 验证。
- S-17: verified — automated command passed; run_id=c5d1c17f2a38457883d3cc1ac6605c5a (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-010: 实现队列取消与完成竞争仲裁

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-006, TASK-009
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#3.3 数据设计
- **Spec-Refs**: 
- **Acceptance-Refs**: B-01, B-02, E-04
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-manager.mjs`, `tools/muad-runtime-guard/src/long-task-cancel-state.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs`

### Description

在同一任务临界区实现 queued 取消、running 到 cancelling、停止确认到 cancelled，以及完成/取消幂等仲裁。

### Checklist
- [x] 排队取消后零启动；cancelling 持续占槽；取消接受后迟到完成回调不能覆盖终态；确认停止并清理后才释放槽位。
- [x] 对 queued→running、spawn 前后屏障、自然完成竞争、重复/结果丢失重发及状态 I/O 失败做真实 manager 断言；取消失败不触发任务重试。
- [x] [B-01, B-02, E-04][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| B-01 | integration | 可控执行屏障与真实 manager：queued 转 running、spawn 尚未发生及自然完成时请求取消，验证线性化规则和无双终态 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs / LongTaskControlB01 | ["node","--test","--test-name-pattern","LongTaskControlB01","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"]（cwd=.） | verified |
| B-02 | integration | 相同取消请求多次、RPC 返回丢失后重复请求：无重复终止、无重复终态通知、无重复释放资源 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs / LongTaskControlB02 | ["node","--test","--test-name-pattern","LongTaskControlB02","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"]（cwd=.） | verified |
| E-04 | integration | 真实 manager 和状态文件：取消记录写入失败时明确报错，不接受取消成功；隔离清理错误，不改写为成功 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs / LongTaskControlE04 | ["node","--test","--test-name-pattern","LongTaskControlE04","tools/muad-runtime-guard/test/long-task-cancel-manager.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

B-01/B-02/E-04 RED: 已执行三个 Contract 原命令；`manager.cancelTask is not a function`，3 用例失败（取消仲裁未实现）。
GREEN: 已执行三个 Contract 原命令，3 pass / 0 fail；guard 全量 259 pass / 0 fail / 1 既有 skip（全量重跑 3 次稳定；首次全量曾出现一次 skill-progress-e2e 投递顺序 flake，单文件 3/3 与后续全量 2× 均通过，判定为既有偶发、与本改动路径无关）。实现：`long-task-manager.mjs` 新增 `cancelTask` 临界区（not_found / already_terminal / cancelling 幂等 repeated）；queued 取消先可靠写入取消终态再移出队列（写失败保持排队）；running 先可靠写入 cancelling（继续占槽、revision 递增）再调用运行控制器，只有 drained 且自有进程真实退出后清理进度桥、写入 cancelled、释放槽位与绑定；spawn 间隙取消由 `#bindRunHandle` 用同一取消标记补做确认；迟到完成回调由 `#finish` 护栏忽略并触发一次有界对账；`#start` 增加防重跑护栏；所有取消相关状态写入失败返回 state_unavailable 且不释放槽位/不伪造取消。断言位置：`long-task-cancel-manager.test.mjs` 三用例：B-01（排队取消零启动+零提交、spawn 间隙 cancelling 占槽后自动确认、迟到完成不覆盖终态、自然完成 already_terminal 不再调用原生）；B-02（重复请求单次原生调用/单次终态/单次资源释放、未确认保持 cancelling 且仅一次对账）；E-04（取消请求写入失败与终态写入失败均显式报错：保持 running/cancelling、不释放绑定、不写 cancelled）。真实边界：真实 LongTaskManager、真实状态 JSONL 与可控执行屏障；原生取消依赖以可控 stub 注入（S-17 边界）。
- E-04: verified — automated command passed; run_id=93cd05783a6c48fa93b6cf6ba98730d9 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=93cd05783a6c48fa93b6cf6ba98730d9 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=93cd05783a6c48fa93b6cf6ba98730d9 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-011: 取消期间关闭新工具并精确清理租约

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-010
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001
- **Acceptance-Refs**: S-18
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-hooks.mjs`, `tools/muad-runtime-guard/src/index.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-resources.test.mjs`

### Description

让取消标记约束后台后续工具调用，并只清理目标任务持有的 Skill/browser 租约和临时资源。

### Checklist
- [x] 按可信 task/run 识别取消中后台调用并拒绝；不将读取其他文档扩展为整轮权限切换。
- [x] 与实际执行退出衔接幂等清理；尚未停止不提前释放；主会话、同 Agent 其他任务及其他用户租约保持正确。
- [x] [S-18][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-runtime-skill-001] verifier=runtime-skill-execution#RULE-runtime-skill-001（原 manual/review）：输入真实 manager 与共享租约：取消中占槽、停止后仅目标资源释放一次，新调用被门禁拒绝；跑 LongTaskControlS18，最终 S-06/S-07。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-18 | integration | 真实 manager、shared Skill/browser lease 和临时进度桥：取消期间不释放槽，确认停止后仅清理目标任务资源，下一任务启动且不重复释放 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-resources.test.mjs / LongTaskControlS18 | ["node","--test","--test-name-pattern","LongTaskControlS18","tools/muad-runtime-guard/test/long-task-cancel-resources.test.mjs"]（cwd=.） | verified |
| RULE-runtime-skill-001 | integration（局部证据；原 verifier=manual） | 输入真实 manager 与共享租约：取消中占槽、停止后仅目标资源释放一次，新调用被门禁拒绝；跑 LongTaskControlS18，最终 S-06/S-07。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-18 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS18","tools/muad-runtime-guard/test/long-task-cancel-resources.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-18 RED: 已执行 Contract 原命令；`manager.taskStatus is not a function`（取消工具门禁与终态资源清理均未实现），1 fail。
S-18 GREEN: 已执行 Contract 原命令，2 pass / 0 fail；guard 全量 261 pass / 0 fail / 1 既有 skip。实现：`long-task-hooks.mjs` 新增取消门禁——目标后台会话在 cancelling/cancelled 时拒绝新工具调用（只按 taskId 作用到该会话，主会话/同 Agent 其他任务/其他用户不受影响）；`long-task-manager.mjs` 新增 `taskStatus(taskId)` 与 `releaseTaskResources(task)` 注入：自然完成走一次性 fire-and-forget，取消收尾中 await 清理、失败保持 cancelling（cleanup_failed，占槽不放）；`skill-lease.mjs`/`browser-lease.mjs` 新增 `releaseSession(sessionKey)`（只释放本进程持有的该会话租约，未持有 no-op、可重复）；`index.mjs` 接线门禁与资源释放。断言位置：`long-task-cancel-resources.test.mjs` 两个用例：真实 shared Skill/browser 租约（临时队列目录）——取消未确认时槽位占用、下一任务未启动、零租约释放，门禁只拦目标任务；确认后仅目标任务租约各释放一次、下一任务启动、其他用户/其他任务租约保留、重复取消不重复释放；清理失败保持 cancelling 且不释放槽位与绑定。真实边界：真实 LongTaskManager、真实 shared-lease-queue 文件锁租约、真实 hooks 门禁；原生取消依赖可控 stub。
RULE-runtime-skill-001 局部证据: 门禁拒绝取消中任务的新调用、取消中占槽、停止确认后仅释放目标任务资源且幂等；S-06/S-07 的真实停止与跨用户隔离仍由 E2E 终验；原人工确认保留。
- S-18: verified — automated command passed; run_id=20deb92c594c4ddeb6905cef6b44e704 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-012: 停止取消任务的新进度与待发队列

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-010
- **Source**: long-task-control.backend.design.md#3.2 架构设计
- **Spec-Refs**: 
- **Acceptance-Refs**: S-19
- **Owned Files**: `tools/muad-runtime-guard/src/skill-progress-manager.mjs`, `tools/muad-runtime-guard/src/progress-event-bridge.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-progress.test.mjs`

### Description

为进度桥提供取消关闭语义，拒绝迟到进度并丢弃尚未发起的通知。

### Checklist
- [x] 取消后新事件被拒绝；尚未发送队列在真正发送前检查取消状态；已在途消息保留可解释边界。
- [x] 关闭桥与定时器，终态通知幂等；与正常 finish 和失败通知保持不同语义。
- [x] [S-19][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-19 | integration | 真实 SkillProgressManager 与进度桥、可控通知发送边界：取消后拒绝迟到事件，丢弃未发起队列；在途记录可解释，终态消息最多一次 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-progress.test.mjs / LongTaskControlS19 | ["node","--test","--test-name-pattern","LongTaskControlS19","tools/muad-runtime-guard/test/long-task-cancel-progress.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-19 RED: 已执行 Contract 原命令；`manager.cancel is not a function`（取消语义与接线未实现），1 fail；正常 finish 用例保持通过（既有行为）。
S-19 GREEN: 已执行 Contract 原命令，3 pass / 0 fail；guard 全量 264 pass / 0 fail / 1 既有 skip。实现：`skill-progress-manager.mjs` 新增 `cancel(executionKey)`——立即置非接受态并拒绝迟到事件（reason=execution_cancelled，区分正常 finish 的 execution_finished），真正发送前检查取消标记并丢弃未发起队列（dropped 计数 + 可解释日志），在途发送保留原 delivered/failed 语义；与 finish 共享同一终态结算（最多一次、互斥），不发送额外成功/失败消息（取消通知由投递仲裁统一处理）；取消时调用真实进度桥 `finish`（收尾 drain + 关闭定时器与事件文件）。`long-task-manager.mjs` 取消收尾改走 `#finishProgress(task, { cancelled: true })` → `progress.cancel`（无 cancel 的旧桩回退 finish）。断言位置：`long-task-cancel-progress.test.mjs` 三用例：真实进度桥文件事件投递后在途占位、取消后迟到拒绝、未发起队列全部丢弃、事件文件随取消清理、重复取消零新消息；接线用例断言任务取消路由到 progress.cancel 而非 finish；正常 finish 仍完整投递队列。真实边界：真实 SkillProgressManager、真实 ProgressEventBridge（文件+调度器）；通知发送边界以可控 notify 注入。
- S-19: verified — automated command passed; run_id=6f99347376404ba2a8b3b8f8df0efad0 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-013: 将长任务结果投递纳入取消仲裁

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-009, TASK-010, TASK-012
- **Source**: long-task-control.backend.design.md#3.2 架构设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-20
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-manager.mjs`, `tools/muad-runtime-guard/src/long-task-delivery.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-delivery.test.mjs`

### Description

替换子 CLI 无条件直接 --deliver，由 manager 在最终发送前决定许可，保留结果、附件和通道语义。

### Checklist
- [x] 持续消费 JSON/输出流并限制诊断缓冲，显式处理 stderr/非零退出，避免管道堵塞；保留媒体与多段输出。
- [x] 在任务临界区仲裁取消与投递，取消后不新发成功/通用失败结果；明确脚本主动发送路径的检查与已在途边界。
- [x] [S-20][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-runtime-skill-fail-loud-001] verifier=runtime-skill-execution#RULE-runtime-skill-fail-loud-001（原 manual/review）：输入真实子进程 stderr/非零及输出流：失败明确传播、stdout 持续消费并保留机器结果，不将取消记成功；跑 LongTaskControlS20。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-20 | integration | 真实结果解析和管理器投递控制、可控子进程流与通知边界：持续消费输出、保留附件/多段结果，取消与投递许可互斥且不再直接 --deliver | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-delivery.test.mjs / LongTaskControlS20 | ["node","--test","--test-name-pattern","LongTaskControlS20","tools/muad-runtime-guard/test/long-task-cancel-delivery.test.mjs"]（cwd=.） | verified |
| RULE-runtime-skill-fail-loud-001 | integration（局部证据；原 verifier=manual） | 输入真实子进程 stderr/非零及输出流：失败明确传播、stdout 持续消费并保留机器结果，不将取消记成功；跑 LongTaskControlS20。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-20 对应用例与差异审查 | ["node","--test","--test-name-pattern","LongTaskControlS20","tools/muad-runtime-guard/test/long-task-cancel-delivery.test.mjs"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-20 RED: 已执行 Contract 原命令；`../src/long-task-delivery.mjs` 尚未实现（ERR_MODULE_NOT_FOUND），1 fail；仲裁用例保持通过（既有行为）。
S-20 GREEN: 已执行 Contract 原命令，3 pass / 0 fail；guard 全量 267 pass / 0 fail（含真实 CLI fixture E2E），复跑一次稳定。真实 CLI 契约核对（本地 2026.7.1 镜像）：`openclaw agent --json`（无 --deliver）输出 `result.payloads[]`；`openclaw message send` 支持 `--media <path-or-url>`。实现：新增 `long-task-delivery.mjs`（`parseAgentResultPayloads` 解析 stdout envelope，容忍尾随行式诊断、envelope 非法显式失败；`createResultDelivery` 按段顺序投递文本与附件，media 兼容字符串/对象），`notify-user.mjs` 支持 `--media`（text/media 至少其一），`long-task-manager.mjs`：子 CLI 去掉 `--deliver`、stdout 改为持续消费 + 有界缓冲（超限按不可解析显式失败 fail loud，非零退出仍失败传播）、`spawnOpenClawTask` 返回解析结果、`#finish` 临界区唯一裁定投递许可（取消已提交/迟到完成一律不新发成功结果与通用失败通知；许可发起即视为在途）。契约同步更新：`long-task-manager.test.mjs` spawn 用例改为“stdout 必须被消费且无 --deliver”；进度 E2E fixture 改为新 CLI 契约（agent 输出 JSON、最终结果经 message send 投递一次）。断言位置：`long-task-cancel-delivery.test.mjs` 三用例：2MB 行式诊断 + 多段/附件结果解析、输出超限与空输出边界、取消后迟到成功/失败均不投递不外发、正常失败仍通知一次、段序与 --media 参数形状。真实边界：真实 spawn 管道流与真实 notifyUser CLI argv；通知投递以可控 stub 断言。
- S-20: verified — automated command passed; run_id=cd2fda545309413a9e1226af5c038ae7 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-014: 注册内部取消 RPC 与 Worker 能力

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-010, TASK-011, TASK-013
- **Source**: long-task-control.backend.design.md#3.4 接口设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001, runtime-isolation-and-security#RULE-runtime-security-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001
- **Acceptance-Refs**: S-21
- **Owned Files**: `tools/muad-runtime-guard/src/long-task-cancel-rpc.mjs`, `tools/muad-runtime-guard/src/index.mjs`, `tools/muad-runtime-guard/src/health.mjs`, `tools/muad-runtime-guard/test/long-task-cancel-registration.test.mjs`

### Description

注册控制面专用取消 RPC，复用共享 manager，并在健康信息中报告真实可用的取消能力。

### Checklist
- [x] 只提供 operator.write RPC；请求可信 taskId/requestedBy 校验，绝不加入模型工具目录或业务 allowlist。
- [x] 完整链路就绪才报告能力；注入 api.logger.warn 和稳定 longtask-cancel 前缀，日志不包含凭证或完整用户输入。
- [x] [S-21][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-runtime-directory-001] verifier=runtime-directory-structure#RULE-runtime-directory-001（原 manual/review）：输入插件 RPC/health/register 差异：资产仍在 tools/bin，不引入上游副本；跑 LongTaskControlS21 并核对文件边界。 原人工确认不由 Agent 代签。
- [x] [RULE-runtime-security-001] verifier=runtime-isolation-and-security#RULE-runtime-security-001（原 manual/review）：输入可信 RPC 操作者、任务身份及跨用户伪造请求：断言拒绝越权、无模型入口、无凭证记录；跑 LongTaskControlS21，最终 S-07。 原人工确认不由 Agent 代签。
- [x] [RULE-runtime-log-injection-001] verifier=runtime-skill-execution#RULE-runtime-log-injection-001（原 manual/review）：输入注入 log spy 与 plugin api.logger：断言模块不散落 console、失败有可追踪诊断；跑 LongTaskControlS21。 原人工确认不由 Agent 代签。
- [x] [RULE-runtime-log-prefix-001] verifier=runtime-skill-execution#RULE-runtime-log-prefix-001（原 manual/review）：输入取消成功/失败日志：断言稳定模块和 longtask-cancel 子标签、仅 ID/状态/脱敏原因；跑 LongTaskControlS21。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-21 | integration | 真实插件 register/hooks/manager 与 host API spy：内部取消 RPC 仅 operator.write，绝不暴露为模型工具；身份不可信拒绝，能力仅在取消链完整时报告 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-cancel-registration.test.mjs / LongTaskControlS21 | ["node","--test","--test-name-pattern","LongTaskControlS21","tools/muad-runtime-guard/test/long-task-cancel-registration.test.mjs"]（cwd=.） | verified |
| RULE-runtime-directory-001 | integration（局部证据；原 verifier=manual） | 输入插件 RPC/health/register 差异：资产仍在 tools/bin，不引入上游副本；跑 LongTaskControlS21 并核对文件边界。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-21 对应用例与差异审查 | 原 verifier_ref 见 Checklist | local_verified |
| RULE-runtime-security-001 | integration（局部证据；原 verifier=manual） | 输入可信 RPC 操作者、任务身份及跨用户伪造请求：断言拒绝越权、无模型入口、无凭证记录；跑 LongTaskControlS21，最终 S-07。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-21 对应用例与差异审查 | 原 verifier_ref 见 Checklist | local_verified |
| RULE-runtime-log-injection-001 | integration（局部证据；原 verifier=manual） | 输入注入 log spy 与 plugin api.logger：断言模块不散落 console、失败有可追踪诊断；跑 LongTaskControlS21。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-21 对应用例与差异审查 | 原 verifier_ref 见 Checklist | local_verified |
| RULE-runtime-log-prefix-001 | integration（局部证据；原 verifier=manual） | 输入取消成功/失败日志：断言稳定模块和 longtask-cancel 子标签、仅 ID/状态/脱敏原因；跑 LongTaskControlS21。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-21 对应用例与差异审查 | 原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-21 RED: 已执行 Contract 原命令；`../src/long-task-cancel-rpc.mjs` 尚未实现（ERR_MODULE_NOT_FOUND），1 fail。
S-21 GREEN: 已执行 Contract 原命令，1 pass / 0 fail；guard 全量 268 pass / 0 fail / 1 既有 skip。实现：新增 `long-task-cancel-rpc.mjs`——`muad.long-task.cancel` 以 operator.write 注册；`validateCancelRequest` 仅接受 {taskId,requestedBy} 两个有界字符串（其余/超长/控制字符拒绝）；`loadNativeCancelRuntime` 经 `openclaw/plugin-sdk/agent-harness-runtime`（含 agent-core 进程树信号）动态加载，缺失/导出不全明确不可用；`createLongTaskCancelHandler` 在能力未就绪时拒绝且不触碰 manager，就绪时经真实 manager 执行并回传 outcome/status/revision；能力 holder 存于 `muad.longtask.cancel` 共享符号。`index.mjs` 装配：register 时安装 holder + 注册 RPC + 异步加载成功后创建运行控制器注入共享 manager（`attachRunController`）并上报能力，失败仅记警告。`health.mjs` 新增 `longTaskCancel {available, version}`，仅在能力可用且 manager 支持 cancelTask/taskStatus 时为 true；不改变 health.ok。manager 取消日志去除 requestedBy（仅 ID/状态/原因）。断言位置：`long-task-cancel-registration.test.mjs`——真实插件 register 全流程（host API spy）：RPC scope、工具目录仅 muad_submit_long_task、10 类畸形/伪造请求拒绝且零 manager 调用、链不完整 cancel_unavailable + health false、注入完整链后真实取消成功 + health {true,1}、重复取消原样回传、日志前缀且不含请求身份；`loadNativeCancelRuntime` 三态（可用/sdk 缺失/导出不全）。真实边界：真实插件 register/hooks/manager 与真实 health 输出；host API 与原生 importer 以契约桩注入。
RULE 局部证据说明: 资产均在 tools/ + bin/（不引入上游副本）；RPC 无模型入口、畸形/越权身份拒绝、日志无凭证或请求原文；日志经注入 log→api.logger.warn 且带稳定 `[muad-runtime-guard][longtask-cancel]` 前缀。原人工确认保留；跨用户越权完整语义由 S-07/E-03 终验。
- S-21: verified — automated command passed; run_id=2cd224b44fea422badc106d7a9c44589 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-015: 封装 Go Gateway 取消调用与超时

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: long-task-control.backend.design.md#3.4 接口设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-directory-structure#RULE-backend-directory-001
- **Acceptance-Refs**: S-22
- **Owned Files**: `console/backend/internal/gateway/long_task_cancel.go`, `console/backend/internal/gateway/long_task_capabilities.go`, `console/backend/internal/gateway/long_task_cancel_test.go`

### Description

集中封装 Driver.Exec 调用、稳定响应和按 Pod 缓存的能力结果，供 handler 与列表使用。

### Checklist
- [x] 按 argv 和编码后的 JSON 传参，使用 context deadline；区分旧 Worker、身份未知、取消已接受、已取消与真实终态。
- [x] 提供按 Pod 的能力缓存读写与失效接口；由既有 health probe 更新，未知/过期保守不可取消，列表读取不增加逐行网络调用。
- [x] 不在 handler 复制运行时或 Docker/K8s 细节；fake Driver 断言无注入、超时可中断、错误可封装，保留原错误链供脱敏诊断。
- [x] [S-22][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-backend-quality-001] verifier=backend-code-quality-performance#RULE-backend-quality-001（原 manual/review）：输入 fake Driver 超时和畸形 RPC：显式错误、context deadline、错误链；跑 TestLongTaskControlS22；终验对修改包 go test/go vet。 原人工确认不由 Agent 代签。
- [x] [RULE-backend-directory-001] verifier=backend-directory-structure#RULE-backend-directory-001（原 manual/review）：输入 Go 依赖/新增文件：handler 不拥有 SQL 或容器实现，gateway 只经 Driver.Exec；跑 TestLongTaskControlS22 并检查分层。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-22 | integration | 真实 Go Gateway 适配器与 fake Driver：argv/JSON 安全传递、context 超时、RPC 包络校验；不支持与未知停止明确区分 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/internal/gateway/long_task_cancel_test.go / TestLongTaskControlS22 | ["go","test","./internal/gateway","-run","TestLongTaskControlS22","-count=1"]（cwd=console/backend） | verified |
| RULE-backend-quality-001 | integration（局部证据；原 verifier=manual） | 输入 fake Driver 超时和畸形 RPC：显式错误、context deadline、错误链；跑 TestLongTaskControlS22；终验对修改包 go test/go vet。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-22 对应用例与差异审查 | ["go","test","./internal/gateway","-run","TestLongTaskControlS22","-count=1"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-backend-directory-001 | integration（局部证据；原 verifier=manual） | 输入 Go 依赖/新增文件：handler 不拥有 SQL 或容器实现，gateway 只经 Driver.Exec；跑 TestLongTaskControlS22 并检查分层。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-22 对应用例与差异审查 | ["go","test","./internal/gateway","-run","TestLongTaskControlS22","-count=1"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-22 RED: 已执行 Contract 原命令；`CancelLongTask`/`LongTaskCancelResult`/错误哨兵与能力缓存均未定义（build failed），实现前无法通过。
S-22 GREEN: 已执行 Contract 原命令，全部分组通过；`go build ./...`、`go vet ./internal/gateway` 通过；后端全量 `go test ./...` 12 包全绿。实现：新增 `long_task_cancel.go`（`CancelLongTask` 经既有 Execer 单一 argv 调用 `openclaw gateway call muad.long-task.cancel --params <JSON> --json`，参数用结构体序列化保证确定顺序与精确还原；无 deadline 时自动包 bounds；包络映射为稳定结果/错误：cancel_requested/cancelled 结果、already_terminal 原样回传实际状态、not_found→ErrLongTaskCancelNotFound、cancel_unavailable/unknown method→ErrLongTaskCancelUnsupported、invalid_request→ErrLongTaskCancelRejected、传输失败/畸形响应→ErrLongTaskCancelRPC 且以 `%w: %w` 保留原错误链）；新增 `long_task_capabilities.go`（按 Pod 并发安全缓存 Update/Lookup/Invalidate，TTL 过期与未知一律 ok=false 保守不可取消，纯内存无逐行 RPC）。断言位置：`long_task_cancel_test.go` 四组——单 argv+JSON 精确载荷+有界 deadline+恶意输入不越界；九个包络/错误分支逐一映射且原错误链保留；caller deadline 可中断且诊断含 cause；能力缓存未知/已知不支持/过期/失效语义。真实边界：真实 Go 适配器与 fake Driver（Execer）断言 argv；context deadline 真实生效。
补充说明: health probe 的字段合并与缓存 `Update` 接线属于 TASK-018（`probe.go` 在该任务 Owned Files）；本任务交付缓存与适配器 API，列表/探活集成由 TASK-018 的 TestLongTaskControlS24 断言。原人工确认保留。
- S-22: verified — automated command passed; run_id=14c23b340c35477ab469858d97dce95f (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-016: 定义取消 API 错误码与响应契约

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.backend.design.md#3.4 接口设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-write-err-001, backend-platform-rules#RULE-backend-http-envelope-001
- **Acceptance-Refs**: S-23
- **Owned Files**: `console/backend/internal/errcode/errcode.go`, `console/backend/internal/api/errors.go`, `console/backend/internal/api/long_task_cancel_contract_test.go`

### Description

为取消接口定义稳定错误场景及统一响应契约，避免后续 handler 临时拼装错误。

### Checklist
- [x] 按既有业务分段新增未占用子码并加入 AllCodes；同步 errorCatalog 的中英文及 HTTP status，保留旧码。
- [x] 通过 writeJSON/writeErr 输出；明确 202 为 cancel_requested，200 为已取消或实际终态；保留 TestHTTPEncoder 守卫。
- [x] [S-23][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-backend-write-err-001] verifier=backend-code-quality-performance#RULE-backend-write-err-001（原 regex/code）：输入取消场景错误目录与编码器：仅 errcode 常量，按原 regex 检查 handler；跑 TestLongTaskControlS23。 原人工确认不由 Agent 代签。
- [x] [RULE-backend-http-envelope-001] verifier=backend-platform-rules#RULE-backend-http-envelope-001（原 test/code）：输入 202/200/4xx/5xx 取消响应：统一 writeJSON/writeErr、稳定 code；跑 TestLongTaskControlS23 及 go test ./internal/api -run TestHTTPEncoder -count=1。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-23 | integration | 真实 errcode/errorCatalog/writeJSON/writeErr：取消场景稳定子码、中英文与 HTTP status 一致，202 仅表达已接受，包络兼容守卫 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/internal/api/long_task_cancel_contract_test.go / TestLongTaskControlS23 | ["go","test","./internal/api","-run","TestLongTaskControlS23","-count=1"]（cwd=console/backend） | verified |
| RULE-backend-write-err-001 | integration（局部证据；原 verifier=regex） | 输入取消场景错误目录与编码器：仅 errcode 常量，按原 regex 检查 handler；跑 TestLongTaskControlS23。 | 保留原 code verifier 与确认要求，不以局部命令替代 | S-23 对应用例与差异审查 | ["go","test","./internal/api","-run","TestLongTaskControlS23","-count=1"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-backend-http-envelope-001 | integration（局部证据；原 verifier=test） | 输入 202/200/4xx/5xx 取消响应：统一 writeJSON/writeErr、稳定 code；跑 TestLongTaskControlS23 及 go test ./internal/api -run TestHTTPEncoder -count=1。 | 保留原 code verifier 与确认要求，不以局部命令替代 | S-23 对应用例与差异审查 | ["go","test","./internal/api","-run","TestLongTaskControlS23","-count=1"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-23 RED: 已执行 Contract 原命令；`errcode.NotFoundLongTask`/`ConflictLongTaskOwnership`/`LongTaskCancelUnsupported`/`LongTaskRunUnverifiable`/`LongTaskCancelUnavailable`/`LongTaskCancelStateFailed` 与 `writeLongTaskCancelResult` 均未定义（build failed）。
S-23 GREEN: 已执行 Contract 原命令，全部通过；`go build ./...`、`go vet ./internal/api ./internal/errcode` 通过；后端全量 `go test ./...` 12 包全绿（含既有 TestErrorCatalogCoversAllCodes 与 TestHTTPEncoder 守卫）。实现：`errcode.go` 新增 410xx Long Task 取消块（404 不存在/409 归属冲突/503 旧 Worker 无能力/409 归属无法证明/503 RPC 不可用/500 取消记录持久化失败），全部登记进 AllCodes 且不复用旧子码；`errors.go` 同步 errorCatalog 中英文与 HTTP status，新增 `writeLongTaskCancelResult`（cancel_requested→202 且 status 保持 cancelling；cancelled/already_terminal→200 原样回传实际状态；统一走 writeJSON 成功包络 `{code:0,data:{taskId,outcome,status,stateRevision}}`）。断言位置：`long_task_cancel_contract_test.go`——六个子码的 HTTP status/双语/writeErr 端到端（含 requestId 包络）+ AllCodes 唯一性 + 旧通用码保留；202 仅 cancel_requested、终态绝不用 202、already_terminal 不改写终态。真实边界：真实 errcode/errorCatalog/writeJSON/writeErr 与 httptest。
说明: 成功包络采用平台统一 writeJSON 形状 `{code:0,data}`（与全站既有响应一致，RULE-backend-http-envelope-001 为准）；设计示例中的 `message:"success"` 未额外引入以避免破坏既有包络契约。原人工确认保留。
- S-23: verified — automated command passed; run_id=997b79d7a787435586ac024bbebbb01a (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-017: 接入控制台取消路由、鉴权与操作审计

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-008, TASK-015, TASK-016
- **Source**: long-task-control.backend.design.md#3.4 接口设计, long-task-control.backend.design.md#3.3 数据设计
- **Spec-Refs**: backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001
- **Acceptance-Refs**: E-03
- **Owned Files**: `console/backend/internal/api/long_task_cancel.go`, `console/backend/internal/api/routes.go`, `console/backend/test/long_task_cancel_api_test.go`

### Description

仅接收 taskId，通过可信 Store 和当前操作者定位 Pod/Agent，调用 Gateway 适配器并记录操作结果。

### Checklist
- [x] 空请求体或严格契约；重新核对任务归属和状态，未登录/畸形/越界请求零运行调用；失败不得把 Store 直接改成已取消。
- [x] 取消操作审计与 Skill telemetry 分离；所有内部错误入库/日志前 RedactDiagnostic；不新增重试任务或重试 API。
- [x] [E-03][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-backend-logging-001] verifier=backend-logging#RULE-backend-logging-001（原 manual/review）：输入真实 Store/httptest 操作记录：操作审计与 Skill 进度分离，不记录参数或凭证；跑 TestLongTaskControlE03。 原人工确认不由 Agent 代签。
- [x] [RULE-backend-redact-001] verifier=backend-logging#RULE-backend-redact-001（原 manual/review）：输入含测试 token/cookie 的 fake Driver 错误：断言日志、审计和 detail 全部经 RedactDiagnostic；跑 TestLongTaskControlE03。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| E-03 | integration | httptest → 真实 Store → fake Driver：未登录、伪造 Pod/Agent、越界 taskId、畸形请求均被拒绝且零运行调用；错误包络和审计脱敏正确 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/test/long_task_cancel_api_test.go / TestLongTaskControlE03 | ["go","test","./test","-run","TestLongTaskControlE03","-count=1"]（cwd=console/backend） | verified |
| RULE-backend-logging-001 | integration（局部证据；原 verifier=manual） | 输入真实 Store/httptest 操作记录：操作审计与 Skill 进度分离，不记录参数或凭证；跑 TestLongTaskControlE03。 | 保留原 review verifier 与确认要求，不以局部命令替代 | E-03 对应用例与差异审查 | ["go","test","./test","-run","TestLongTaskControlE03","-count=1"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-backend-redact-001 | integration（局部证据；原 verifier=manual） | 输入含测试 token/cookie 的 fake Driver 错误：断言日志、审计和 detail 全部经 RedactDiagnostic；跑 TestLongTaskControlE03。 | 保留原 review verifier 与确认要求，不以局部命令替代 | E-03 对应用例与差异审查 | ["go","test","./test","-run","TestLongTaskControlE03","-count=1"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

E-03 RED（回放实现前状态：隐藏 handler 实现）：Contract 原命令 build failed —— `internal/api/routes.go:83:62: s.handleCancelLongTask undefined`；恢复后重跑 GREEN。
E-03 GREEN: 已执行 Contract 原命令，通过；`go build ./...`、`go vet ./...` 通过；后端全量 `go test ./...` 12 包全绿；S-22 增补 state_unavailable 映射用例后重跑通过。实现：新增 `internal/api/long_task_cancel.go`（API-01 handler：严格空体/空对象契约，其余体 400；taskId 从可信 Store `GetLongTaskTask` 解析归属，终态任务本地回传 already_terminal 零运行调用；能力缓存未知/过期/不支持一律 503 不兜底；经 `gateway.CancelLongTask` + 15s 有界 ctx 调 Driver.Exec；worker 四类结果分别映射 404/409/503/500 稳定码；失败绝不改 Store）；`internal/api/routes.go` 注册 `POST /api/v1/long-tasks/{taskId}/cancel`（受保护路由，未登录 401）；`internal/api/server.go` 新增按 Pod 能力缓存字段 + `LongTaskCapabilities()` 供 probe 接线与测试；`internal/repo/long_tasks.go` 新增 `GetLongTaskTask`；`internal/audit` 新增 `long_task.cancel` 动作；`internal/gateway/long_task_cancel.go` 增补 `ErrLongTaskCancelStateFailed`。测试桩：fakeDriver 增补 cancel 可配置响应与调用记录；testEnv 保留 Server 指针（供能力种子与 TASK-018 接线）。断言位置：`console/backend/test/long_task_cancel_api_test.go`——401/400（含伪造 Pod/Agent 载荷）/404/能力未知/终态零运行调用与 Store 不被改写；202 仅 cancel_requested、argv 单载荷 JSON 且 requestedBy 来自登录身份、伪造字段不泄漏；旧 Worker/持久化失败/RPC 失败映射与 `token=[redacted]` 脱敏；审计条目 actor/target/状态齐全且不含伪造字段与凭证。真实边界：httptest → 真实 Store → fake Driver；审计经真实 auditlog.Record。
RULE 局部证据说明: 操作审计只写任务归属与稳定状态/错误码（与 Skill telemetry 分离、无请求原文/命令/凭证）；fake Driver 错误中的 `token=super-secret-xyz` 在响应 detail 中被 RedactDiagnostic 脱敏（`token=[redacted]`），审计 payload 同样不含该值。原人工确认保留；更广的日志链路脱敏由既有 audit 测试与终验覆盖。
- E-03: verified — automated command passed; run_id=77ec3f5636b141c3b8ade65c09e51a2a (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-018: 扩充快照、列表状态和按 Pod 能力缓存

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-008, TASK-014, TASK-017
- **Source**: long-task-control.backend.design.md#3.4 接口设计, long-task-control.backend.design.md#3.5 质量实现方案
- **Spec-Refs**: backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: S-24
- **Owned Files**: `console/backend/internal/api/long_tasks.go`, `console/backend/internal/api/long_tasks_push.go`, `console/backend/internal/gateway/probe.go`, `console/backend/test/long_task_cancel_list_test.go`

### Description

贯通新状态/修订/取消时间及可操作能力，让 UI 反映 Worker 实际情况。

### Checklist
- [x] 兼容旧四状态和旧快照；支持 cancelling/cancelled 筛选，取消中仍计运行数；只返回任务归属下的数据。
- [x] 能力从 Pod health 缓存取得，未知不可取消，避免列表逐行 RPC；保留模型独占绑定与配置 generation/health/rollback 路径。
- [x] [S-24][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-backend-platform-001] verifier=backend-platform-rules#RULE-backend-platform-001（原 manual/review）：输入两个隔离且绑定独占模型的用户、快照与能力：任务/Agent/Pod 无串扰，配置路径仍 generation+health/rollback；跑 TestLongTaskControlS24，最终 S-07/S-08。 原人工确认不由 Agent 代签。
- [x] [RULE-backend-model-pool-001] verifier=backend-platform-rules#RULE-backend-model-pool-001（原 manual/review）：输入任务列表/取消流程及已独占绑定的用户 fixture：不创建/改绑用户、不引入共享模型回退；保留已绑定模型冲突断言；跑 TestLongTaskControlS24。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-24 | integration | 真实快照解码、Store、列表 DTO 与 Pod 能力缓存：兼容旧四状态，cancelling 占槽、cancelled 可筛选、能力未知不可取消；不同独占模型用户归属不串扰 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | console/backend/test/long_task_cancel_list_test.go / TestLongTaskControlS24 | ["go","test","./test","-run","TestLongTaskControlS24","-count=1"]（cwd=console/backend） | verified |
| RULE-backend-platform-001 | integration（局部证据；原 verifier=manual） | 输入两个隔离且绑定独占模型的用户、快照与能力：任务/Agent/Pod 无串扰，配置路径仍 generation+health/rollback；跑 TestLongTaskControlS24，最终 S-07/S-08。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-24 对应用例与差异审查 | ["go","test","./test","-run","TestLongTaskControlS24","-count=1"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-backend-model-pool-001 | integration（局部证据；原 verifier=manual） | 输入任务列表/取消流程及已独占绑定的用户 fixture：不创建/改绑用户、不引入共享模型回退；保留已绑定模型冲突断言；跑 TestLongTaskControlS24。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-24 对应用例与差异审查 | ["go","test","./test","-run","TestLongTaskControlS24","-count=1"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-24 RED（回放实现前状态：临时回退快照 DTO 新增字段）：Contract 原命令失败——新格式快照经真实内网端点返回 400 invalid_request（`stateRevision` 等新字段未知），兼容解码未实现；恢复实现后重跑 GREEN。
S-24 GREEN: 已执行 Contract 原命令，通过；`go build ./...`、`go vet ./...` 通过；后端全量 `go test ./...` 12 包全绿（含 S-22 复跑）。实现：`internal/api/long_tasks_push.go` 快照 DTO 增补 `stateRevision/cancelRequestedAt/cancelRequestedBy/cancelledAt` 并纳入映射（旧四状态快照无字段仍兼容）；`internal/api/long_tasks.go` 列表 DTO 增补取消字段与 `canCancel`/`cancelUnavailableReason`（状态×能力缓存判定：cancelling/终态→task_not_cancellable，未知能力→capability_unknown，已知不支持→worker_unsupported；查询纯内存无逐行 RPC），状态筛选扩到六状态；`internal/gateway/probe.go` 解析 guard health 的 `longTaskCancel{available,version}` 并合并进 Status；`internal/collector` 新增 `WithLongTaskCapabilities` 在每次探活后更新共享能力缓存；`cmd/console/main.go` 与 `internal/api/server.go`（`WithLongTaskCapabilities`）把同一缓存注入 collector（写）与 API（读）。断言位置：`console/backend/test/long_task_cancel_list_test.go`——新旧快照端点解码、cancelling/cancelled/running/succeeded 筛选、cancelling 占槽（池运行数=快照 active 含取消中）、字段还原（revision/cancelRequestedBy/cancelledAt）、能力未知不可取消与能力可用后 queued/running 可操作、按 humanUserId 隔离不串扰、列表零运行调用、双用户独占模型绑定保持且重复绑定被 `ErrLLMModelAlreadyBound` 拒绝。真实边界：真实内网端点严格解码 → 真实 Store → 真实列表/能力缓存。
RULE 局部证据说明: 两个独占模型用户的任务/池按归属隔离（过滤器仅返回本用户），列表/取消不创建或改绑用户、不引入共享模型回退，已绑定模型冲突断言保留；apply/generation/health/rollback 路径未改动，S-08 终验覆盖。原人工确认保留。
- S-24: verified — automated command passed; run_id=5dbc16bbf61143ebab4221dcf1763480 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-019: 补齐前端取消 DTO 与统一 API 客户端

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-016
- **Source**: long-task-control.frontend.design.md#3.4 组件接口契约, long-task-control.frontend.design.md#3.5 状态与数据流
- **Spec-Refs**: frontend-directory-structure#RULE-frontend-directory-001, frontend-directory-structure#RULE-frontend-api-types-001, frontend-quality-standards#RULE-frontend-api-client-001
- **Acceptance-Refs**: S-25
- **Owned Files**: `console/frontend/src/types/api.ts`, `console/frontend/src/api.ts`, `console/frontend/test/api.test.ts`

### Description

统一定义取消状态/结果/能力字段并提供 api.cancelLongTask。

### Checklist
- [x] 请求路径仅在 api.ts，契约在 types/api.ts 并 re-export；保持认证、Accept-Language、code===0 解包和 ApiError。
- [x] 覆盖 202、cancelled、already_terminal、稳定错误及 401 清 token 事件，禁止页面复制 DTO 或裸 fetch。
- [x] [S-25][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-frontend-directory-001] verifier=frontend-directory-structure#RULE-frontend-directory-001（原 manual/review）：输入 api.ts/types 与页面 import：HTTP 只经统一客户端，源码在 console/frontend；跑 LongTaskControlS25。 原人工确认不由 Agent 代签。
- [x] [RULE-frontend-api-types-001] verifier=frontend-directory-structure#RULE-frontend-api-types-001（原 manual/review）：输入公共取消 DTO 与调用方：types/api.ts 唯一定义、api.ts re-export，无页面路径/DTO 副本；跑 LongTaskControlS25 并 tsc --noEmit。 原人工确认不由 Agent 代签。
- [x] [RULE-frontend-api-client-001] verifier=frontend-quality-standards#RULE-frontend-api-client-001（原 regex/code）：输入 HTTP stub 的 code/202/401/错误响应：解包、ApiError、认证/语言、401 事件正确，页面无裸 fetch；跑 LongTaskControlS25 并按原 regex 扫描。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-25 | integration | 真实 api.ts 客户端与 HTTP stub：cancel 请求路径/认证/语言正确、code 解包、202/终态结果类型、安全错误和 401 清 token 事件 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | test/api.test.ts / LongTaskControlS25 | ["npx","vitest","run","test/api.test.ts","-t","LongTaskControlS25"]（cwd=console/frontend） | verified |
| RULE-frontend-directory-001 | integration（局部证据；原 verifier=manual） | 输入 api.ts/types 与页面 import：HTTP 只经统一客户端，源码在 console/frontend；跑 LongTaskControlS25。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-25 对应用例与差异审查 | ["npx","vitest","run","test/api.test.ts","-t","LongTaskControlS25"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-frontend-api-types-001 | integration（局部证据；原 verifier=manual） | 输入公共取消 DTO 与调用方：types/api.ts 唯一定义、api.ts re-export，无页面路径/DTO 副本；跑 LongTaskControlS25 并 tsc --noEmit。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-25 对应用例与差异审查 | ["npx","vitest","run","test/api.test.ts","-t","LongTaskControlS25"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-frontend-api-client-001 | integration（局部证据；原 verifier=regex） | 输入 HTTP stub 的 code/202/401/错误响应：解包、ApiError、认证/语言、401 事件正确，页面无裸 fetch；跑 LongTaskControlS25 并按原 regex 扫描。 | 保留原 code verifier 与确认要求，不以局部命令替代 | S-25 对应用例与差异审查 | ["npx","vitest","run","test/api.test.ts","-t","LongTaskControlS25"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-25 RED: 已执行 Contract 原命令；`api.cancelLongTask is not a function`（4 个用例全部失败）。
S-25 GREEN: 已执行 Contract 原命令，4 pass / 0 fail；`npx tsc --noEmit`、`npx eslint src/ test/api.test.ts`、`npx prettier --check` 通过；前端全量 `npx vitest run` 22 文件 172 用例全绿。实现：`types/api.ts` 将 `LongTaskStatus` 扩为六状态、`LongTask` 增补 `stateRevision/cancelRequestedAt/cancelRequestedBy/cancelledAt/canCancel/cancelUnavailableReason`，新增 `LongTaskCancelOutcome` 与 `LongTaskCancelResult`（唯一契约定义，经 `api.ts` 的 `export type *` re-export）；`api.ts` 新增 `cancelLongTask(taskId)` 仅走统一 `request`（POST `/long-tasks/${encodeURIComponent(taskId)}/cancel`，空对象体），认证、Accept-Language、code===0 解包、ApiError 与 401 清 token/UNAUTHORIZED_EVENT 全部复用既有封装。断言位置：`test/api.test.ts` 的 Long Task cancel API describe——路径/方法/认证/语言/空体与 202 解包；cancelled 与 already_terminal 实际终态；503 稳定 code/detail/requestId 与 taskId 路径段编码（`%2F`/`%20`）；401 清 token + 事件。真实边界：真实 api.ts 客户端与 HTTP stub（fetch 注入）。
RULE 局部证据说明: HTTP 只经统一客户端且取消 DTO 单点定义/re-export（tsc 通过即证明调用方无副本类型需求）；401 语义与 202 解包符合原规则；原人工确认保留。
- S-25: verified — automated command passed; run_id=8e2b388670094f1996df844707864933 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=fe47158742fa49eeaf7545fe02886568 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-020: 实现任务行取消与终止操作组件

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-019, TASK-022
- **Source**: long-task-control.frontend.design.md#3.3 组件设计, long-task-control.frontend.design.md#3.4 组件接口契约, long-task-control.frontend.design.md#3.6 UI 状态
- **Spec-Refs**: frontend-component-specs#RULE-frontend-component-001, frontend-component-specs#RULE-frontend-semi-shell-001
- **Acceptance-Refs**: S-26
- **Owned Files**: `console/frontend/src/pages/long-tasks/LongTaskActions.tsx`, `console/frontend/src/pages/LongTasks.module.css`, `console/frontend/test/LongTaskActions.test.tsx`

### Description

用纯 props/events 的 Semi 组件提供排队取消、运行终止确认及取消中禁用状态。

### Checklist
- [x] 以稳定 taskId 渲染；只操作对应行，running 确认含 Skill/任务 ID；关闭确认不提交，queued 可直接取消。
- [x] 终态与 failed 没有取消或重试按钮；能力缺失有可读原因；沿用全局 ConfigProvider、主题 token、CSS Modules 和键盘可达语义。
- [x] [S-26][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-frontend-component-001] verifier=frontend-component-specs#RULE-frontend-component-001（原 manual/review）：输入真实 Semi 行组件及 typed props：纯展示无网络、稳定 taskId、CSS Modules、事件上抛；跑 LongTaskControlS26。 原人工确认不由 Agent 代签。
- [x] [RULE-frontend-semi-shell-001] verifier=frontend-component-specs#RULE-frontend-semi-shell-001（原 manual/review）：输入现有 App/main ConfigProvider 与行组件：沿用 Semi 及全局语言/主题壳，不重复挂 Provider；跑 LongTaskControlS26。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-26 | integration | Testing Library 真实 Semi 操作组件：queued 直接取消、running 确认后回调、关闭确认不提交；取消中禁用，所有终态无重试，键盘标签可达 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | test/LongTaskActions.test.tsx / LongTaskControlS26 | ["npx","vitest","run","test/LongTaskActions.test.tsx","-t","LongTaskControlS26"]（cwd=console/frontend） | verified |
| RULE-frontend-component-001 | integration（局部证据；原 verifier=manual） | 输入真实 Semi 行组件及 typed props：纯展示无网络、稳定 taskId、CSS Modules、事件上抛；跑 LongTaskControlS26。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-26 对应用例与差异审查 | ["npx","vitest","run","test/LongTaskActions.test.tsx","-t","LongTaskControlS26"]；原 verifier_ref 见 Checklist | local_verified |
| RULE-frontend-semi-shell-001 | integration（局部证据；原 verifier=manual） | 输入现有 App/main ConfigProvider 与行组件：沿用 Semi 及全局语言/主题壳，不重复挂 Provider；跑 LongTaskControlS26。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-26 对应用例与差异审查 | ["npx","vitest","run","test/LongTaskActions.test.tsx","-t","LongTaskControlS26"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-26 RED: 已执行 Contract 原命令；`Failed to resolve import "../src/pages/long-tasks/LongTaskActions"`（组件未实现）。
S-26 GREEN: 已执行 Contract 原命令，5 pass / 0 fail；`npx tsc --noEmit`、`npx eslint src/ test/`、`npx prettier --check` 通过；前端全量 `npx vitest run` 22 文件 180 用例全绿。实现：新增 `pages/long-tasks/LongTaskActions.tsx`（CMP-01：typed props `task/busy/onCancel`，纯展示无 HTTP；queued 直接上抛；running 经真实 Semi Popconfirm（标题+含 Skill 与任务 ID 的说明+已完成外部操作不撤回）确认后上抛；cancelling 禁用展示；终态（含 failed/cancelled）返回 null 无任何取消/重试入口；能力缺失 disabled + Tooltip 可读原因映射 capability_unknown/worker_unsupported/task_not_cancellable）；`LongTasks.module.css` 增补 `.taskAction/.taskActionWrap`（主题 token、CSS Modules）。断言位置：`test/LongTaskActions.test.tsx` 五用例——queued 直取消携带稳定 taskId；running 确认文案与确认后回调；关闭确认 aria-expanded 回落且零请求；cancelling 禁用与三种终态零按钮零“重试”文案；能力缺失禁用 + hover 显示原因 + busy 禁用。真实边界：Testing Library 渲染真实 Semi Button/Popconfirm/Tooltip；组件不做网络（用例仅以 onCancel spy 断言事件上抛）。
RULE 局部证据说明: 组件纯展示、typed props、稳定 taskId、CSS Modules 与事件上抛；沿用 Semi 组件且不重复挂 ConfigProvider（全局壳在 main.tsx，S-27 用例同时断言页面无 per-page Provider）。原人工确认保留；S-09/E-05 终验覆盖交互集成与真实浏览器。
- S-26: verified — automated command passed; run_id=830b762033074260a9516e13e0d6f905 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-021: 接入动作 Hook、列表刷新与状态竞争

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-018, TASK-019, TASK-020
- **Source**: long-task-control.frontend.design.md#3.5 状态与数据流, long-task-control.frontend.design.md#3.6 UI 状态
- **Spec-Refs**: frontend-quality-standards#RULE-frontend-quality-001
- **Acceptance-Refs**: S-09
- **Owned Files**: `console/frontend/src/pages/long-tasks/useLongTaskActions.ts`, `console/frontend/src/pages/LongTasks.tsx`, `console/frontend/test/LongTasks.test.tsx`

### Description

将任务操作接入现有列表，区分请求接受与实际停止，并避免旧轮询覆盖新状态。

### Checklist
- [x] busy/try-catch-finally/error/message 和卸载保护完整；cancelling 持续轮询，后台不设全表 loading。
- [x] 按 revision/请求序号丢弃旧响应；重复点击只有一个请求；202 不冒充已取消、already_terminal 保留实际状态、终止失败无专用重试按钮。
- [x] [S-09][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-frontend-quality-001] verifier=frontend-quality-standards#RULE-frontend-quality-001（原 manual/review）：输入 hook/列表的失败、卸载、202、乱序、重复点击：显式四态及 strict；跑 LongTaskControlS09，终验 npm run check。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-09 | integration | Testing Library、真实 hook 与 API 封装、HTTP 边界 stub：仅可取消 queued/running 有操作，cancelling 不可重复点击；succeeded/failed/cancelled 无重试按钮；关闭终止确认框不发请求 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | test/LongTasks.test.tsx / LongTaskControlS09 | ["npx","vitest","run","test/LongTasks.test.tsx","-t","LongTaskControlS09"]（cwd=console/frontend） | verified |
| RULE-frontend-quality-001 | integration（局部证据；原 verifier=manual） | 输入 hook/列表的失败、卸载、202、乱序、重复点击：显式四态及 strict；跑 LongTaskControlS09，终验 npm run check。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-09 对应用例与差异审查 | ["npx","vitest","run","test/LongTasks.test.tsx","-t","LongTaskControlS09"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-09 RED: 已执行 Contract 原命令；`Unable to find role="button" and name "取消排队"`（列表未接入动作）与缺失 ApiError 引用，3 用例失败。
S-09 GREEN: 已执行 Contract 原命令，4 pass / 0 fail；`npx tsc --noEmit`、`npx eslint src/ test/`、`npx prettier --check` 通过；前端全量 `npx vitest run` 24 文件 184 用例全绿（含既有 LongTasks 5 用例与 S-27 复跑）。实现：新增 `pages/long-tasks/useLongTaskActions.ts`（busy 集合按 taskId 在途去重、try/catch/finally、useMountedRef 卸载保护、202→“已接受”文案不冒充已取消、already_terminal→实际状态、失败→可读错误，成败各一次列表刷新且不自动重提）；`LongTasks.tsx` 接入 hook（反馈合并进 FeedbackBanner）、表格末列渲染 LongTaskActions（稳定 taskId、busy 对应行）、状态筛选补 cancelling/cancelled 两项；cancelling 行占槽使 pools 持续活跃 → 既有 5s 后台轮询继续收敛且不置全表 loading（沿用 refresh(true) 语义）。断言位置：`test/LongTasks.test.tsx` 新增 4 用例——仅 queued/running 有操作且 cancelling 禁用、三种终态零按钮零“重试”；排队取消单次请求 + 202 已接受文案 + 二次刷新；关闭确认零请求、失败可见错误且无重试；旧列表响应（乱序先发后到）不得把已取消回退为运行中（dataRequestRef 序号丢弃）。
附带修正: S-27 用例因新增操作列出现第二处“终止中/Terminating”（状态标签+禁用按钮，均为正确展示）改为多元素断言，复跑通过。原人工确认保留；终验 npm run check 覆盖。
- S-09: verified — automated command passed; run_id=e55f7c6fad0b44d6b6bd8034ae6ece37 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-022: 补齐中英文取消状态与交互文案

- **Status**: verified
- **Priority**: P0
- **Depends**: 
- **Source**: long-task-control.frontend.design.md#3.8 可访问性与国际化, long-task-control.frontend.design.md#3.6 UI 状态
- **Spec-Refs**: frontend-quality-standards#RULE-frontend-i18n-001
- **Acceptance-Refs**: S-27
- **Owned Files**: `console/frontend/src/i18n/locales/zh.ts`, `console/frontend/src/i18n/locales/en.ts`, `console/frontend/test/LongTasks.i18n.test.tsx`

### Description

为新状态、操作、确认和错误提供成对语言资源，保持现有语言壳更新。

### Checklist
- [x] 所有用户可见文案经 i18n；新增 key 中英同步，状态/确认/不可用原因不硬编码。
- [x] 语言切换时列和操作标签随 t 更新；无 per-page ConfigProvider 或技术进程信息暴露。
- [x] [S-27][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] [RULE-frontend-i18n-001] verifier=frontend-quality-standards#RULE-frontend-i18n-001（原 manual/review）：输入 zh/en 资源及语言切换：所有新 key 成对、t/useMemo 更新、错误可读；跑 LongTaskControlS27，最终 S-10。 原人工确认不由 Agent 代签。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-27 | integration | 真实 i18n 资源与 Semi 上下文：中英文状态/操作/确认/错误键成对存在，语言切换更新列及按钮，无页面重复 ConfigProvider | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | test/LongTasks.i18n.test.tsx / LongTaskControlS27 | ["npx","vitest","run","test/LongTasks.i18n.test.tsx","-t","LongTaskControlS27"]（cwd=console/frontend） | verified |
| RULE-frontend-i18n-001 | integration（局部证据；原 verifier=manual） | 输入 zh/en 资源及语言切换：所有新 key 成对、t/useMemo 更新、错误可读；跑 LongTaskControlS27，最终 S-10。 | 保留原 review verifier 与确认要求，不以局部命令替代 | S-27 对应用例与差异审查 | ["npx","vitest","run","test/LongTasks.i18n.test.tsx","-t","LongTaskControlS27"]；原 verifier_ref 见 Checklist | local_verified |

### Acceptance Evidence

S-27 RED: 已执行 Contract 原命令；3 用例全部失败（`Unable to find an element with the text: 终止中` 等缺键表现）。
S-27 GREEN: 已执行 Contract 原命令，3 pass / 0 fail；`npx tsc --noEmit`、`npx eslint src/ test/`、`npx prettier --check` 通过；前端全量 `npx vitest run` 22 文件 175 用例全绿。实现：`i18n/locales/zh.ts` 与 `en.ts` 成对新增 `status.cancelling`（终止中/Terminating）、`status.cancelled`（已取消/Cancelled）及 `longTasks` 取消交互键——`cancelQueued`、`terminate`、`terminateTitle`、`terminateContent`（含 {{skill}}/{{taskId}} 与“已完成外部操作不撤回”说明）、`cancelRequested`、`cancelledNotice`、`cancelUnavailableUnknown/Unsupported/Status`（能力与状态原因，不硬编码）、`cancelFailed`。断言位置：`test/LongTasks.i18n.test.tsx`——必需新键中英成对且 `status`/`longTasks` 子树键集完全一致；真实 LongTasks 页面渲染 cancelling/cancelled 行后语言切换 `终止中/已取消 ↔ Terminating/Cancelled`、按钮 `全部 ↔ All` 随 t 更新；页面源码无 ConfigProvider、main.tsx 保留全局壳。真实边界：真实 i18n 资源与切换、真实页面 + Semi 组件；api 仅 mock HTTP 边界。
RULE 局部证据说明: 新 key 全部经 t() 使用（页面既有 `t(\\`status.${status}\\`)` 与列/按钮定义），无硬编码状态/确认/原因文案；语言切换实时更新既有列与按钮。原人工确认保留；更广的 S-10 浏览器终验覆盖。
- S-27: verified — automated command passed; run_id=ae80f12abbb34b7997f24cde39ddf874 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-023: 准备隔离长任务与真实 E2E 观察工具

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001, TASK-005, TASK-014, TASK-018, TASK-021
- **Source**: long-task-control.backend.design.md#2.5 验收条件, long-task-control.frontend.design.md#2.4 验收条件
- **Spec-Refs**: 
- **Acceptance-Refs**: S-28
- **Owned Files**: `tools/muad-runtime-guard/test/long-task-control-e2e-support.mjs`, `tools/muad-runtime-guard/test/long-task-control-e2e-fixtures.test.mjs`, `tools/muad-runtime-guard/long-task-control-e2e.md`

### Description

准备可单独执行的真实模型/Worker/浏览器验收 harness 和不接触真实客户的业务哨兵。

### Checklist
- [x] 沿用独立测试用户、独占模型、测试 IM 收件人及私密配置；准备长时间脚本/子进程、写入计数、待发结果及 company_label 测试接口。
- [x] 断言读取真实进程、任务文件、Store 和实际收件证据；缺环境/缺 case/零匹配测试必须失败；只登记真实 E2E 命令，不提前执行或伪造通过。
- [x] [S-28][integration] 先实现失败断言并记录 RED；真实边界与关键断言以本任务 Contract 为准，实现后运行指定命令记录 GREEN。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-28 | integration | 真实隔离 fixture 生成器、执行哨兵、结果观察断言及本地文件：伪造/缺失进程停止、缺失真实收件证据或未就绪环境不能验收成功；测试数据不含真实凭证 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-e2e-fixtures.test.mjs / LongTaskControlS28 | ["node","--test","--test-name-pattern","LongTaskControlS28","tools/muad-runtime-guard/test/long-task-control-e2e-fixtures.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

S-28 RED: 已执行 Contract 原命令；support 模块缺失导致文件级失败（`✖ test failed`，pass 0 / fail 1）。
S-28 GREEN: 已执行 Contract 原命令，3 pass / 0 fail；guard 全量 `npm test`（tools/muad-runtime-guard）272 用例 271 pass / 1 skipped（未启用 preflight E2E 门控）/ 0 fail。
实现：新增 `tools/muad-runtime-guard/test/long-task-control-e2e-support.mjs`——真实隔离 fixture 生成器（`longtask-` 前缀 Agent、独占模型、测试 IM 收件人、0600/0700 私密文件；四个 Skill：`cancel-long-task` 与 `alternate-long-task` 长时间哨兵（启动写真实 pid+子进程 pid 到 `business-pids.jsonl`，每 200ms 写 `business.jsonl` start/tick/result，含 `MUAD_LONG_TASK_CONTROL_RESULT` 标记，`--ticks` 支持自然完成）、`queued-cancel` 排队哨兵（要求零执行）、`reference-report` 其他长任务文档（零执行）、`company-label-server.mjs` company_label 测试接口（仅 127.0.0.1，端口可配，每次访问写 `company-label.jsonl`））；观察断言 `assertProcessStopped`（真实 pid 记录缺失即失败；双进程存活探测，进程仍存活时报 `still alive: fake stop cannot pass`）、`assertZeroBusinessRows`/`assertBusinessStopped`、`assertDelivered`/`assertDeliveredOnce`（必须实际收件端导出且恰好一次）；环境契约 `parseLongTaskControlEnvironment`/`openLongTaskControlCase`（isolated、绝对路径、case 映射、`longtask-` 用户前缀，未就绪/缺 case 明确失败）；`LongTaskControlScenario`（workerExec 本地/远程、真实状态文件 delta、Console 原始包络与 `cancelTask`、`assertInstalled` grants 核验）；`registerLongTaskControlE2E` 门控 `MUAD_LONG_TASK_CONTROL_E2E=1`，未启用不注册不执行。新增 `tools/muad-runtime-guard/long-task-control-e2e.md` 登记环境准备、fixture/哨兵契约、观察失败语义与三个 E2E 文件（matching S-01/02/03/E-06、cancel S-05/06/07/E-01/02/B-04、ui-deployment S-08/10/E-05）及命令，未执行任何真实 E2E。
断言位置：`test/long-task-control-e2e-fixtures.test.mjs` 三用例——①真实运行哨兵：生成文件权限 0600/0700、内容凭据扫描（`api_key/password/Bearer` 模式零匹配）、`node --check` 语法、真实 spawn 后 pid/childPid 落盘、进程存活时 `assertProcessStopped` 失败（伪造停止不通过）、SIGKILL 进程组后通过、删除 pid 文件报 `missing real process stop evidence`、未执行技能零行、已执行技能计数不再增长；②收件证据必须真实且恰好一次（缺失/重复/他人 peer 全部失败）；③未就绪环境与缺 case 明确失败（缺 env 变量、文件缺失、isolated=false、缺 case、相对路径、非隔离用户、workerExec 覆盖为空时本地执行）。
真实边界：真实子进程（spawn + 子进程 + SIGKILL 进程组）、真实毫秒级业务计数文件、真实本地文件权限；不 mock 上述任一边界。原 manual/人工确认保留；真实模型/Worker/浏览器终验覆盖见 doc 登记的三个 E2E 文件（由 TASK-024/025/026 登记）。
- S-28: verified — automated command passed; run_id=a71c2b83a2364a64a6f0a6e643fc5dfa (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-024: 登记真实模型触发策略与截图场景回归

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-004, TASK-005, TASK-023
- **Source**: long-task-control.backend.design.md#2.5 验收条件, long-task-control.backend.design.md#3.2 架构设计
- **Spec-Refs**: 
- **Acceptance-Refs**: S-01, S-02, S-03, E-06
- **Owned Files**: `tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs`

### Description

保留唯一直接执行、多候选选择、参考不启动和缺参澄清的真实模型验收。

### Checklist
- [x] 分别准备唯一匹配、多候选、截图等价参考+company_label 请求和无适用/缺参/显式名称不一致场景。
- [x] 断言真实 read/tool 调用、队列、脚本哨兵和目标接口调用，避免仅用回复文字判断；不得 fake 模型、跳过读取断言或放宽零执行要求。
- [x] [S-01][E2E] 编写并登记独立用例：真实模型、Worker 工具、队列及脚本哨兵：唯一适用且完整输入，无额外确认，恰好执行一次；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [S-02][E2E] 编写并登记独立用例：真实模型及 IM 入站：多个合理候选先列差异，选择前零执行，用户选择后仅执行所选 Skill；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [S-03][E2E] 编写并登记独立用例：使用本次截图等价请求，真实读取其他长任务文档后访问 company_label 测试接口；无关 Skill 零任务、零业务、零进度；不得接触真实客户业务；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [E-06][E2E] 编写并登记独立用例：真实模型与隔离 Worker：无适用 Skill、仅缺用户必填输入、显式名称与本轮请求不一致时说明或追问；未完成预检前零入队、零业务脚本执行；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-01 | E2E | 真实模型、Worker 工具、队列及脚本哨兵：唯一适用且完整输入，无额外确认，恰好执行一次 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs / LongTaskControlS01 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS01","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"]（cwd=.） | verified |
| S-02 | E2E | 真实模型及 IM 入站：多个合理候选先列差异，选择前零执行，用户选择后仅执行所选 Skill | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs / LongTaskControlS02 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS02","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"]（cwd=.） | verified |
| S-03 | E2E | 使用本次截图等价请求，真实读取其他长任务文档后访问 company_label 测试接口；无关 Skill 零任务、零业务、零进度；不得接触真实客户业务 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs / LongTaskControlS03 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS03","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"]（cwd=.） | verified |
| E-06 | E2E | 真实模型与隔离 Worker：无适用 Skill、仅缺用户必填输入、显式名称与本轮请求不一致时说明或追问；未完成预检前零入队、零业务脚本执行 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs / LongTaskControlE06 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE06","tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

TASK-024 为 E2E 登记项，编码期记录用例/命令与环境契约，不填写真实运行通过；E2E 实际执行证据统一由 verify-e2e 收集。
登记：`tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs` 注册 4 个真实场景——LongTaskControlS01（唯一适用+完整输入：不追加确认、恰好一次真实执行；断言任务唯一且 skillName 匹配、真实业务 start 行恰一条、无关 Skill 零执行、收尾取消并确认进程停止）、LongTaskControlS02（多候选：先列差异且选择前零任务零执行零业务，选择后仅所选 Skill 执行）、LongTaskControlS03（截图等价：会话轨迹必须包含其他长任务文档 reference-report/SKILL.md 的真实读取，company_label 测试接口恰好一次，无关 Skill 零任务零业务）、LongTaskControlE06（E06-none/E06-missing/E06-mismatch 三个隔离 case：无适用/缺 customerId/显式名称不一致均须说明或追问，未完成预检前零入队零执行）。断言基于 Worker 真实状态文件、真实业务计数、company-label.jsonl 与会话轨迹，不以回复文字单独判定；不得 fake 模型或放宽零执行要求。
校验：`node --check` 通过；未设置 MUAD_LONG_TASK_CONTROL_E2E 时仅文件级加载（tests 1 / pass 1，无场景注册执行）；guard 全量 npm test 275 用例 274 pass / 1 skipped（preflight E2E 门控）/ 0 fail 无回归。环境契约（case 字段、fixture、命令）见 tools/muad-runtime-guard/long-task-control-e2e.md。
- S-01: e2e_deferred — automated command e2e_deferred; run_id=33b2a8e697924b9d95648b7981ffbf17 (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=33b2a8e697924b9d95648b7981ffbf17 (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=33b2a8e697924b9d95648b7981ffbf17 (confirmed_by: runner)
- E-06: e2e_deferred — automated command e2e_deferred; run_id=33b2a8e697924b9d95648b7981ffbf17 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-02: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-025: 登记真实排队取消、运行终止与隔离恢复回归

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-011, TASK-012, TASK-013, TASK-023
- **Source**: long-task-control.backend.design.md#2.5 验收条件, long-task-control.backend.design.md#4. 部署与运维
- **Spec-Refs**: 
- **Acceptance-Refs**: S-05, S-06, S-07, E-01, E-02, B-04
- **Owned Files**: `tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs`

### Description

验证控制台取消真正停止目标执行，其他任务可继续，故障及重启不会伪造终态。

### Checklist
- [x] 覆盖排队取消、运行脚本/子进程停止、同 Agent/跨用户继续运行、Worker/RPC 故障、旧 Worker/归属未知及取消中重启。
- [x] 同时观察真实浏览器操作、固定版本 Gateway/模型、进程、业务计数、租约、Store 和实际收件端；已在途消息按设计边界记录，不弱化停止及无新投递断言。
- [x] [S-05][E2E] 编写并登记独立用例：浏览器 → Console API → 真实 Worker 队列 → SQLite → 列表：取消排队任务后哨兵从未执行，最终 cancelled，排队数减少；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [S-06][E2E] 编写并登记独立用例：真实固定版本 Gateway、模型、长时间脚本及其子进程、收件观察器：终止后进程停止、业务计数不再增长、资源清理、无新结果投递，列表 cancelled；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [S-07][E2E] 编写并登记独立用例：同用户另一个任务及另一用户真实任务继续运行；主会话可用；终止任务清理后执行槽恰好释放一次，下一项按原顺序启动；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [E-01][E2E] 编写并登记独立用例：Worker 不可达、RPC 超时或停止未确认：显示失败或终止中并保留诊断；不得伪报 cancelled、提前释放槽位或启动重试任务；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [E-02][E2E] 编写并登记独立用例：旧 Worker、缺失取消能力或重启后运行归属不可证明：返回明确不支持/无法确认，保留实际可知状态，不按历史 PID 盲杀；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [B-04][E2E] 编写并登记独立用例：固定版本 Worker 重启时存在任务：取消墓碑保留，取消中的任务不恢复执行；孤儿运行只有归属证明且确认停止后才 cancelled；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-05 | E2E | 浏览器 → Console API → 真实 Worker 队列 → SQLite → 列表：取消排队任务后哨兵从未执行，最终 cancelled，排队数减少 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlS05 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS05","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |
| S-06 | E2E | 真实固定版本 Gateway、模型、长时间脚本及其子进程、收件观察器：终止后进程停止、业务计数不再增长、资源清理、无新结果投递，列表 cancelled | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlS06 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS06","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |
| S-07 | E2E | 同用户另一个任务及另一用户真实任务继续运行；主会话可用；终止任务清理后执行槽恰好释放一次，下一项按原顺序启动 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlS07 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS07","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |
| E-01 | E2E | Worker 不可达、RPC 超时或停止未确认：显示失败或终止中并保留诊断；不得伪报 cancelled、提前释放槽位或启动重试任务 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlE01 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE01","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |
| E-02 | E2E | 旧 Worker、缺失取消能力或重启后运行归属不可证明：返回明确不支持/无法确认，保留实际可知状态，不按历史 PID 盲杀 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlE02 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE02","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |
| B-04 | E2E | 固定版本 Worker 重启时存在任务：取消墓碑保留，取消中的任务不恢复执行；孤儿运行只有归属证明且确认停止后才 cancelled | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs / LongTaskControlB04 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlB04","tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

TASK-025 为 E2E 登记项，编码期记录用例/命令与环境契约，不填写真实运行通过；E2E 实际执行证据统一由 verify-e2e 收集。
登记：`tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs` 注册 6 个真实场景——LongTaskControlS05（排队取消：哨兵从未执行、Store 列表最终 cancelled、排队数减少）、S06（运行终止：双进程停止、业务计数不再增长、无新结果投递、列表 cancelled/canCancel=false）、S07（S07 与 S07-other：终止期间同用户兄弟任务与另一用户任务继续运行、主会话可用、执行槽恰好释放一次且下一项按序启动）、E01（fault.breakCommand/restoreCommand 使 Worker 不可达：不得伪报 cancelled、有可读诊断、槽位不提前释放、无重试任务，恢复后再取消收敛）、E02（E02-unsupported 旧 Worker 明确不支持且不按历史 PID 盲杀；E02-ownership 重启后归属不可证明须保留 cancelling，只有确认停止才 cancelled）、B04（取消中重启：墓碑保留、状态不回退为 running/queued，cancelled 仅在实际停止后）。
校验：`node --check` 通过；未设置 MUAD_LONG_TASK_CONTROL_E2E 时仅文件级加载（tests 1 / pass 1，无场景注册执行）；guard 全量 npm test 无回归（275 用例 274 pass / 1 skipped / 0 fail）。环境契约见 e2e.md（fault/restartCommand case 字段）。
- S-05: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- S-06: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- S-07: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- E-01: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- E-02: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- B-04: e2e_deferred — automated command e2e_deferred; run_id=e107d000dce641a7b72c602231c9b5c6 (confirmed_by: runner)
- S-05: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-06: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-07: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- E-01: failed — automated command failed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-06: failed — automated command failed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-07: failed — automated command failed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-07: failed — automated command failed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-07: failed — automated command failed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-07: failed — automated command failed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)
## TASK-026: 登记真实浏览器、配置应用与兼容发布验收

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-005, TASK-018, TASK-021, TASK-022, TASK-023
- **Source**: long-task-control.frontend.design.md#2.4 验收条件, long-task-control.backend.design.md#4. 部署与运维
- **Spec-Refs**: 
- **Acceptance-Refs**: S-08, S-10, E-05
- **Owned Files**: `tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs`, `tools/muad-runtime-guard/long-task-control-e2e.md`

### Description

补齐端到端 UI 与事务应用验收，并记录 Console 先升级、Worker 后升级的兼容发布/回滚条件。

### Checklist
- [x] 浏览器验证中英切换、筛选分页、取消中刷新、故障提示、401 回登录和无重试入口；使用实际后端/Worker，不以 HTTP stub 冒充 E2E。
- [x] 实际 DTO/generation/apply/health 故障回滚确认取消能力与指导，保留模型绑定和 Skill 分层；形成明确终验与兼容检查步骤，本任务编码期仅登记不发布。
- [x] [S-08][E2E] 编写并登记独立用例：Console 配置 → DTO/schema → generation 事务 → Worker health：能力与指导成功应用；故障健康检查触发回滚，无模型绑定或 Skill 分层改变；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [S-10][E2E] 编写并登记独立用例：真实浏览器、后端及 Worker：中英文切换后按钮/状态/错误/确认文案正确，按取消状态筛选、分页和正常后台轮询不闪表格 spinner；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] [E-05][E2E] 编写并登记独立用例：实际 Worker 不可达或不支持取消，UI 显示明确原因而非成功；刷新不覆盖较新操作状态；权限失效回登录；不出现任务重试按钮；编码期不执行 RED/GREEN，统一留给 verify-e2e。
- [x] 登记本任务具体测试/断言位置、命令结果及真实组件证据；保持无关任务和其他用户运行不受影响。

### Acceptance Contract

| 场景/规则 | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-08 | E2E | Console 配置 → DTO/schema → generation 事务 → Worker health：能力与指导成功应用；故障健康检查触发回滚，无模型绑定或 Skill 分层改变 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs / LongTaskControlS08 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS08","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"]（cwd=.） | verified |
| S-10 | E2E | 真实浏览器、后端及 Worker：中英文切换后按钮/状态/错误/确认文案正确，按取消状态筛选、分页和正常后台轮询不闪表格 spinner | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs / LongTaskControlS10 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlS10","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"]（cwd=.） | verified |
| E-05 | E2E | 实际 Worker 不可达或不支持取消，UI 显示明确原因而非成功；刷新不覆盖较新操作状态；权限失效回登录；不出现任务重试按钮 | 按来源场景完整断言；拒绝零匹配/假停止/错误终态 | tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs / LongTaskControlE05 | ["env","MUAD_LONG_TASK_CONTROL_E2E=1","node","--test","--test-name-pattern","LongTaskControlE05","tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs"]（cwd=.） | verified |

### Acceptance Evidence

TASK-026 为 E2E 登记项，编码期记录用例/命令与环境契约与浏览器执行器契约，不填写真实运行通过；E2E 实际执行证据统一由 verify-e2e 收集。
登记：`tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs` 注册 3 个真实场景——S08（Console apply-config 事务：appliedGeneration==configGeneration/lastApplyStatus=applied/runtimeGuardHealthy、AGENTS.md 指导可读、成功与健康故障回滚均保持模型绑定与 longTaskSkillGrant 分层不变）、S10（真实浏览器 browserCommand 观测：中英文标签随语言切换、确认框含 Skill 与任务 ID 且说明不撤回外部操作、按 cancelled 筛选、分页、后台轮询 spinner=0、无重试入口、经 UI 发起终止且 cancelling 禁用；取消后以真实进程停止/计数停止/零新投递收敛）、E05（Worker 故障下 UI 显示明确原因且无成功文案、刷新不覆盖较新操作状态、无重试按钮、权限失效回登录、任务不得被伪报已取消；恢复后收敛）。
浏览器执行器契约与 case 字段（browserCommand/deployment）已登记到 `tools/muad-runtime-guard/long-task-control-e2e.md`；结果文件缺失或字段缺失即失败。
校验：`node --check` 通过；未设置 MUAD_LONG_TASK_CONTROL_E2E 时仅文件级加载（tests 1 / pass 1，无场景注册执行）；guard 全量 npm test 无回归（275 用例 274 pass / 1 skipped / 0 fail）。
- S-08: e2e_deferred — automated command e2e_deferred; run_id=7c462a0e13bd4263a80ae21504a9f3b5 (confirmed_by: runner)
- S-10: e2e_deferred — automated command e2e_deferred; run_id=7c462a0e13bd4263a80ae21504a9f3b5 (confirmed_by: runner)
- E-05: e2e_deferred — automated command e2e_deferred; run_id=7c462a0e13bd4263a80ae21504a9f3b5 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-10: failed — automated command failed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=ed3b0f4953474fe381a7e650b9e11a28 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-10: failed — automated command failed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=121cd427343c4fe1ac0da8edbefa78c8 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-10: failed — automated command failed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- E-05: failed — automated command failed; run_id=6b22d826fb8a43588f7ece2d9d559c62 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=f7acf2576e5f49298a48e30daf5487c1 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-10: failed — automated command failed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=5afc3c7b442245c79ad4fd716bca5dca (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=db490b84c89b41639152d05f721944d7 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=80980387d99e4fa28ae09de9b3ae25ab (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=93659341a65c45109c29c4d7ea03c3bd (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-10: failed — automated command failed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=0f7440ed9f6f4004aeede2f31e757c22 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=e05903b19df4483d86b1ff14cc0cad52 (confirmed_by: runner)

### Log

- [2026-10-15] created (draft)，来源为用户已批准 v1.0 设计与本轮任务拆解指令。

---
- [2026-10-15] started
- [2026-10-15] completed (done)

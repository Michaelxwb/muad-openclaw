# Tasks: Skill 主动进度反馈 V2

- **Source**: `.code-flow/tasks/2026-08-28/skill-progress-feedback-v2/skill-progress-feedback-v2.design.md`
- **Created**: 2026-08-28
- **Updated**: 2026-08-31

## Proposal

恢复语言无关的 `muad-progress` 命令，并在现有 OpenClaw 原生 Skill 执行链外增加通用、可信的进度 execution。普通前台 Skill 与后台长任务共用事件桥、治理、文本渲染和 `notifyUser` 投递，同时保持原生最终回复、并发租约、runtime config 和数据库模型不变。

实现采用与 `tools/session-manager` 一致的 TypeScript strict、预构建 `dist/` 和镜像 bin 软链接模式；不恢复旧 `muad-run-skill`、progress adapters、Agent Tool 或数据库审计模型。Skill 自主选择调用节点，runtime 不自动 heartbeat、去重或业务限频。

### Confirmed Manual Boundary

- B-04 的自动化部分验证文本 renderer、Unicode/换行/Markdown 字符以及 `openclaw message send` argv。
- 真实企微/Mattermost 渲染依赖已登录渠道与外部凭据，用户已在 2026-08-28 确认保留为发布前人工 channel smoke；不得在测试或任务文件中保存凭据。

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 |
|--------|---------|---------|-------------|---------|------|
| S-01 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | 编译后的 TypeScript CLI → 真实 JSONL 文件 | TASK-001 | verified |
| S-02A | `skill-progress-feedback-v2.design.md#2.5 验收条件` | E2E | 普通 Skill 激活 → exec env → CLI → 文件桥 → manager → notify 进程边界 | TASK-004 | verified |
| S-02B | `skill-progress-feedback-v2.design.md#2.5 验收条件` | E2E | LongTaskManager → CLI → 文件桥 → manager → notify 进程边界 | TASK-005 | verified |
| S-03 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | Manager 事件治理 → notify fake | TASK-003 | verified |
| S-04 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | E2E | runtime-guard progress 链 → OpenClaw 原生 final delivery | TASK-006 | verified |
| S-05 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | Shell/Python/TypeScript/Go 调用示例 → 同一 CLI | TASK-007 | verified |
| S-06 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | 两套 Docker recipe/self-check/config renderer | TASK-009 | verified |
| E-01 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | CLI 初筛 → 伪造 JSONL → manager 二次过滤 → notify fake | TASK-003 | verified |
| E-02 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | JSONL 增量 reader → 真实文件半行/坏行/截断 | TASK-002 | verified |
| E-03 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | Manager → notify 超时/非零退出 | TASK-003 | verified |
| E-04 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | unit | session/run/task resolver | TASK-004 | verified |
| E-05 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | Manager 生命周期 → 真实临时文件系统 | TASK-005 | verified |
| B-01 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | unit | CLI 与 manager schema 的 Unicode 字符边界 | TASK-001 | verified |
| B-02 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | Manager per-execution 发送队列 | TASK-003 | verified |
| B-03 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | E2E | 两用户、普通/长任务 execution、隔离事件文件与 notify 目标 | TASK-006 | verified |
| B-04 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | unit + manual | 文本 renderer → 企微/Mattermost 已登录真实渠道 | TASK-009 | partial（自动化与 Mattermost 人工确认通过；企微有效 chatid/可读性待确认） |
| B-05 | `skill-progress-feedback-v2.design.md#2.5 验收条件` | integration | JSONL 文件与待发送队列硬资源边界 | TASK-002 | verified |

> 全部 P0/P1 S/E/B 场景均有且仅有一个最终负责人。RULE-01 至 RULE-08、高影响 RISK-03/RISK-04/RISK-05 均由上表对应场景覆盖；B-04 的 manual 外部边界已获得用户明确确认。

---

## TASK-001: 实现 TypeScript `muad-progress` CLI 与事件契约

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `skill-progress-feedback-v2.design.md#2.3 功能方案`, `skill-progress-feedback-v2.design.md#3.4 接口设计`, `skill-progress-feedback-v2.design.md#4.1 部署架构`
- **Spec-Refs**: runtime-directory-structure#PATTERN-runtime-001
- **Acceptance-Refs**: S-01, B-01, RULE-03

### Description

建立 `tools/muad-progress` TypeScript strict package，实现语言无关的 `stage/done/error/validate` 命令、事件 schema、敏感内容初筛、JSONL 单行追加和稳定 stdout/stderr/退出码。CLI 只报告本地校验与写入结果，不持有 IM 路由，也不把 `--json` 作为用户消息格式。

### Checklist

- [x] 建立 `package.json`、lockfile、strict `tsconfig.json`、`src/`、`test/` 与 `#!/usr/bin/env node` CLI 入口；runtime dependencies 必须为空。
- [x] [S-01][integration] 修改生产代码前，先以编译后的 CLI → 真实临时 JSONL 文件边界编写 `stage/done/error/validate` 测试并记录 RED。
- [x] 实现严格 argv 解析，拒绝未知/重复参数，生成 schema v1 的单行事件并以一次 append 写入受信绝对路径。
- [x] 实现默认成功静默、`--json` 机器可读 `written/skipped` 结果、参数/敏感/strict bridge 的稳定 stderr 与退出码 2/3/4。
- [x] [B-01][unit] 覆盖 `stage/text/id/code` 上限、上限+1、Unicode 多字节、换行、Emoji 与 Markdown 字符；按 Unicode 字符而非字节断言。
- [x] [RULE-03] CLI 初筛 token、Cookie、Authorization、密码、内部 URL、SQL 与堆栈，不在错误或诊断中回显原敏感正文。
- [x] 运行 `cd tools/muad-progress && npm test`，记录 RED/GREEN 与编译产物校验结果。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | integration | `dist/cli.js` 进程、真实 argv/env、真实 JSONL 文件 | 三种事件各写一行；validate 不写文件；默认 stdout 空；`--json` 仅报告本地写入 | `tools/muad-progress/test/cli.test.mjs` | `cd tools/muad-progress && npm test` | verified |
| B-01 | unit | CLI/protocol schema | Unicode 计数正确；边界内接受；上限+1 稳定拒绝 | `tools/muad-progress/test/protocol.test.mjs` | `cd tools/muad-progress && npm test` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-01 | `npm test` exit 2：`TS18003`，测试/构建脚手架已存在但 `src/**/*.ts` 尚未实现 | `npm test` exit 0：15 tests、15 pass、0 fail；Node v24.17.0 | `test/cli.test.mjs:11,39,54,87,115,132,148,161` | 测试以子进程执行编译后的 `dist/cli.js`，使用真实 argv/env、临时 JSONL 文件及 24 进程并发 append | verified |
| B-01 | 同一 RED：protocol 测试无法在缺失实现时完成编译 | `npm test` exit 0；Unicode/字段边界及敏感内容断言全部通过 | `test/protocol.test.mjs:13,22,30,44,49,66` | 直接验证编译后的 protocol schema，以 `Array.from` 按 Unicode code point 计数并覆盖上限+1 | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-28] started (in-progress)
- [2026-08-29] completed (done)

---

## TASK-002: 实现 `ProgressEventBridge` 与安全文件生命周期

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `skill-progress-feedback-v2.design.md#3.2 架构设计`, `skill-progress-feedback-v2.design.md#3.3 数据设计`, `skill-progress-feedback-v2.design.md#3.5 质量实现方案`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: E-02, B-05, RULE-04, RULE-06, RISK-01, RISK-02

### Description

在 runtime-guard 内实现共享增量事件桥，为每个 opaque execution capability 创建隔离目录和事件文件，处理尾行、坏行、截断、容量背压以及结束 drain/cleanup。桥只解码和移交事件，不解析收件人或构造业务消息。

### Checklist

- [x] [E-02][integration] 修改生产代码前，使用真实临时目录构造半行、非法 JSON、超长行、文件截断和后续合法行测试，记录 RED。
- [x] 以单一共享调度器扫描 active execution；保存 offset/tail buffer，仅在完整行后推进，不为每个 execution 创建永久 timer。
- [x] 创建 opaque capability 目录和事件文件，禁止目录名包含 agentId、peerId、channel 或 skillName。
- [x] [B-05][integration] 覆盖单行、单文件和 bridge 待处理容量边界；达到硬上限时记录稳定 capacity reason、停止继续读取，不改变业务 execution。
- [x] 实现 finish 时短超时 final drain、幂等 cleanup，以及启动时只清理过期/无活动 execution、不重放旧进度。
- [x] [verifier][manual] `runtime-isolation-and-security#RULE-runtime-secret-file-mode-001`：核对 execution 目录 `0o700`、事件/诊断文件 `0o600`、原子创建/写入和无 Pod token 路径变更；在 Acceptance Evidence 记录审阅结论。
- [x] 运行 `cd tools/muad-runtime-guard && npm test -- --test-name-pattern=ProgressEventBridge` 或最终等价精确命令并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| E-02 | integration | Node fs、真实 JSONL 文件、增量 offset/tail | 半行保留；坏行隔离；截断恢复；后续合法事件仍交付 | `tools/muad-runtime-guard/test/progress-event-bridge.test.mjs` | `cd tools/muad-runtime-guard && node --test --test-name-pattern=ProgressEventBridge test/*.test.mjs` | verified |
| B-05 | integration | 真实文件容量、bridge backlog | 超限稳定降级；已接受项保序；主流程不失败 | `tools/muad-runtime-guard/test/progress-event-bridge.test.mjs` | 同上 | verified |
| RULE-runtime-secret-file-mode-001 | integration + manual | 真实文件 mode 与生命周期 | 目录 0700；文件 0600；结束清理；无宽权限窗口 | 同上 + code review | 同上 + verifier checklist | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-02 | 初始 RED：模块缺失，`ERR_MODULE_NOT_FOUND`，exit 1；补充回归 RED：8 pass/2 fail，快速 truncate 重写漏事件、第二 bridge 删除活动目录 | 单文件 10/10；精确过滤回归 30/30，exit 0 | `test/progress-event-bridge.test.mjs:33,64,79,147,162,181` | 真实临时目录与 JSONL；跨 UTF-8 半字节、坏行、普通/快速截断、后续合法行、孤儿清理且不重放 | verified |
| B-05 | 同一初始 RED：生产模块不存在 | 单文件 10/10；精确过滤回归 30/30，exit 0 | `test/progress-event-bridge.test.mjs:97,113,128` | 真实文件验证单次事件/字节预算、16KiB/1MiB 默认硬边界的可配置等价值、稳定 capacity reason 与保序 | verified |
| RULE-runtime-secret-file-mode-001 | 同一初始 RED：生产模块不存在 | mode/cleanup 用例通过；代码审阅通过 | `test/progress-event-bridge.test.mjs:18,147`; `src/progress-event-bridge.mjs:324,337,348,349,388,417,422` | `mkdir` 初始 0700、`openSync(...,"wx+",0600)` 独占原子创建后收紧权限；finish/close 删除；未修改 Pod token 路径且无宽权限窗口 | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-29] started (in-progress)
- [2026-08-29] completed (done)

---

## TASK-003: 实现 `SkillProgressManager`、文本治理与投递队列

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `skill-progress-feedback-v2.design.md#3.2.1 组件职责`, `skill-progress-feedback-v2.design.md#3.4 接口设计`, `skill-progress-feedback-v2.design.md#3.5 质量实现方案`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001
- **Acceptance-Refs**: S-03, E-01, E-03, B-02, RULE-01, RULE-02, RULE-03, RULE-04, RULE-08, RISK-02, RISK-03, RISK-04

### Description

实现独立 `SkillProgressManager`，集中管理 execution 的可信 route、skillName、事件二次校验、文本渲染、per-execution 有序发送和故障降级。manager 复用 `notifyUser`，不管理 Skill 租约或长任务队列，不做语义去重、自动 heartbeat 或业务消息数量限制。

### Checklist

- [x] [S-03][integration] 修改生产代码前，先为 `stage → done` 到 notify fake 的按序文本投递编写测试并记录 RED。
- [x] 实现 foreground/background execution 注册、opaque executionKey、可信 route 内存态、`reportProgress` 和幂等 `finish`。
- [x] [E-01][integration] 以绕过 CLI 的伪造 JSONL 事件验证 manager 二次 schema、长度和敏感内容过滤；断言 notify 未调用且日志不含原正文。
- [x] [E-03][integration] 模拟 `notifyUser` 超时/失败，断言发送链释放、后续 execution 不阻塞、业务终态和 final reply 不受影响。
- [x] [B-02][integration] 连续提交两条完全相同合法事件，断言两条均按序投递；runtime 不去重、不限频、不自动 heartbeat。
- [x] 实现企微/Mattermost 共用的简短文本 renderer，保持中文/英文、换行、Emoji 和 Markdown 字符为文本载荷。
- [x] [verifier][manual] `runtime-isolation-and-security#RULE-runtime-security-001`：确认事件无 target/credential，route 只来自注册上下文，日志/镜像无 secrets，用户 execution 不交叉。
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-log-injection-001`：确认 manager/bridge 构造器接收默认 no-op `log`，插件路径注入 `api.logger?.warn`，无散落 `console.*`。
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-log-prefix-001`：确认日志统一 `[muad-runtime-guard][skill-progress]` 前缀并包含稳定 action/outcome/reason。
- [x] 运行 `cd tools/muad-runtime-guard && npm test`，记录 RED/GREEN、顺序与脱敏断言位置。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-03 | integration | Manager 治理、真实发送队列；仅外部 notify 可 fake | stage/done 文案和顺序稳定 | `tools/muad-runtime-guard/test/skill-progress-manager.test.mjs` | `cd tools/muad-runtime-guard && node --test --test-name-pattern=SkillProgressManager test/*.test.mjs` | verified |
| E-01 | integration | manager decoder/filter、日志注入 | CLI 绕过仍拒绝；无敏感消息/日志 | 同上 | 同上 | verified |
| E-03 | integration | manager send tail/queue | notify 故障不传播；其他 execution 继续 | 同上 | 同上 | verified |
| B-02 | integration | per-execution queue | 合法重复事件投递两次且保序 | 同上 | 同上 | verified |
| required Specs | integration + manual | route、logger 注入、日志输出 | target 不可伪造；默认 no-op；前缀稳定；无 secrets | 同上 + code review | 同上 + 3 项 verifier checklist | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-03 | 初始 RED：`skill-progress-manager.mjs` 缺失，`ERR_MODULE_NOT_FOUND`；装配 RED：`installSkillProgressManager` export 缺失 | 单文件 8/8；精确过滤回归 29/29，exit 0 | `test/skill-progress-manager.test.mjs:11` | 真实 Promise tail 与 manager renderer；仅外部 notify 为可控 fake，断言首条 settled 后才调用第二条 | verified |
| E-01 | 同一初始 RED | 单文件 8/8；精确过滤回归 29/29，exit 0 | `test/skill-progress-manager.test.mjs:53` | 绕过 CLI 直接提交含 target/token/Cookie/Auth/password/internal URL/SQL/stack 的 unknown event；notify=0 且日志无原文 | verified |
| E-03 | 同一初始 RED | 单文件 8/8；精确过滤回归 29/29，exit 0 | `test/skill-progress-manager.test.mjs:85` | 注入 never-settle/reject notify；不同 execution 独立推进，同 execution reject 后发送链继续 | verified |
| B-02 | 同一初始 RED | 单文件 8/8；精确过滤回归 29/29，exit 0 | `test/skill-progress-manager.test.mjs:35,113` | 同 execution 两条完全相同事件均投递；待发送硬上限释放后可继续，不按累计数量限频 | verified |
| required Specs | 同一初始/装配 RED | 单文件 8/8；代码审阅通过 | `test/skill-progress-manager.test.mjs:131,164`; `src/index.mjs:35,226`; `src/skill-progress-manager.mjs:22,61,140` | route 仅来自 direct session/后台可信注册；日志默认 no-op、插件注入 `api.logger?.warn`，统一稳定前缀且不记录 peer/text/error detail；源码无 `console.*` | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-29] started (in-progress)
- [2026-08-29] completed (done)

---

## TASK-004: 接入普通前台 Skill 激活、exec env 与结束清理

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: `skill-progress-feedback-v2.design.md#2.3.4 Skill 语言兼容边界`, `skill-progress-feedback-v2.design.md#3.2.2 生命周期与数据流`, `skill-progress-feedback-v2.design.md#3.2.3 文件与隔离布局`
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001
- **Acceptance-Refs**: S-02A, E-04, RULE-01, RULE-05, RISK-03, RISK-06

### Description

新增前台 Skill progress hooks，复用现有显式 `/skill:` 与可信 `SKILL.md` 授权路径识别，只为活动 direct Skill run 注册进度 execution。在 `resolve_exec_env` 注入可信事件文件与真实 skillName，在 `agent_end`/TTL final drain 并清理。

### Checklist

- [x] [S-02A][E2E] 修改生产代码前，以普通会话激活 → exec env → 编译 CLI → 真实事件文件 → bridge/manager → notify 进程边界编写测试并记录 RED。
- [x] 对显式 Skill dispatch 和自然语言读取已授权 `SKILL.md` 建立单次 run 注册，复用现有 grant/resolver 语义，不复制一套 system/public/private 解析器。
- [x] 在 `resolve_exec_env` 仅为 `exec` 且 `runId/agentId/sessionKey` 匹配的活动 execution 注入 `MUAD_PROGRESS_EVENTS_FILE` 与真实 Skill 标识；覆盖用户自报同名 env。
- [x] [E-04][unit] 覆盖未激活 Skill、未知/终态 run、非 direct、agent/skill/session 不匹配、群聊语义不明确；断言不注入、不 notify、主 run 不报错。
- [x] 在 `agent_end` final drain/cleanup；崩溃残留由 TTL 清理且不重放进度。
- [x] 在 plugin `index.mjs` 安装共享 manager/bridge 并注册 hooks，保持现有 browser/skill lease hook 优先级与行为不变。
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-001`：确认先 activation/policy gate 后注入进度，事件无 secrets，现有 Skill/Browser/LongTask 并发租约未被绕过或改变。
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-layering-001`：确认 system-first、system_protected、public/private 冲突及 allow_override 逻辑未修改；progress 只消费已解析真实 skillName。
- [x] 运行前台 hook unit/E2E 与现有 `skill-hooks`、`skill-audit-hooks`、`skill-output-hooks` 回归测试并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02A | E2E | hooks、exec env、编译 CLI、真实文件、bridge、manager、notify 子进程 argv | 仅当前 direct 用户收到；其他用户不命中；agent_end 清理 | `tools/muad-runtime-guard/test/skill-progress-foreground.e2e.test.mjs` | `cd tools/muad-runtime-guard && node --test --test-name-pattern=SkillProgressHooks test/*.test.mjs` | verified |
| E-04 | unit | session/run/task resolver | 所有未知/伪造/终态上下文 fail closed 且不阻断 run | `tools/muad-runtime-guard/test/skill-progress-hooks.test.mjs` | 同上 | verified |
| required Specs | E2E + manual | 现有激活/分层/租约代码路径 | 仅授权 Skill 获得 env；resolver 与并发边界不变 | 上述测试 + code review | 同上 + 2 项 verifier checklist | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-02A | 初始 RED：`skill-progress-hooks.mjs` 缺失，2 个测试文件均 `ERR_MODULE_NOT_FOUND` | 核心 5/5；精确过滤回归 27/27；相关 hooks/plugin 回归 35/35 | `test/skill-progress-foreground.e2e.test.mjs:19` | 真实 `npm run build` CLI → 真实 JSONL/bridge/manager；共享 `notifyUser` 构造 `openclaw message send` argv，仅 fake 最外层 spawn | verified |
| E-04 | 同一初始 RED；装配 RED：plugin hook 列表缺 progress hooks | 核心 5/5；相关 hooks/plugin 回归 35/35 | `test/skill-progress-hooks.test.mjs:11,36,60,89` | 现有 audit grant resolver 触发；run/agent/session 精确匹配，group/伪造/未激活/终态 fail closed；agent_end 与 TTL finish | verified |
| required Specs | 同一 RED | 相关 hooks/plugin 回归 35/35；代码审阅通过 | `src/skill-audit-hooks.mjs:34,58`; `src/skill-progress-hooks.mjs:4,29,44`; `src/index.mjs:40,57,179,193` | activation 在授权 grant 解析后；未改 resolver 分层、system protection、allow_override、Skill/Browser/LongTask lease；progress 只消费 resolver 给出的真实 skillName | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-29] started (in-progress)
- [2026-08-29] completed (done)

---

## TASK-005: 接入后台长任务 progress execution 生命周期

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: `skill-progress-feedback-v2.design.md#3.2.1 组件职责`, `skill-progress-feedback-v2.design.md#3.2.2 生命周期与数据流`, `skill-progress-feedback-v2.design.md#3.4 IF-02：SkillProgressManager 内部接口`
- **Spec-Refs**: runtime-skill-execution#PATTERN-runtime-002
- **Acceptance-Refs**: S-02B, E-05, RULE-01, RULE-04, RULE-06

### Description

让 `LongTaskManager` 在 task 启动时用已保存的 `replyChannel/peerId` 注册后台 execution，并在 task 终态执行 final drain/cleanup。进度能力不得改变现有队列、状态持久化、失败通知、`--deliver` 或重启中断语义。

### Checklist

- [x] [S-02B][E2E] 修改生产代码前，以真实 LongTaskManager → 编译 CLI → JSONL → bridge/manager → notify 进程边界编写测试并记录 RED。
- [x] 通过构造器注入 `SkillProgressManager`，task 进入 running 后注册 background execution；route 只取 task 的 `replyChannel/peerId`，不从 longtask sessionKey 猜目标。
- [x] 让 longtask `resolve_exec_env` 获得 task 对应 progress env，未知/queued/terminal task 不注入。
- [x] [E-05][integration] 在 succeeded/failed/timeout/interrupted/restart 路径 final drain 并安全清理；重启不恢复、不重放旧进度。
- [x] 验证 bridge/notify 故障不改变 task 终态、不占住并发槽；现有失败通知只发送一次，成功仍由 `openclaw agent --deliver` 完成。
- [x] 回归 `long-task-manager.test.mjs`、`long-task-hooks.test.mjs`、state push 与 health tests，记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02B | E2E | LongTaskManager、编译 CLI、真实 JSONL、bridge/manager、notify 子进程 argv | 进度只投递 task 所属 peer；route 不来自事件/session 猜测 | `tools/muad-runtime-guard/test/skill-progress-background.e2e.test.mjs` / `S-02B long task progress uses its trusted task route through the real CLI and bridge` | `cd tools/muad-runtime-guard && node --test test/skill-progress-background.e2e.test.mjs` | verified |
| E-05 | integration | LongTaskManager 状态转换、真实临时文件系统 | 终态 drain/cleanup；重启不重放；现有终态不变 | `tools/muad-runtime-guard/test/long-task-manager.test.mjs` / `E-05 ...` | `cd tools/muad-runtime-guard && node --test test/long-task-manager.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-02B | FAIL: background exec env 缺少 `MUAD_SKILL_NAME` / events file，CLI 无法进入真实 JSONL bridge | PASS: targeted E2E + related regression 47/47 | `skill-progress-background.e2e.test.mjs:20`：可信 owner argv、伪造 skill 覆盖、queued/terminal 无 env、终态目录删除 | real LongTaskManager + compiled CLI + JSONL + bridge/manager + shared notifyUser child argv | verified |
| E-05 | FAIL: running task 未调用 `registerBackground`，longtask env 未合并 progress capability | PASS: targeted lifecycle 30/30；longtask/hooks/state/health regression 65/65 | `long-task-manager.test.mjs:595,622,650`；`skill-output-hooks.test.mjs:18` | real manager 状态/临时 state file；success/failure/timeout/restart、failure notify exactly once、queue release；完整套件 198/200，仅既有周报 `.tar`/`.md` 两项无关失败 | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-29] started (in-progress)
- [2026-08-30] completed (done)

---

## TASK-006: 建立跨链路、多用户与最终回复 E2E

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-004, TASK-005
- **Source**: `skill-progress-feedback-v2.design.md#2.5 验收条件`, `skill-progress-feedback-v2.design.md#3.2 架构设计`, `skill-progress-feedback-v2.design.md#3.5 质量实现方案`
- **Spec-Refs**: runtime-isolation-and-security#PATTERN-runtime-002
- **Acceptance-Refs**: S-04, B-03, RULE-01, RULE-02, RULE-04, RULE-05, RISK-02, RISK-03, RISK-04

### Description

建立覆盖普通/长任务、两个用户和多个 execution 的端到端测试，验证进度路由、顺序、故障隔离与最终回复唯一性。内部 CLI、文件、bridge、hooks、manager 和 notify 进程调用不得 Mock；仅以可观测 OpenClaw 测试可执行文件替代外部 channel 服务。

### Checklist

- [x] [S-04][E2E] 修改生产代码前，编写“已发送 stage/done 后 execution 成功结束”的测试并记录 RED；断言只有一次原生完整 final，progress done 不复制最终正文。
- [x] [B-03][E2E] 并发运行普通 foreground 与 longtask execution，覆盖两个 agent/peer/channel；断言每条事件只到所属目标。
- [x] 让一个 notify 进程超时/失败，断言另一 execution 的顺序、进度与 final 不受影响。
- [x] 使用真实编译 CLI、真实 execution 文件和实际 runtime-guard 组件装配；测试替身只记录 `openclaw message send` 与 final delivery 的进程 argv/正文。
- [x] 断言进度事件无法覆盖 channel/peer/skillName，日志与测试快照不含 peerId、credential 或敏感正文。
- [x] 运行 `cd tools/muad-runtime-guard && npm test` 并记录 E2E RED/GREEN、进程调用序列和最终用户可见输出。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | E2E | 编译 CLI、文件桥、runtime-guard 生命周期、notify/final 进程边界 | 进度与 final 分工明确；完整 final 恰好一次 | `tools/muad-runtime-guard/test/skill-progress-e2e.test.mjs` / `S-04 B-03 progress stays isolated across two users and native final is delivered once` | `cd tools/muad-runtime-guard && node --test test/skill-progress-e2e.test.mjs` | verified |
| B-03 | E2E | 两用户真实 execution 文件与 manager 队列 | 无跨用户/跨 execution 投递；一侧故障不阻塞另一侧 | 同上 | 同上 | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-04 | N/A：TASK-003～005 已实现行为，本任务为既有行为 E2E 补测；首个有效测试首次运行即 PASS，未伪造 RED | PASS: targeted 1/1；progress/longtask regression 89/89 | `skill-progress-e2e.test.mjs:29,187`：`agent --deliver` final 恰好一次，stage/done 不含完整 final | compiled CLI + real capability files/bridge/hooks/managers + temporary executable `openclaw` process boundary | verified |
| B-03 | N/A：同上，首次有效跨用户场景即 PASS | PASS: targeted 1/1；progress/longtask regression 89/89 | `skill-progress-e2e.test.mjs:121,161,177,198`：route flags 拒绝、可信 skill 覆盖、两目标隔离、失败不阻塞、诊断脱敏 | foreground + longtask real executions/queues；Mattermost failure 与 WeCom success/final 子进程 argv | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-30] started (in-progress)
- [2026-08-30] completed (done); full runtime-guard 199/201，2 项既有周报 `.tar`/`.md` 无关失败未改动

---

## TASK-007: 更新 Skill 模板与四语言 CLI 接入示例

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-progress-feedback-v2.design.md#2.3.4 Skill 语言兼容边界`, `skill-progress-feedback-v2.design.md#4.1 部署架构`, `skill-progress-feedback-v2.design.md#5.2 风险识别`
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-05, RULE-02, RULE-07, RULE-08, RISK-04, RISK-05

### Description

更新 Shell、Python、TypeScript 业务 Skill 模板，在可解释业务节点示范调用 CLI，并提供 Go 跨语言调用 fixture。文档明确 Skill 自主选择节点、CLI best-effort、默认 stdout 静默，以及最终结果仍走原生回复。

### Checklist

- [x] [S-05][integration] 修改模板前，先让 Shell/Python/TypeScript/Go fixture 调用同一编译 CLI 并断言相同 schema，记录 RED。
- [x] 更新三种业务 Skill 模板脚本，在开始/节点完成/可理解错误位置调用 `muad-progress`，不恢复旧 `mode/steps` manifest 强制规则。
- [x] 提供 Go `os/exec` 示例；四语言均不 import TypeScript SDK、不自行传 channel/peerId。
- [x] 模板业务失败保持 stderr + 非零退出；进度调用失败采用明确 best-effort，不把业务成功误报为失败。
- [x] 同步 `skills/_templates/README.md`、各模板 README 与 `skills/README.md` 的接入、文本格式和非目标说明。
- [x] [verifier][manual] `runtime-skill-execution#RULE-runtime-skill-fail-loud-001`：确认所有模板失败写 stderr 且 exit 非零，stdout 只保留业务机器结果，`--json` 仅在显式需要时使用。
- [x] 运行 CLI cross-language integration、模板脚本成功/失败测试与现有 Skill 模板检查，记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-05 | integration | Shell/Python/Node/Go 进程与编译 CLI | 四语言产生同 schema；业务失败 stderr + 非零；成功 stdout 不被进度污染 | `tools/muad-progress/test/cross-language.test.mjs` / `S-05 Shell Python Node and Go invoke one compiled CLI with the same event schema` | `cd tools/muad-progress && npm test` | verified |
| RULE-runtime-skill-fail-loud-001 | integration + manual | 实际模板脚本进程 | 失败可由 exec hook 捕获；stdout 机器可读契约稳定 | `tools/muad-progress/test/template-integration.test.mjs` + code review | `cd tools/muad-progress && npm test` + verifier checklist | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-05 | FAIL: 三种模板成功路径均未写 stage/done，actual `[]` vs expected `[progress,done]`；四语言 CLI fixture 已通过 | PASS: muad-progress 20/20 | `cross-language.test.mjs:13`、`template-integration.test.mjs:19,31,51`：四语言同 schema；成功 stdout 单 JSON；bridge/CLI 缺失均 best-effort | actual Shell/Python/Node/Go child processes + compiled CLI + JSONL | verified |
| RULE-runtime-skill-fail-loud-001 | FAIL: Shell 直接透传 `session unavailable`，未输出稳定业务错误且无 error 节点 | PASS: success/failure/rollback template matrix；manual code review complete | `template-integration.test.mjs:31`；Shell `run.sh:20-23`、Python `run.py:54-58`、Node `run.mjs:37-44` | 三模板实际进程均 failure→stderr + nonzero、success→单 JSON stdout；模板不使用 `--json`，脚本语法检查与 3 个 `quick_validate.py` 均通过 | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-30] started (in-progress)
- [2026-08-30] completed (done)

---

## TASK-008: 接入主 Worker 镜像与 runtime self-check

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `skill-progress-feedback-v2.design.md#4.1 部署架构`, `skill-progress-feedback-v2.design.md#4.2 发布与回滚`
- **Spec-Refs**: runtime-directory-structure#PATTERN-runtime-001
- **Acceptance-Refs**: S-06

### Description

在主 Worker Dockerfile 中增加与 session-manager 同构的 muad-progress TypeScript builder/产物复制，创建只读可执行 bin 软链接，并扩展离线 runtime image self-check。此任务负责主镜像侧实现，最终两套构建和 config 稳定性验收由 TASK-009 收口。

### Checklist

- [x] 修改主 `Dockerfile`，以独立 builder 执行 `npm ci --include=dev` 和 CLI tests，只复制 `dist`/package metadata 到最终镜像。
- [x] 创建 `/usr/local/bin/muad-progress` 软链接，设置 CLI/目录可读执行权限和 node ownership；不得 runtime npm install。
- [x] 扩展 `runtime-image-self-check.mjs`，检查命令存在、可执行和 `--version`，不依赖外部渠道凭据。
- [x] 修改生产 recipe/self-check 前先增加 Docker 文本契约和 self-check fixture 测试并记录 RED。
- [x] 运行 `node --test bin/test/runtime-image-recipe.test.mjs bin/test/runtime-image-self-check.test.mjs` 并记录 RED/GREEN。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-06（主镜像部分） | integration | Docker recipe 文本、self-check 文件/exec 权限检查 | builder/test/dist/bin/self-check 均存在；无 runtime install/secret | `bin/test/runtime-image-recipe.test.mjs`, `bin/test/runtime-image-self-check.test.mjs` / `S-06 ...` | `node --test bin/test/runtime-image-recipe.test.mjs bin/test/runtime-image-self-check.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-06（主镜像部分） | FAIL: Dockerfile 缺少 muad-progress builder/workdir；self-check 未导出 `MUAD_PROGRESS_CLI` / validator | PASS: recipe/self-check 13/13；含 config/inject 回归 40/40；CLI 20/20 | `runtime-image-recipe.test.mjs:66`、`runtime-image-self-check.test.mjs:25,50` | Dockerfile builder/final-stage text；真实临时 executable 权限 + `--version` 调用；image-only 无 config/channel credential | verified |

### Log

- [2026-08-28] created (draft)
- [2026-08-30] started (in-progress)
- [2026-08-30] completed (done)

---

## TASK-009: 接入千流构建并完成镜像、配置与渠道验收

- **Status**: blocked
- **Priority**: P0
- **Depends**: TASK-006, TASK-007, TASK-008
- **Source**: `skill-progress-feedback-v2.design.md#4.1 部署架构`, `skill-progress-feedback-v2.design.md#4.2 发布与回滚`, `skill-progress-feedback-v2.design.md#2.5 验收条件`
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001, runtime-directory-structure#RULE-runtime-directory-001
- **Acceptance-Refs**: S-06, B-04, RULE-03, RULE-07, RISK-05

### Description

扩展千流预构建/cache/应用镜像流程以携带 muad-progress dist，并最终验证两套 Docker recipe、runtime self-check、配置字节稳定性和企微/Mattermost 文本显示。真实 channel smoke 仅使用外部已登录测试账户，不保存或打印凭据。

### Checklist

- [x] [S-06][integration] 修改千流构建前，先扩展 recipe tests，断言预构建 dist、cache copy、最终 COPY/bin/self-check 全链缺一即 RED。
- [x] 更新千流预构建/cache 与 `build/docker-build/Dockerfile.openclaw`，复用 TypeScript dist，不在应用镜像内安装 dev/runtime npm dependencies。
- [x] 运行主/千流 Docker recipe tests、runtime self-check tests，以及 config renderer byte-stability/inject 回归；断言未新增 DTO/config key。
- [x] [B-04][unit] 自动化覆盖中文/英文、换行、Emoji、Markdown 字符的 renderer 与企微/Mattermost `openclaw message send` argv，不把 JSON 当用户消息。
- [x] [B-04][smoke-helper] 新增普通前台 `progress-notify-smoke` Skill，使用真实 `muad-progress` CLI 上报两个 stage/done 节点，且不接收 channel/peer。
- [ ] [B-04][manual] 使用已登录企微和 Mattermost 测试渠道各发送至少一条 stage/done 文本；确认可读、不乱码、无凭据/内部路径，并记录时间与脱敏结果。该 manual 边界已获用户确认。
- [x] [verifier][manual] `runtime-config-and-apply#RULE-runtime-config-001`：确认未新增 runtime config 行为；如构建资产触及配置，仍走 schema、generation、transactional apply 和 rollback/health 链。
- [x] [verifier][manual] `runtime-config-and-apply#RULE-runtime-validate-before-write-001`：确认 renderer/inject 未新增落盘路径，现有 `validateRuntimeConfig`、原子写与单调 generation 回归通过。
- [x] [verifier][manual] `runtime-directory-structure#RULE-runtime-directory-001`：确认 CLI 位于 `tools/`、runtime 能力位于 `tools/muad-runtime-guard`、模板位于 `skills/_templates`，未 vendor/fork OpenClaw。
- [ ] 执行最终验收命令集并填写两套 recipe、config byte、self-check、channel smoke 与三项 manual verifier Evidence。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-06 | integration | 两套 Docker recipe、self-check、config renderer/inject | CLI 可执行；无新 config key；相同输入 config bytes 不变；generation/apply 语义不变 | `bin/test/runtime-image-recipe.test.mjs` / `S-06 Qianliu recipe carries prebuilt muad-progress dist through cache into the runtime image`; `bin/test/runtime-image-self-check.test.mjs` / `S-06 image-only self-check requires executable muad-progress with the expected version`; config byte-stability/inject cases | `node --test bin/test/runtime-image-recipe.test.mjs bin/test/runtime-image-self-check.test.mjs bin/test/inject-env.test.mjs bin/test/inject-multi-user-config.test.mjs` | verified |
| B-04 | unit + manual | renderer/argv；真实 smoke Skill → CLI；真实已登录企微与 Mattermost 渠道 | 测试 Skill 发出两个 stage/done 节点且不传目标；两渠道文本可读不乱码；Markdown 仅按文本；无 secrets；`--json` 不进入消息正文 | `tools/muad-progress/test/notify-smoke-skill.test.mjs` / `B-04 progress-notify-smoke emits two ordered stage/done nodes without route arguments`; `tools/muad-runtime-guard/test/skill-progress-manager.test.mjs` / `B-04 renderer preserves Chinese, English, emoji, newlines, and Markdown as text`; `tools/shared/notify-user.test.mjs` / `B-04 keeps multilingual text intact in WeCom and Mattermost argv`; channel smoke record | `cd tools/muad-progress && npm test`; `node --test tools/muad-runtime-guard/test/skill-progress-manager.test.mjs tools/shared/notify-user.test.mjs` + confirmed manual smoke | partial（smoke helper verified；自动化/Mattermost sent；企微有效 chatid 与人工确认待完成） |
| required Specs | integration + manual | config tests、目录布局、构建产物 | config/apply 不漂移；validate-before-write 不绕过；runtime 资产目录合法 | 上述 tests + code review | automated suite + 3 项 verifier checklist | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-06 | FAIL 1: Task0 缺 `tools/muad-progress`；FAIL 2: Task4 缺 `--password-stdin`，暴露被忽略脚本的硬编码凭据问题 | PASS 41/41；`bash -n` PASS；canonical config hash 两次均为 `sha256:dc403b7aa5326588ab62d2e70a3ce0543aca11cda2216f9670df16e30d069767`；本地 `muad-openclaw:progress-v2-local` 基于 `muad-openclaw-base:2026.7.1` 构建成功，image-only self-check PASS | recipe `bin/test/runtime-image-recipe.test.mjs:66,94`；self-check `bin/test/runtime-image-self-check.test.mjs:25,50`；config bytes `bin/test/inject-multi-user-config.test.mjs:249` | GitHub builder/test/dist 与千流 Task0 build/cache → Task4 restore → final COPY/bin；真实 renderer/inject 原子落盘；本地 image id `sha256:28d6ee2b03c2…` | verified |
| B-04 | FAIL 1: `notify-smoke-skill.test.mjs` 在 Skill 创建前进程未启动；FAIL 2: 2026-08-31 10:03 真实企微 smoke 中 foreground register accepted，但 OpenClaw 2026.7.1 的 `resolve_exec_env` 不提供 runId，exec 未注入进度 env，CLI stage 失败 | PASS: CLI 21/21、进度回归 26/26、hook 6/6；新增真实 OpenClaw run-less exec shape 测试与多 execution 歧义 fail-closed；修复镜像 `sha256:c00478edcf92…` 已构建 | run-less hook `tools/muad-runtime-guard/test/skill-progress-hooks.test.mjs`；smoke helper `tools/muad-progress/test/notify-smoke-skill.test.mjs:14`；renderer `tools/muad-runtime-guard/test/skill-progress-manager.test.mjs:152`；argv `tools/shared/notify-user.test.mjs:59` | 脱敏 Pod 日志显示 register accepted 后仅有 `muad-progress stage failed`、无 accepted event；修复在缺 runId 时仅对唯一 agent+session execution 注入，多个候选拒绝；Mattermost 人工可读性已通过 | partial（部署修复镜像后的企微复测待完成） |
| required Specs | N/A（人工审查与现有回归，无新增缺陷目标） | schema/renderer/transaction/inject 与 backend runtimeapply 相对 HEAD 均 unchanged；S-06/B-04 自动化通过 | `bin/openclaw-config-renderer.mjs:19` validate；`bin/inject-multi-user-config.mjs:19` 0o600+rename；目录见 `tools/muad-progress`、`tools/muad-runtime-guard`、`skills/_templates` | 未新增 DTO/config key 或落盘路径；未修改 generation/transaction/rollback；未 vendor/fork OpenClaw；用户于 2026-08-31 逐项认可三项技术审查，Context decision/evidence 已分别绑定 | verified |

> BLOCKED: 等待用户部署包含 run-less exec env 修复的本地镜像 `sha256:c00478edcf92…`，并重新完成真实企微 B-04 smoke。

### Log

- [2026-08-28] created (draft)
- [2026-08-30] started (in-progress)
- [2026-08-30] automated acceptance completed; Mattermost smoke sent; WeCom valid chatid and user manual confirmations pending
- [2026-08-30] blocked (等待 required Spec 人工确认与企微有效 chatid/channel smoke, was in-progress)
- [2026-08-31] user confirmed three required Spec verifiers and Mattermost readability; WeCom inbound chatid/smoke remains blocked
- [2026-08-31] resumed (in-progress): build latest local app image and add a real progress-notify smoke Skill
- [2026-08-31] built `muad-openclaw:progress-v2-local` from `muad-openclaw-base:2026.7.1`; image self-check and 4-event smoke Skill execution passed
- [2026-08-31] blocked (等待用户部署本地最新镜像并完成真实企微 smoke, was in-progress)
- [2026-08-31] resumed (in-progress): real smoke registered foreground progress but exec lacked progress env because OpenClaw 2026.7.1 resolve_exec_env omits runId
- [2026-08-31] fixed run-less `resolve_exec_env` by unique agent+session lookup with ambiguity fail-closed; rebuilt `muad-openclaw:progress-v2-local` as `sha256:c00478edcf92…`
- [2026-08-31] blocked (等待用户部署修复镜像并重新进行企微 smoke, was in-progress)

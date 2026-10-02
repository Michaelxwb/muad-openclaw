# Tasks: Skill 执行前匹配与参数检查

- **Source**: skill-execution-preflight.design.md（v1.0，已批准）
- **Created**: 2026-10-01
- **Updated**: 2026-10-02
- **Plan Approval**: 用户于2026-10-01指示“写入正式任务文件并执行 Plan Gate”；编码中追加TASK-014～016修复已批准方案的集成缺口，未扩大产品设计。

## Proposal

取消长任务读取即入队，在读取 SKILL.md 后按固定系统规则完成匹配与参数检查，再通过专用工具提交。唯一明确匹配且参数齐全直接执行，多候选等待选择、缺参数立即追问；复用原队列及文档，不新增数据库迁移或逐Skill参数配置。
本次仅改长任务代码执行机制，普通 Skill 保留原机制但接受统一指导；文档要求不明时先澄清、不启动。读取记录、授权、队列输入、隐式触发、执行审计及工具注册均纳入，避免局部上线留下旁路。

## 执行约定

- 每 TASK 范围为1–3个实现/测试/文档文件，预计15–60分钟的原子单元；预计耗时不含环境准备和真实模型E2E等待，超出时重新拆分。
- functional按先失败测试RED、实现、GREEN记录；下列新测试名称和命令为待实施契约，不表示当前已存在或执行通过。
- E2E只编写和登记，编码期不执行RED/GREEN，全部functional完成后交cf-task-verify-e2e。不得用fake模型替代语义验收或降级E2E。
- 规范的manual verifier保持原类型，具体代码审查证据登记在责任TASK；用户规范确认留给规定门禁，不伪造确认。
- 本次与已有未提交上传超时改动独立；不得混入本任务Owned Files或覆盖其工作区变更。

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 | 命令 | 工作目录 | 超时 |
|---|---|---|---|---|---|---|---|---|
| S-01 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实文档、long-task/audit/progress hooks、真实队列状态文件；外部通知可 spy；read SKILL.md/脚本/引用文件；队列与执行记录不变，脚本哨兵未生成、无进度通知 | TASK-008 | verified | node --test --test-name-pattern PreflightS01 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs | . | 120 |
| S-02 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | renderer→实际 OpenClaw/模型→新工具→队列→脚本→实际回复；单一适用 Skill、提供完整 customerId；无确认追问，恰好一任务，脚本收到正确 ID | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS02 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs | . | 3600 |
| S-03 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 实际模型多轮对话、读取工具、新提交工具与队列；两个明确候选，首轮列出候选与差异且零任务；用户选择后参数齐全才执行选定 Skill | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS03 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs | . | 3600 |
| S-04 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 真实 SKILL.md 参数要求、实际模型、多轮会话、队列与脚本；文档要求 customerId，仅给客户名称；首轮提示补 ID，零任务/零业务调用；补 ID 后一次提交 | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | . | 3600 |
| S-05 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 文档定义的转换工具、实际模型与队列；文档允许名称解析 ID；唯一查询结果才可提交，多结果需用户选择，查不到则追问 | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS05 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | . | 3600 |
| S-06 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实激活 hooks 和提交入口、记录与进度投递捕获；只读说明不登记长任务执行；排队与真实开始分别产生对应状态，不因重复 read 重复审计 | TASK-008 | verified | node --test --test-name-pattern PreflightS06 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs | . | 120 |
| S-07 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实授权索引、工具上下文、manager、临时状态文件、shared lease；两用户同名 Skill 按各自 root 分离；有效 system 优先；同轮重复工具调用返回同任务；并发不超限 | TASK-006 | verified | node --test --test-name-pattern PreflightS07 tools/muad-runtime-guard/test/long-task-tool.test.mjs | . | 120 |
| S-08 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 实际后台会话、消息构造、脚本、结果投递；用户后续补齐参数；后台收到原请求、最终目标及绑定参数，不丢最新补充，不重复澄清 | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS08 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs | . | 3600 |
| E-01 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 生产问题等价真实模型对话、read、队列、季报脚本哨兵；只有季报 Skill，要求安全分析报告；读取季报说明也不得建任务；回复无适用 Skill | TASK-013 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightE01 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs | . | 3600 |
| E-02 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 新工具字段校验和真实队列；自报缺参、必填参数没有绑定、值为空、引用不存在；明确拒绝，零入队 | TASK-006 | verified | node --test --test-name-pattern PreflightE02 tools/muad-runtime-guard/test/long-task-tool.test.mjs | . | 120 |
| E-03 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实 exec/bash hooks、命令判定与真实队列；前台执行长任务脚本；block且零提交；ls/cat/grep 等普通查看放行 | TASK-007 | verified | node --test --test-name-pattern PreflightE03 tools/muad-runtime-guard/test/long-task-hooks.test.mjs | . | 120 |
| E-04 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实提交入口/队列关闭与 I/O 失败边界；manager不可用或写入失败；不返回已启动，不退化前台执行，诊断脱敏 | TASK-006 | verified | node --test --test-name-pattern PreflightE04 tools/muad-runtime-guard/test/long-task-tool.test.mjs | . | 120 |
| E-05 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 可信工具上下文、真实 grant/root 解析；伪造 agent/session/peer、越权 Skill、root traversal、读取后撤销授权；拒绝且无其他用户输出 | TASK-003 | verified | node --test --test-name-pattern PreflightE05 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | . | 120 |
| E-06 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实后台消息构造、非零退出脚本、状态与投递；脚本失败写 stderr/非零；记录失败，不修改客户 ID 自动重试，保留既有输出及错误转发 | TASK-004 | verified | node --test --test-name-pattern PreflightE06 tools/muad-runtime-guard/test/long-task-manager.test.mjs | . | 120 |
| B-01 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 实际多轮模型会话及队列；“第2个”只关联本会话未取消候选；用户改换目标、取消或切换用户后不能复用旧选择 | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB01 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs | . | 3600 |
| B-02 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 实际 /skill: 分发与模型预检；/skill:季报但缺 ID；先追问，零任务；/skill:提供完整输入按预检后提交，无额外确认 | TASK-013 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB02 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs | . | 3600 |
| B-03 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实 manager持久化、重启恢复和执行消息；新任务保持明确输入；旧队列记录无新字段仍可恢复原行为；不承诺已存在的错误任务自动取消 | TASK-004 | verified | node --test --test-name-pattern PreflightB03 tools/muad-runtime-guard/test/long-task-manager.test.mjs | . | 120 |
| B-04 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 真实文档与模型、提交入口；明确无参 Skill 可执行；未说明参数或文档矛盾时先澄清并提示完善文档，零提交 | TASK-012 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | . | 3600 |
| B-05 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 实际 read after hook、版本标识与授权；未读/读取失败/文档更新后沿用旧预检记录，拒绝并要求重新读取；read成功本身零副作用 | TASK-002 | verified | node --test --test-name-pattern PreflightB05 tools/muad-runtime-guard/test/skill-preflight-context.test.mjs | . | 120 |
| S-09 | skill-execution-preflight.design.md#2.5 验收条件 | E2E | 控制面 DTO→schema/transaction→renderer→真实 Worker工具可见性；更新指导规则与配套插件；校验/健康通过后生效；工具在业务 Agent 可见且 main 不可用；失败恢复 last-good | TASK-013 | verified | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS09 tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs | . | 3600 |
| S-14 | skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点 | integration | 真实LongTaskManager、临时状态文件、受控I/O错误与子进程启动边界；队列关闭或提交写入失败明确返回失败，不运行新任务、不消耗队列槽；存量running任务保留 | TASK-005 | verified | node --test --test-name-pattern PreflightS14 tools/muad-runtime-guard/test/long-task-manager.test.mjs | . | 120 |
| S-10 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 真实工具参数校验、错误契约和输入对象；未知字段、重复绑定、空值、缺必填和非法枚举拒绝；明确无参通过 | TASK-001 | verified | node --test --test-name-pattern PreflightS10 tools/muad-runtime-guard/test/long-task-input.test.mjs | . | 120 |
| S-11 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 真实插件注册、hook生命周期与可信工具工厂；上游API边界可 spy；注册准确，业务上下文使用同manager；main/后台不允许提交，logger无敏感输入 | TASK-009 | verified | node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | . | 120 |
| S-12 | skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点 | integration | 真实 Go-free DTO fixture、Node schema/renderer、指导输出；唯一/多候选/缺参规则与工具可见性确定性输出；普通Skill机制保留，不恢复废弃工具 | TASK-010 | verified | node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs | . | 120 |
| S-13 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实 fixture文档/脚本和环境参数解析；不调用外部模型；fixture覆盖各匹配/入参场景；环境缺项明确失败，无真实客户投递；脚本输出/哨兵可机器校验 | TASK-011 | verified | node --test --test-name-pattern PreflightS13 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

| S-15 | skill-execution-preflight.design.md#3.3 数据与上下文 | integration | 真实turn hooks、读取ledger、preflight与临时授权文档；真实发送者与session尾段不同时仅采用服务端事件投递目标；伪造字段/跨用户/跨会话拒绝；同run不同用户隔离 | TASK-014 | verified | node --test --test-name-pattern PreflightS15 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | . | 120 |
| S-16 | skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点 | integration | 真实插件注册、manager任务索引与shared Skill lease；前台预检零lease；只有真实running后台任务取其可信Skill获取lease并在end释放；伪造后台不获取 | TASK-015 | verified | node --test --test-name-pattern PreflightS16 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | . | 120 |
| S-17 | skill-execution-preflight.design.md#3.2 架构与执行流程 | integration | 真实renderer指导输出与fixture配置文档；取消/改换目标/跨会话不得复用旧候选；显式opt-in E2E命令一致，实际IM斜杠与故障恢复准备明确 | TASK-016 | verified | node --test --test-name-pattern PreflightS17 bin/test/skill-preflight-guidance.test.mjs | . | 120 |

| S-18 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 真实提交工具、manager与多session同peer队列；同peer池已有另一sourceSession时相同可信run重试仍只产生一个taskId和一次执行 | TASK-017 | verified | node --test --test-name-pattern PreflightS18 tools/muad-runtime-guard/test/long-task-tool.test.mjs | . | 120 |
| S-19 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实renderer输出、终验配置校验和fixture文档；只比较当前用户effective长任务集合，平台protected普通Skill保留；多余长任务拒绝，工具/model缺失明确失败 | TASK-018 | verified | node --test --test-name-pattern PreflightS19 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

| S-20 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 实际插件manifest与registerTool声明；contracts.tools必须包含提交工具，保证上游注册可见 | TASK-019 | verified | node --test --test-name-pattern PreflightS20 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | . | 120 |

| S-21 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 真实turn/read/preflight接线；Mattermost投递user:前缀与同一会话身份等价，跨用户仍拒绝 | TASK-019 | verified | node --test --test-name-pattern PreflightS21 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | . | 120 |

| S-22 | skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点 | integration | 实际API Go AST检查；只放行两个中央封装、handler与伪装helper拒绝 | TASK-019 | verified | go test ./internal/api -run TestHTTPEncoder -count=1 | console/backend | 120 |

| S-23 | skill-execution-preflight.design.md#3.2 架构与执行流程 | integration | Console实际长任务辅助文档生成；先读真实SKILL.md和预检、accepted后才报提交，不包含旧虚假回执 | TASK-020 | verified | go test ./internal/api -run PreflightS23 -count=1 | console/backend | 120 |

| S-24 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 实际E2E场景命令配置；允许场景选择真实Worker，独立Agent和workspace，非法argv拒绝 | TASK-021 | verified | node --test --test-name-pattern PreflightS24 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

| S-25 | skill-execution-preflight.design.md#3.4 工具与内部接口 | integration | 实际插件多次注册、turn/read hooks和提交工具；同Worker共享有界预检状态，跨会话与结束后拒绝 | TASK-022 | verified | node --test --test-name-pattern PreflightS25 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | . | 120 |

| S-26 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 实际Node文件读取和HTTP工具探测；正确使用配置鉴权、空参数不提交，主Agent不可用与业务可用响应可观测 | TASK-023 | verified | node --test --test-name-pattern PreflightS26 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

S-01～S-09、E-01～E-06、B-01～B-05原设计20场景完整继承；S-10～S-14为从设计接口/质量章节派生的5项局部functional验收，补齐可独立Done的功能任务，不替代原E2E。

S-15～S-17为集成复核后的局部回归，沿用原设计可信上下文、执行租约与候选取消规则；原E2E继续保留。

| S-27 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 真实Skill文档生成不产生矛盾查询授权，实际Console用户响应解包保持Agent隔离校验 | TASK-024 | verified | node --test --test-name-pattern PreflightS27 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

| S-28 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 实际终验回复同义表达的追问检查，保留真实队列与业务零执行断言 | TASK-025 | verified | node --test --test-name-pattern PreflightS28 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |

| S-29 | skill-execution-preflight.design.md#2.5 验收条件 | integration | 统一真实候选追问表达检查，接受先选一个与回复选1/2，拒绝纯执行回执 | TASK-026 | verified | node --test --test-name-pattern PreflightS29 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | . | 120 |
| S-30 | skill-execution-preflight.design.md#3.3 数据与上下文 | integration | 已解析绑定覆盖原始缺参请求，后台禁止重复解析已绑定参数 | TASK-027 | verified | node --test --test-name-pattern PreflightS30 tools/muad-runtime-guard/test/long-task-manager.test.mjs | . | 120 |

## 规则与风险追溯

| 设计规则/风险 | 验证场景 | 负责人 |
|---|---|---|
| RULE-01 | S-01、S-06、E-01 | TASK-008、TASK-013 |
| RULE-02 | S-02 | TASK-012 |
| RULE-03 | S-03、B-01 | TASK-012 |
| RULE-04 | E-01 | TASK-013 |
| RULE-05 | S-04、S-05、E-02 | TASK-006、TASK-012 |
| RULE-06 | E-03、E-04、B-02 | TASK-006、TASK-007、TASK-013 |
| RULE-07 | E-05、B-03、S-07 | TASK-003、TASK-004、TASK-006 |
| RULE-08 | S-08、E-06 | TASK-004、TASK-012 |
| RISK-01 | S-03、S-04、E-01、E-02 | TASK-006、TASK-012、TASK-013 |
| RISK-02 | B-04 | TASK-012 |
| RISK-03 | S-01、S-06 | TASK-008 |
| RISK-04 | E-03、B-02、S-09 | TASK-007、TASK-013 |
| RISK-05 | B-01、S-07、E-05 | TASK-003、TASK-006、TASK-012 |
| RISK-06 | S-08、B-03、E-05 | TASK-003、TASK-004、TASK-012 |

## Spec Responsibility

| required Rule | 唯一负责人 | verifier_ref |
|---|---|---|
| runtime-config-and-apply#RULE-runtime-config-001 | TASK-010 | runtime-config-and-apply#RULE-runtime-config-001 |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | TASK-010 | runtime-config-and-apply#RULE-runtime-validate-before-write-001 |
| runtime-directory-structure#RULE-runtime-directory-001 | TASK-009 | runtime-directory-structure#RULE-runtime-directory-001 |
| runtime-isolation-and-security#RULE-runtime-security-001 | TASK-003 | runtime-isolation-and-security#RULE-runtime-security-001 |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | TASK-004 | runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 |
| runtime-skill-execution#RULE-runtime-skill-001 | TASK-008 | runtime-skill-execution#RULE-runtime-skill-001 |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | TASK-006 | runtime-skill-execution#RULE-runtime-skill-layering-001 |
| runtime-skill-execution#RULE-runtime-log-injection-001 | TASK-009 | runtime-skill-execution#RULE-runtime-log-injection-001 |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | TASK-009 | runtime-skill-execution#RULE-runtime-log-prefix-001 |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | TASK-005 | runtime-skill-execution#RULE-runtime-skill-fail-loud-001 |

---

## TASK-001: 输入契约与缺参校验

- **Status**: verified
- **Priority**: P0
- **Depends**: 无
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**:
- **Acceptance-Refs**: S-10
- **Owned Files**: tools/muad-runtime-guard/src/long-task-input.mjs, tools/muad-runtime-guard/test/long-task-input.test.mjs

### Description

定义严格工具参数和稳定拒绝原因；requiredNames 去重，必填值非空，未知字段和身份/路径注入拒绝。明确无参允许空绑定；不把模型自报字段当成文档全部要求的证明。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 定义严格工具参数和稳定拒绝原因；requiredNames 去重，必填值非空，未知字段和身份/路径注入拒绝。明确无参允许空绑定；不把模型自报字段当成文档全部要求的证明。
- [x] [S-10][integration] 真实工具参数校验、错误契约和输入对象：未知字段、重复绑定、空值、缺必填和非法枚举拒绝；明确无参通过；命令 `node --test --test-name-pattern PreflightS10 tools/muad-runtime-guard/test/long-task-input.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-10 | integration | 真实工具参数校验、错误契约和输入对象 | 未知字段、重复绑定、空值、缺必填和非法枚举拒绝；明确无参通过 | tools/muad-runtime-guard/test/long-task-input.test.mjs / PreflightS10（待新增） | node --test --test-name-pattern PreflightS10 tools/muad-runtime-guard/test/long-task-input.test.mjs | verified |

### Acceptance Evidence

RED（2026-10-01）：`node --test --test-name-pattern PreflightS10 tools/muad-runtime-guard/test/long-task-input.test.mjs` 失败；新契约模块尚未实现，ERR_MODULE_NOT_FOUND。测试已覆盖完整输入、明确无参、必填去重、空值、重复绑定、未知键、身份/路径注入与非法枚举。原始输出：/tmp/muad-preflight-001-red.log。GREEN：同一命令通过，3个测试全部收集通过；验收runner已将S-10写为verified。断言位于long-task-input.test.mjs三个PreflightS10用例；调用真实validateLongTaskInput，不mock输入对象或验证器；返回复制后的输入，不别名原绑定。
- S-10: verified — automated command passed; run_id=1f430367b0934165a4f3a1bc423301cc (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=d1139637b20a4f179bcf74820deb4eaa (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-10: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-002: 成功读取记录与文档变更检查

- **Status**: verified
- **Priority**: P0
- **Depends**: 无
- **Source**: skill-execution-preflight.design.md#3.3 数据与上下文
- **Spec-Refs**:
- **Acceptance-Refs**: B-05
- **Owned Files**: tools/muad-runtime-guard/src/skill-preflight-context.mjs, tools/muad-runtime-guard/test/skill-preflight-context.test.mjs

### Description

只在 read after hook 成功时记录当前轮文档真实路径、有效 Skill 身份与修订标识；隔离 agent/session/run，失败、未读、旧轮和文档变化均拒绝。采用有界 TTL，读取本身不入队、不占执行槽。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 只在 read after hook 成功时记录当前轮文档真实路径、有效 Skill 身份与修订标识；隔离 agent/session/run，失败、未读、旧轮和文档变化均拒绝。采用有界 TTL，读取本身不入队、不占执行槽。
- [x] [B-05][integration] 实际 read after hook、版本标识与授权：未读/读取失败/文档更新后沿用旧预检记录，拒绝并要求重新读取；read成功本身零副作用；命令 `node --test --test-name-pattern PreflightB05 tools/muad-runtime-guard/test/skill-preflight-context.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| B-05 | integration | 实际 read after hook、版本标识与授权 | 未读/读取失败/文档更新后沿用旧预检记录，拒绝并要求重新读取；read成功本身零副作用 | tools/muad-runtime-guard/test/skill-preflight-context.test.mjs / PreflightB05（待新增） | node --test --test-name-pattern PreflightB05 tools/muad-runtime-guard/test/skill-preflight-context.test.mjs | verified |

### Acceptance Evidence

RED：PreflightB05 命令失败，ERR_MODULE_NOT_FOUND，成功读取记录及文档变更校验模块尚不存在；原始输出/tmp/muad-preflight-002-red.log。

GREEN：同一命令5个测试全部通过；runner写入B-05 verified。断言位于skill-preflight-context.test.mjs各PreflightB05用例；真实临时SKILL.md、哈希、符号链接、TTL与实际afterToolCall工厂。读取成功只记录元信息，未接任何队列/脚本/进度接口；失败、跨用户/会话/轮次及文档变化都不能建立本轮准备记录。
- B-05: verified — automated command passed; run_id=bfc21e1d9a32435d8b474c20ad7ba394 (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=8a3628e9cf4046349860dff7948043db (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-003: 可信授权与提交上下文解析

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001, TASK-002
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001
- **Acceptance-Refs**: E-05
- **Owned Files**: tools/muad-runtime-guard/src/long-task-preflight.mjs, tools/muad-runtime-guard/test/long-task-preflight.test.mjs

### Description

从当前工具/turn 的可信上下文获取身份和投递信息，重新解析 effective longTask grant；拒绝 main、身份缺失、跨用户、路径穿越和读取后撤销。保留 system 优先与显式覆盖策略。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 从当前工具/turn 的可信上下文获取身份和投递信息，重新解析 effective longTask grant；拒绝 main、身份缺失、跨用户、路径穿越和读取后撤销。保留 system 优先与显式覆盖策略。
- [x] [E-05][integration] 可信工具上下文、真实 grant/root 解析：伪造 agent/session/peer、越权 Skill、root traversal、读取后撤销授权；拒绝且无其他用户输出；命令 `node --test --test-name-pattern PreflightE05 tools/muad-runtime-guard/test/long-task-preflight.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-security-001 verifier：`runtime-isolation-and-security#RULE-runtime-security-001`；输入为本TASK及依赖diff、真实组件与验收证据；可信agent/session/peer与授权root；跨用户、main与路径穿越拒绝，不泄露其他用户内容；功能命令 `node --test --test-name-pattern PreflightE05 tools/muad-runtime-guard/test/long-task-preflight.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| E-05 | integration | 可信工具上下文、真实 grant/root 解析 | 伪造 agent/session/peer、越权 Skill、root traversal、读取后撤销授权；拒绝且无其他用户输出 | tools/muad-runtime-guard/test/long-task-preflight.test.mjs / PreflightE05（待新增） | node --test --test-name-pattern PreflightE05 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | verified |
| runtime-isolation-and-security#RULE-runtime-security-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 可信agent/session/peer与授权root；跨用户、main与路径穿越拒绝，不泄露其他用户内容；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/long-task-preflight.test.mjs及diff | node --test --test-name-pattern PreflightE05 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | verified |

### Acceptance Evidence

RED：PreflightE05失败，新授权预检模块尚不存在，ERR_MODULE_NOT_FOUND；原始输出/tmp/muad-preflight-003-red.log。

GREEN：同命令3个用例通过，runner写入E-05 verified。真实读取manifest、文档哈希及grant；验证模型身份字段拒绝、main/跨Agent/后台会话拒绝、投递peer不一致拒绝、撤销授权与修改manifest拒绝，失败无队列接口调用。规范security verifier保持manual，提交本任务diff与测试证据待需求终验确认。
- E-05: verified — automated command passed; run_id=cde101c9e0884ba0b8fe8db3efe4b43c (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=75454e89cf154f0a90bf1029a5123df8 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-004: 后台输入传递及旧记录兼容

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: skill-execution-preflight.design.md#3.3 数据与上下文
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: B-03, E-06
- **Owned Files**: tools/muad-runtime-guard/src/long-task-manager.mjs, tools/muad-runtime-guard/test/long-task-manager.test.mjs

### Description

任务携带 executionInputs，保持最终目标、原用户请求和最新补充参数；后台消息要求使用固定 Skill 和输入、不猜 ID、不自动换参数重试。新旧记录兼容恢复，真实非零退出和失败投递保留。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 任务携带 executionInputs，保持最终目标、原用户请求和最新补充参数；后台消息要求使用固定 Skill 和输入、不猜 ID、不自动换参数重试。新旧记录兼容恢复，真实非零退出和失败投递保留。
- [x] [B-03][integration] 真实 manager持久化、重启恢复和执行消息：新任务保持明确输入；旧队列记录无新字段仍可恢复原行为；不承诺已存在的错误任务自动取消；命令 `node --test --test-name-pattern PreflightB03 tools/muad-runtime-guard/test/long-task-manager.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] [E-06][integration] 真实后台消息构造、非零退出脚本、状态与投递：脚本失败写 stderr/非零；记录失败，不修改客户 ID 自动重试，保留既有输出及错误转发；命令 `node --test --test-name-pattern PreflightE06 tools/muad-runtime-guard/test/long-task-manager.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-secret-file-mode-001 verifier：`runtime-isolation-and-security#RULE-runtime-secret-file-mode-001`；输入为本TASK及依赖diff、真实组件与验收证据；真实队列文件0600，压缩原子rename，token仍规范路径0400；输入不写普通日志；功能命令 `node --test --test-name-pattern PreflightB03 tools/muad-runtime-guard/test/long-task-manager.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| B-03 | integration | 真实 manager持久化、重启恢复和执行消息 | 新任务保持明确输入；旧队列记录无新字段仍可恢复原行为；不承诺已存在的错误任务自动取消 | tools/muad-runtime-guard/test/long-task-manager.test.mjs / PreflightB03（待新增） | node --test --test-name-pattern PreflightB03 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |
| E-06 | integration | 真实后台消息构造、非零退出脚本、状态与投递 | 脚本失败写 stderr/非零；记录失败，不修改客户 ID 自动重试，保留既有输出及错误转发 | tools/muad-runtime-guard/test/long-task-manager.test.mjs / PreflightE06（待新增） | node --test --test-name-pattern PreflightE06 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |
| runtime-isolation-and-security#RULE-runtime-secret-file-mode-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 真实队列文件0600，压缩原子rename，token仍规范路径0400；输入不写普通日志；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/long-task-manager.test.mjs及diff | node --test --test-name-pattern PreflightB03 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |

### Acceptance Evidence

RED：PreflightB03未保留executionInputs；PreflightE06后台消息缺少已确定参数与禁止猜测要求，两个测试失败。原始输出/tmp/muad-preflight-004-red.log。

GREEN：两个场景通过，runner写入E-06/B-03 verified。真实JSONL/0600/重启恢复验证新输入与旧记录；snapshot不暴露绑定值；任务输入复制不别名。真实Node子进程stderr并退出7，manager失败状态/通知/单次执行及原输入保持断言通过；OpenClaw外部执行器在integration边界用真实Node进程替代，不冒充真实模型E2E。规范文件权限manual证据登记待终验。
- E-06: verified — automated command passed; run_id=42096b2f433f4c698de784824270d429 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=42096b2f433f4c698de784824270d429 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=476141d3ae12466d80d98fed00b54e0f (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=476141d3ae12466d80d98fed00b54e0f (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-06: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-005: 提交持久化失败明确拒绝

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-14
- **Owned Files**: tools/muad-runtime-guard/src/long-task-manager.mjs, tools/muad-runtime-guard/test/long-task-manager.test.mjs

### Description

将提交接受与持久化成功协调，修复仅记日志却返回 accepted 的失败路径。状态写入失败不创建可运行新任务、不启动子进程，不改正在运行旧任务的既有失败恢复；队列关闭明确拒绝，诊断脱敏。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 将提交接受与持久化成功协调，修复仅记日志却返回 accepted 的失败路径。状态写入失败不创建可运行新任务、不启动子进程，不改正在运行旧任务的既有失败恢复；队列关闭明确拒绝，诊断脱敏。
- [x] [S-14][integration] 真实LongTaskManager、临时状态文件、受控I/O错误与子进程启动边界：队列关闭或提交写入失败明确返回失败，不运行新任务、不消耗队列槽；存量running任务保留；命令 `node --test --test-name-pattern PreflightS14 tools/muad-runtime-guard/test/long-task-manager.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-skill-fail-loud-001 verifier：`runtime-skill-execution#RULE-runtime-skill-fail-loud-001`；输入为本TASK及依赖diff、真实组件与验收证据；提交持久化失败必须明确拒绝不前台fallback；任务脚本stderr/nonzero与原日志转发保持；功能命令 `node --test --test-name-pattern PreflightS14 tools/muad-runtime-guard/test/long-task-manager.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-14 | integration | 真实LongTaskManager、临时状态文件、受控I/O错误与子进程启动边界 | 队列关闭或提交写入失败明确返回失败，不运行新任务、不消耗队列槽；存量running任务保留 | tools/muad-runtime-guard/test/long-task-manager.test.mjs / PreflightS14（待新增） | node --test --test-name-pattern PreflightS14 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |
| runtime-skill-execution#RULE-runtime-skill-fail-loud-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 提交持久化失败必须明确拒绝不前台fallback；任务脚本stderr/nonzero与原日志转发保持；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/long-task-manager.test.mjs及diff | node --test --test-name-pattern PreflightS14 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |

### Acceptance Evidence

RED：PreflightS14两例失败；初次JSONL写入失败及接受后启动前写入失败时，manager仍启动执行且未抛错。真实临时文件/目录构造I/O故障，无fake fs。原始输出/tmp/muad-preflight-005-red.log。

GREEN：PreflightS14三例通过，runner写入verified。真实I/O错误覆盖初次写入、接受后启动前写入及已有running任务不受新提交失败影响；零新执行、零队列槽，恢复后旧任务正常结束。状态日志只记taskId与稳定原因，不泄露路径/绑定值。原脚本stderr/非零回归见TASK-004 E-06，manual规则待终验确认。
- S-14: verified — automated command passed; run_id=31e402b15b1d4d9688f77fc09fc4afc9 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=e083ce33decc4505b4bc4d7b7c603f51 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=b426280ef8de4786b7da2f97540fc537 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=ef89636f230e4a5fb8bb6a9d5d31c60b (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=20c3a12905d043e898b1e76e978f771c (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-14: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-006: 显式提交工具与同轮幂等

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-003, TASK-005
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-layering-001
- **Acceptance-Refs**: S-07, E-02, E-04
- **Owned Files**: tools/muad-runtime-guard/src/long-task-tool.mjs, tools/muad-runtime-guard/test/long-task-tool.test.mjs

### Description

实现 muad_submit_long_task 工厂及 execute，串联契约/读取/授权校验和真实 manager。相同可信 run/Skill 的重试及并发调用共享接受结果；同轮不同 Skill 拒绝，下一轮允许新任务；不使用模型传入授权布尔值。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 实现 muad_submit_long_task 工厂及 execute，串联契约/读取/授权校验和真实 manager。相同可信 run/Skill 的重试及并发调用共享接受结果；同轮不同 Skill 拒绝，下一轮允许新任务；不使用模型传入授权布尔值。
- [x] [S-07][integration] 真实授权索引、工具上下文、manager、临时状态文件、shared lease：两用户同名 Skill 按各自 root 分离；有效 system 优先；同轮重复工具调用返回同任务；并发不超限；命令 `node --test --test-name-pattern PreflightS07 tools/muad-runtime-guard/test/long-task-tool.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] [E-02][integration] 新工具字段校验和真实队列：自报缺参、必填参数没有绑定、值为空、引用不存在；明确拒绝，零入队；命令 `node --test --test-name-pattern PreflightE02 tools/muad-runtime-guard/test/long-task-tool.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] [E-04][integration] 真实提交入口/队列关闭与 I/O 失败边界：manager不可用或写入失败；不返回已启动，不退化前台执行，诊断脱敏；命令 `node --test --test-name-pattern PreflightE04 tools/muad-runtime-guard/test/long-task-tool.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-skill-layering-001 verifier：`runtime-skill-execution#RULE-runtime-skill-layering-001`；输入为本TASK及依赖diff、真实组件与验收证据；system优先与protected，public/private默认冲突，只依effective grant处理显式override；队列同名用户隔离；功能命令 `node --test --test-name-pattern PreflightS07 tools/muad-runtime-guard/test/long-task-tool.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-07 | integration | 真实授权索引、工具上下文、manager、临时状态文件、shared lease | 两用户同名 Skill 按各自 root 分离；有效 system 优先；同轮重复工具调用返回同任务；并发不超限 | tools/muad-runtime-guard/test/long-task-tool.test.mjs / PreflightS07（待新增） | node --test --test-name-pattern PreflightS07 tools/muad-runtime-guard/test/long-task-tool.test.mjs | verified |
| E-02 | integration | 新工具字段校验和真实队列 | 自报缺参、必填参数没有绑定、值为空、引用不存在；明确拒绝，零入队 | tools/muad-runtime-guard/test/long-task-tool.test.mjs / PreflightE02（待新增） | node --test --test-name-pattern PreflightE02 tools/muad-runtime-guard/test/long-task-tool.test.mjs | verified |
| E-04 | integration | 真实提交入口/队列关闭与 I/O 失败边界 | manager不可用或写入失败；不返回已启动，不退化前台执行，诊断脱敏 | tools/muad-runtime-guard/test/long-task-tool.test.mjs / PreflightE04（待新增） | node --test --test-name-pattern PreflightE04 tools/muad-runtime-guard/test/long-task-tool.test.mjs | verified |
| runtime-skill-execution#RULE-runtime-skill-layering-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | system优先与protected，public/private默认冲突，只依effective grant处理显式override；队列同名用户隔离；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/long-task-tool.test.mjs及diff | node --test --test-name-pattern PreflightS07 tools/muad-runtime-guard/test/long-task-tool.test.mjs | verified |

### Acceptance Evidence

RED：提交工具模块尚未实现，PreflightS07/E02/E04 加载失败（ERR_MODULE_NOT_FOUND long-task-tool.mjs），日志 /tmp/muad-preflight-006-red.log。真实 manager、授权索引、文档及状态文件已构造。

GREEN：三个场景命令均通过；实际文件授权、manager JSONL 与 shared lease 路径。S07断言同轮并发同taskId、两用户system/private root隔离、同轮另一Skill拒绝、新轮排队不超限，shared lease重复获取拒绝。E02断言无绑定/空值/越权/未知身份字段零队列；E04真实目录写入错误、closed与缺失manager明确拒绝且结果无路径/值。manual规范终验确认。
- S-07: verified — automated command passed; run_id=99c24a9d49154bbcab934fff7243fa44 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=99c24a9d49154bbcab934fff7243fa44 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=99c24a9d49154bbcab934fff7243fa44 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=1a22d223b7264bc8ac61c81491a28a21 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=1a22d223b7264bc8ac61c81491a28a21 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=1a22d223b7264bc8ac61c81491a28a21 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-07: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-007: 取消 read、斜杠与 exec 隐式入队

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-002, TASK-006
- **Source**: skill-execution-preflight.design.md#3.2 架构与执行流程
- **Spec-Refs**:
- **Acceptance-Refs**: E-03
- **Owned Files**: tools/muad-runtime-guard/src/long-task-hooks.mjs, tools/muad-runtime-guard/test/long-task-hooks.test.mjs

### Description

read 返回真实文件，after hook接入成功读取记录；删除读文件入队、提交桩改写和串行 fallback。/skill: 保留指定名称语义但进入预检；前台命中任务脚本只 block 不 submit，ls/cat/grep 等查看放行。后台会话防递归保留。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] read 返回真实文件，after hook接入成功读取记录；删除读文件入队、提交桩改写和串行 fallback。/skill: 保留指定名称语义但进入预检；前台命中任务脚本只 block 不 submit，ls/cat/grep 等查看放行。后台会话防递归保留。
- [x] [E-03][integration] 真实 exec/bash hooks、命令判定与真实队列：前台执行长任务脚本；block且零提交；ls/cat/grep 等普通查看放行；命令 `node --test --test-name-pattern PreflightE03 tools/muad-runtime-guard/test/long-task-hooks.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| E-03 | integration | 真实 exec/bash hooks、命令判定与真实队列 | 前台执行长任务脚本；block且零提交；ls/cat/grep 等普通查看放行 | tools/muad-runtime-guard/test/long-task-hooks.test.mjs / PreflightE03（待新增） | node --test --test-name-pattern PreflightE03 tools/muad-runtime-guard/test/long-task-hooks.test.mjs | verified |

### Acceptance Evidence

RED：原exec自动提交，blockReason宣称已提交；/skill拦截直接返回handled；新断言失败。日志/tmp/muad-preflight-007-red.log。

GREEN：三个hook测试通过；实际文件和manager，12种解释器/包装/cwd/复合执行命令均block且零队列；查看命令放行。read保留真实内容，after成功才记ledger，agentEnd清理；斜杠交给模型预检。删除桩、自动submit及fallback，日志不含原prompt/command。
- E-03: verified — automated command passed; run_id=c9e1b1d7c37d4a9e9b688e9f338ba417 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=1789f28860cb4f2d9bfd2dd487ec8817 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-008: 长任务审计与进度迁到实际执行边界

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-006, TASK-007
- **Source**: skill-execution-preflight.design.md#3.2 架构与执行流程
- **Spec-Refs**: runtime-skill-execution#RULE-runtime-skill-001
- **Acceptance-Refs**: S-01, S-06
- **Owned Files**: tools/muad-runtime-guard/src/skill-audit-hooks.mjs, tools/muad-runtime-guard/test/skill-audit-hooks.test.mjs, tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs

### Description

只调整长任务：read与缺参不登记执行或推送进度；接受提交形成队列状态，实际开始执行后登记审计。明确可信后台 task 与 Skill 关联，重读/重试不重复审计。普通 Skill 的原读取激活/审计流程保留，并做回归。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 只调整长任务：read与缺参不登记执行或推送进度；接受提交形成队列状态，实际开始执行后登记审计。明确可信后台 task 与 Skill 关联，重读/重试不重复审计。普通 Skill 的原读取激活/审计流程保留，并做回归。
- [x] [S-01][integration] 真实文档、long-task/audit/progress hooks、真实队列状态文件；外部通知可 spy：read SKILL.md/脚本/引用文件；队列与执行记录不变，脚本哨兵未生成、无进度通知；命令 `node --test --test-name-pattern PreflightS01 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] [S-06][integration] 真实激活 hooks 和提交入口、记录与进度投递捕获：只读说明不登记长任务执行；排队与真实开始分别产生对应状态，不因重复 read 重复审计；命令 `node --test --test-name-pattern PreflightS06 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-skill-001 verifier：`runtime-skill-execution#RULE-runtime-skill-001`；输入为本TASK及依赖diff、真实组件与验收证据；长任务审计/进度/并发按执行边界，普通Skill原行为保留；读文档零任务、零进度；功能命令 `node --test --test-name-pattern PreflightS01 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-01 | integration | 真实文档、long-task/audit/progress hooks、真实队列状态文件；外部通知可 spy | read SKILL.md/脚本/引用文件；队列与执行记录不变，脚本哨兵未生成、无进度通知 | tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs / PreflightS01（待新增） | node --test --test-name-pattern PreflightS01 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs | verified |
| S-06 | integration | 真实激活 hooks 和提交入口、记录与进度投递捕获 | 只读说明不登记长任务执行；排队与真实开始分别产生对应状态，不因重复 read 重复审计 | tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs / PreflightS06（待新增） | node --test --test-name-pattern PreflightS06 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs | verified |
| runtime-skill-execution#RULE-runtime-skill-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 长任务审计/进度/并发按执行边界，普通Skill原行为保留；读文档零任务、零进度；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs及diff | node --test --test-name-pattern PreflightS01 tools/muad-runtime-guard/test/skill-preflight-flow.test.mjs | verified |

### Acceptance Evidence

RED：S01读取/斜杠长任务触发审计，S06实际后台run没有审计。真实LongTaskManager/ProgressManager/hooks和文件，只有通知/外部审计使用spy。日志/tmp/muad-preflight-008-red.log。

GREEN：S01/S06及13例普通Skill审计回归通过；真实manager/progress/read-hooks/tool及临时文件，读取和缺参零queue/JSONL/通知/哨兵；实际running后台以taskId审计一次，queued不审计，出队启动后第二份审计；伪造后台session不登记。普通读取/斜杠激活语义及system/private scope回归保持。manual规范终验确认。
- S-01: verified — automated command passed; run_id=470614cbc7534fa8a769a506b44daa1b (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=470614cbc7534fa8a769a506b44daa1b (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=5c226b259db740c285ef682af2bf0f16 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=5c226b259db740c285ef682af2bf0f16 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-01: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-06: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-009: 插件注册、上下文接线与工具策略

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-006, TASK-007, TASK-008
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001
- **Acceptance-Refs**: S-11
- **Owned Files**: tools/muad-runtime-guard/src/index.mjs, tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs, tools/muad-runtime-guard/test/plugin-health.test.mjs

### Description

参考现有 session-manager registerTool 工厂接线，复用同一 manager/读取记录；注册 read after hook 和前台 turn生命周期清理。业务 Agent 工具可用、main与后台递归提交拒绝；注入 logger 和稳定标签，不回显原始 prompt/参数/命令。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 参考现有 session-manager registerTool 工厂接线，复用同一 manager/读取记录；注册 read after hook 和前台 turn生命周期清理。业务 Agent 工具可用、main与后台递归提交拒绝；注入 logger 和稳定标签，不回显原始 prompt/参数/命令。
- [x] [S-11][integration] 真实插件注册、hook生命周期与可信工具工厂；上游API边界可 spy：注册准确，业务上下文使用同manager；main/后台不允许提交，logger无敏感输入；命令 `node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-directory-001 verifier：`runtime-directory-structure#RULE-runtime-directory-001`；输入为本TASK及依赖diff、真实组件与验收证据；新增模块仅在tools/bin，注册工厂使用外置API，不fork上游或恢复已废弃runner；功能命令 `node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] RULE-runtime-log-injection-001 verifier：`runtime-skill-execution#RULE-runtime-log-injection-001`；输入为本TASK及依赖diff、真实组件与验收证据；模块log默认no-op，插件注入api.logger.warn；拒绝失败不散落console调用；功能命令 `node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] RULE-runtime-log-prefix-001 verifier：`runtime-skill-execution#RULE-runtime-log-prefix-001`；输入为本TASK及依赖diff、真实组件与验收证据；稳定模块/动作标签；只记原因码/身份/taskId，不回显prompt/值/命令/密钥；功能命令 `node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-11 | integration | 真实插件注册、hook生命周期与可信工具工厂；上游API边界可 spy | 注册准确，业务上下文使用同manager；main/后台不允许提交，logger无敏感输入 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs / PreflightS11（待新增） | node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |
| runtime-directory-structure#RULE-runtime-directory-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 新增模块仅在tools/bin，注册工厂使用外置API，不fork上游或恢复已废弃runner；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs及diff | node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |
| runtime-skill-execution#RULE-runtime-log-injection-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 模块log默认no-op，插件注入api.logger.warn；拒绝失败不散落console调用；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs及diff | node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |
| runtime-skill-execution#RULE-runtime-log-prefix-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 稳定模块/动作标签；只记原因码/身份/taskId，不回显prompt/值/命令/密钥；原规范manual verifier不降级，另登记人工审查 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs及diff | node --test --test-name-pattern PreflightS11 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |

### Acceptance Evidence

RED：新工具注册数量0；长任务斜杠预检占Skill lease（active=1），真实插件注册/manager/shared lease。日志/tmp/muad-preflight-009-red.log。

GREEN：S11两例和plugin-health五例通过；真实插件工厂、after-read/agentEnd接线、共享manager及lease。工具缺runId由唯一可信业务turn解析；main/background/清理后调用拒绝；敏感prompt/目标/值不在logger。长任务斜杠前台不占执行lease。plugin-health spy补registerTool与新增after hook，未降级健康契约。manual规范终验确认。
- S-11: verified — automated command passed; run_id=f789dc516ad24c6e9552b44206aa312d (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=bf6fa5e0e3e94e04b4c5e9aa1b75f711 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-010: 固定指导、工具可见性与运维文档

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-009
- **Source**: skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: S-12
- **Owned Files**: bin/openclaw-config-renderer.mjs, bin/test/skill-preflight-guidance.test.mjs, docs/long-task-async-execution.md, bin/test/inject-multi-user-config.test.mjs

### Description

替换旧读取即激活固定指导，不恢复废弃工具。写明唯一直接、多候选选择、无匹配告知、按 SKILL.md检查参数、缺参追问、文档不明先澄清；仅长任务显式提交。确定性 renderer保留schema/事务/代次/health机制；记录配套镜像、旧任务兼容和回滚旧触发行为。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 替换旧读取即激活固定指导，不恢复废弃工具。写明唯一直接、多候选选择、无匹配告知、按 SKILL.md检查参数、缺参追问、文档不明先澄清；仅长任务显式提交。确定性 renderer保留schema/事务/代次/health机制；记录配套镜像、旧任务兼容和回滚旧触发行为。
- [x] [S-12][integration] 真实 Go-free DTO fixture、Node schema/renderer、指导输出：唯一/多候选/缺参规则与工具可见性确定性输出；普通Skill机制保留，不恢复废弃工具；命令 `node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] RULE-runtime-config-001 verifier：`runtime-config-and-apply#RULE-runtime-config-001`；输入为本TASK及依赖diff、真实组件与验收证据；确定性指导及工具策略沿原schema/transaction/generation/health/rollback；最终真实应用见S-09；功能命令 `node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] RULE-runtime-validate-before-write-001 verifier：`runtime-config-and-apply#RULE-runtime-validate-before-write-001`；输入为本TASK及依赖diff、真实组件与验收证据；真实renderer输入必须先validateRuntimeConfig，事务原子写；无绕过代次/健康检查；功能命令 `node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs`，代码审查按原manual verifier登记待用户确认。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-12 | integration | 真实 Go-free DTO fixture、Node schema/renderer、指导输出 | 唯一/多候选/缺参规则与工具可见性确定性输出；普通Skill机制保留，不恢复废弃工具 | bin/test/skill-preflight-guidance.test.mjs / PreflightS12（待新增） | node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs | verified |
| runtime-config-and-apply#RULE-runtime-config-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 确定性指导及工具策略沿原schema/transaction/generation/health/rollback；最终真实应用见S-09；原规范manual verifier不降级，另登记人工审查 | docs/long-task-async-execution.md及diff | node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs | verified |
| runtime-config-and-apply#RULE-runtime-validate-before-write-001 | integration | 依赖TASK及本TASK的实际实现、验收输入与临时材料 | 真实renderer输入必须先validateRuntimeConfig，事务原子写；无绕过代次/健康检查；原规范manual verifier不降级，另登记人工审查 | docs/long-task-async-execution.md及diff | node --test --test-name-pattern PreflightS12 bin/test/skill-preflight-guidance.test.mjs | verified |

### Acceptance Evidence

RED：旧固定块没有匹配/缺参规则，业务allowlist没有提交工具，S12两例失败。日志/tmp/muad-preflight-010-red.log。

GREEN：31例renderer/guidance/apply回归通过；真实DTO fixture→schema→renderer，旧固定块被替换且自定义内容保留，重复字节一致。业务allow及全局alsoAllow包含新tool，main deny；invalid generation拒绝；废弃runner不恢复。运行文档改为当前显式提交/审计及配套发布回滚说明。规则manual及实际Worker应用S09留终验。
- S-12: verified — automated command passed; run_id=8ffe5c7f109647e1b64bfbb1753c5351 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=9f3d04fa2a6145e3bf896b31f9f08f07 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-12: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-011: 真实模型 E2E 环境与可观测 fixture

- **Status**: verified
- **Priority**: P1
- **Depends**: TASK-010
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**:
- **Acceptance-Refs**: S-13
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/skill-preflight-e2e.md

### Description

构造独立用户、有效模型、候选 Skill 文档、参数查询 fixture、业务脚本哨兵和真实队列/投递读取。以真实 OpenClaw/模型执行后续场景，缺依赖失败而不静默 skip；功能期只校验 fixture及命令，不运行 E2E。

### Checklist
- [x] 先落实本TASK的functional失败用例并记录RED；真实边界不得替换为假实现，只允许设计标明的外部通知/API使用spy。
- [x] 构造独立用户、有效模型、候选 Skill 文档、参数查询 fixture、业务脚本哨兵和真实队列/投递读取。以真实 OpenClaw/模型执行后续场景，缺依赖失败而不静默 skip；功能期只校验 fixture及命令，不运行 E2E。
- [x] [S-13][integration] 真实 fixture文档/脚本和环境参数解析；不调用外部模型：fixture覆盖各匹配/入参场景；环境缺项明确失败，无真实客户投递；脚本输出/哨兵可机器校验；命令 `node --test --test-name-pattern PreflightS13 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs`；实现后执行GREEN并记录关键断言位置。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-13 | integration | 真实 fixture文档/脚本和环境参数解析；不调用外部模型 | fixture覆盖各匹配/入参场景；环境缺项明确失败，无真实客户投递；脚本输出/哨兵可机器校验 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS13（待新增） | node --test --test-name-pattern PreflightS13 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence

RED：E2E support尚未实现，PreflightS13模块加载失败。日志/tmp/muad-preflight-011-red.log。

GREEN：S13两例通过，实际Node脚本/文档/0600哨兵，唯一/多个/无结果查询计数和缺ID非零错误；缺环境明确失败。真实E2E harness只调实际OpenClaw CLI/Console/Worker文件与实际收件日志，不以fake模型替代。隔离用户/模型/通道、fixture安装、健康故障及恢复步骤已记录；编码期未执行模型/E2E。
- S-13: verified — automated command passed; run_id=3e572204f1334a07b3db3abf9d24e1bc (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=43eba474fdf94a1ab34ee4a5a5fd32eb (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-13: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-012: 唯一、多候选与参数补齐 E2E

- **Status**: verified
- **Priority**: P1
- **Depends**: TASK-011
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**:
- **Acceptance-Refs**: S-02, S-03, S-04, S-05, S-08, B-01, B-04
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs, tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs, tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs

### Description

登记真实模型多轮场景：唯一无需确认，多候选选择，名称不能猜 ID，文档允许查询的唯一/多结果/无结果，补齐参数传后台，取消/目标改变/会话隔离，明确无参与文档不明。只编写与登记，执行统一留给 verify-e2e。

### Checklist
- [x] 编写以下真实模型E2E及独立命令，缺少环境依赖明确失败；功能期不执行E2E，仅登记与校验测试模块可加载。
- [x] 登记真实模型多轮场景：唯一无需确认，多候选选择，名称不能猜 ID，文档允许查询的唯一/多结果/无结果，补齐参数传后台，取消/目标改变/会话隔离，明确无参与文档不明。只编写与登记，执行统一留给 verify-e2e。
- [x] [S-02][E2E] renderer→实际 OpenClaw/模型→新工具→队列→脚本→实际回复：单一适用 Skill、提供完整 customerId；无确认追问，恰好一任务，脚本收到正确 ID；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS02 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [S-03][E2E] 实际模型多轮对话、读取工具、新提交工具与队列：两个明确候选，首轮列出候选与差异且零任务；用户选择后参数齐全才执行选定 Skill；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS03 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [S-04][E2E] 真实 SKILL.md 参数要求、实际模型、多轮会话、队列与脚本：文档要求 customerId，仅给客户名称；首轮提示补 ID，零任务/零业务调用；补 ID 后一次提交；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [S-05][E2E] 文档定义的转换工具、实际模型与队列：文档允许名称解析 ID；唯一查询结果才可提交，多结果需用户选择，查不到则追问；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS05 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [S-08][E2E] 实际后台会话、消息构造、脚本、结果投递：用户后续补齐参数；后台收到原请求、最终目标及绑定参数，不丢最新补充，不重复澄清；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS08 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [B-01][E2E] 实际多轮模型会话及队列：“第2个”只关联本会话未取消候选；用户改换目标、取消或切换用户后不能复用旧选择；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB01 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [B-04][E2E] 真实文档与模型、提交入口：明确无参 Skill 可执行；未说明参数或文档矛盾时先澄清并提示完善文档，零提交；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-02 | E2E | renderer→实际 OpenClaw/模型→新工具→队列→脚本→实际回复 | 单一适用 Skill、提供完整 customerId；无确认追问，恰好一任务，脚本收到正确 ID | tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs / PreflightS02（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS02 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs | verified |
| S-03 | E2E | 实际模型多轮对话、读取工具、新提交工具与队列 | 两个明确候选，首轮列出候选与差异且零任务；用户选择后参数齐全才执行选定 Skill | tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs / PreflightS03（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS03 tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs | verified |
| S-04 | E2E | 真实 SKILL.md 参数要求、实际模型、多轮会话、队列与脚本 | 文档要求 customerId，仅给客户名称；首轮提示补 ID，零任务/零业务调用；补 ID 后一次提交 | tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs / PreflightS04（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | verified |
| S-05 | E2E | 文档定义的转换工具、实际模型与队列 | 文档允许名称解析 ID；唯一查询结果才可提交，多结果需用户选择，查不到则追问 | tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs / PreflightS05（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS05 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | verified |
| S-08 | E2E | 实际后台会话、消息构造、脚本、结果投递 | 用户后续补齐参数；后台收到原请求、最终目标及绑定参数，不丢最新补充，不重复澄清 | tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs / PreflightS08（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS08 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs | verified |
| B-01 | E2E | 实际多轮模型会话及队列 | “第2个”只关联本会话未取消候选；用户改换目标、取消或切换用户后不能复用旧选择 | tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs / PreflightB01（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB01 tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs | verified |
| B-04 | E2E | 真实文档与模型、提交入口 | 明确无参 Skill 可执行；未说明参数或文档矛盾时先澄清并提示完善文档，零提交 | tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs / PreflightB04（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB04 tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs | verified |

### Acceptance Evidence

E2E仅登记：matching两例、inputs三例（S05三分支/B04三文档）、turns两例（补充/取消/目标变更/用户隔离/第2个）。实际模型CLI→新工具→真实JSONL/业务/查询/IM收件边界；每例包含目标task数、值及回复断言。编码期仅node --check与无opt-in模块导入，不执行RED/GREEN；所有场景e2e_deferred，缺环境显式失败，未宣称模型效果通过。
- S-02: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- S-05: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- B-01: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- B-04: e2e_deferred — automated command e2e_deferred; run_id=c79a9f7f4f354e4b8fa39081b3ad3073 (confirmed_by: runner)
- S-02: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-04: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-05: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-08: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- B-01: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- B-04: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-08: failed — automated command failed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-05: failed — automated command failed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- B-01: failed — automated command failed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-03: failed — automated command failed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-05: failed — automated command failed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-02: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-05: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-08: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- B-01: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- B-04: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-02: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- S-03: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- S-04: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- S-08: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- B-04: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-013: 误触发、斜杠与实际配置应用 E2E

- **Status**: verified
- **Priority**: P1
- **Depends**: TASK-011
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**:
- **Acceptance-Refs**: E-01, B-02, S-09
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs, tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs

### Description

登记安全分析请求查阅季报而零执行、/skill:缺参先追问/完整输入直接提交，以及真实控制面DTO/事务/renderer/Worker工具可见性与健康失败恢复。不得以hook模拟或fake模型降级这些真实边界。

### Checklist
- [x] 编写以下真实模型E2E及独立命令，缺少环境依赖明确失败；功能期不执行E2E，仅登记与校验测试模块可加载。
- [x] 登记安全分析请求查阅季报而零执行、/skill:缺参先追问/完整输入直接提交，以及真实控制面DTO/事务/renderer/Worker工具可见性与健康失败恢复。不得以hook模拟或fake模型降级这些真实边界。
- [x] [E-01][E2E] 生产问题等价真实模型对话、read、队列、季报脚本哨兵：只有季报 Skill，要求安全分析报告；读取季报说明也不得建任务；回复无适用 Skill；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightE01 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [B-02][E2E] 实际 /skill: 分发与模型预检：/skill:季报但缺 ID；先追问，零任务；/skill:提供完整输入按预检后提交，无额外确认；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB02 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] [S-09][E2E] 控制面 DTO→schema/transaction→renderer→真实 Worker工具可见性：更新指导规则与配套插件；校验/健康通过后生效；工具在业务 Agent 可见且 main 不可用；失败恢复 last-good；命令 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS09 tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs`；不在编码期执行RED/GREEN，统一留给verify-e2e。
- [x] 更新Acceptance Evidence；不得把未运行命令、无测试收集、环境缺失或模型随机失败写成通过。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| E-01 | E2E | 生产问题等价真实模型对话、read、队列、季报脚本哨兵 | 只有季报 Skill，要求安全分析报告；读取季报说明也不得建任务；回复无适用 Skill | tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs / PreflightE01（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightE01 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs | verified |
| B-02 | E2E | 实际 /skill: 分发与模型预检 | /skill:季报但缺 ID；先追问，零任务；/skill:提供完整输入按预检后提交，无额外确认 | tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs / PreflightB02（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightB02 tools/muad-runtime-guard/test/skill-preflight-boundaries.e2e.test.mjs | verified |
| S-09 | E2E | 控制面 DTO→schema/transaction→renderer→真实 Worker工具可见性 | 更新指导规则与配套插件；校验/健康通过后生效；工具在业务 Agent 可见且 main 不可用；失败恢复 last-good | tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs / PreflightS09（待新增） | env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS09 tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs | verified |

### Acceptance Evidence

E2E仅登记：E01实际模型read季度文档且零任务/业务；B02必须真实测试IM ingress argv（CLI agent不冒充before_dispatch），缺ID追问、补齐执行；S09真实Console PATCH用户prompt产生generation、apply-config→Worker工具目录与健康→实际故障注入→failed/last-good哈希恢复，finally恢复故障及用户prompt。编码期仅node --check和无opt-in模块加载；真实环境未运行，全部e2e_deferred。
- E-01: e2e_deferred — automated command e2e_deferred; run_id=97b00dfcd2d34ebd846854b90b90313a (confirmed_by: runner)
- B-02: e2e_deferred — automated command e2e_deferred; run_id=97b00dfcd2d34ebd846854b90b90313a (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=97b00dfcd2d34ebd846854b90b90313a (confirmed_by: runner)
- E-01: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- B-02: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- S-09: failed — automated command failed; run_id=b474337780bc4617bc43bcb1cd55609e (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- S-09: failed — automated command failed; run_id=fba4bab8be9645339a13ba71ccb961f1 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- S-09: failed — automated command failed; run_id=f60cba407c6c43b28fc7b461d1fe5401 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=271b1da50c134e14975c86245a259143 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-09: failed — automated command failed; run_id=02c3108bf77943c1b6e9c1868195883f (confirmed_by: runner)
- S-09: failed — automated command failed; run_id=acbb3fed8e8542cc8dab5eb7e93f86b6 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=c54d31d240e44324bfe54cf7e23431e8 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=c6f4cbcba6604721b42e67e407548e1e (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=86dba0af30c445f3960a046e70ed6e6e (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- E-01: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- B-02: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- E-01: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)
- S-09: verified — automated command passed; run_id=422d7d29ff26473f94ca427ca8e0e990 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；用户于2026-10-01确认写入正式计划)
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-014: 可信发送者与会话别名兼容

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-009
- **Source**: skill-execution-preflight.design.md#3.3 数据与上下文
- **Spec-Refs**:
- **Acceptance-Refs**: S-15
- **Owned Files**: tools/muad-runtime-guard/src/long-task-hooks.mjs, tools/muad-runtime-guard/src/long-task-preflight.mjs, tools/muad-runtime-guard/test/long-task-preflight.test.mjs

### Description

集成复核发现的已批准设计实现缺口，显式追加修复任务，不重开终态、不降级原E2E或扩大产品设计。真实发送者与session尾段不同时仅采用服务端事件投递目标；伪造字段/跨用户/跨会话拒绝；同run不同用户隔离。

### Checklist
- [x] 先落实PreflightS15功能失败测试并记录RED。
- [x] 实现当前设计约束：真实发送者与session尾段不同时仅采用服务端事件投递目标；伪造字段/跨用户/跨会话拒绝；同run不同用户隔离。
- [x] [S-15][integration] 真实turn hooks、读取ledger、preflight与临时授权文档；真实发送者与session尾段不同时仅采用服务端事件投递目标；伪造字段/跨用户/跨会话拒绝；同run不同用户隔离；命令 `node --test --test-name-pattern PreflightS15 tools/muad-runtime-guard/test/long-task-preflight.test.mjs`。
- [x] 更新证据并通过官方Done Gate；人工规范留终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-15 | integration | 真实turn hooks、读取ledger、preflight与临时授权文档 | 真实发送者与session尾段不同时仅采用服务端事件投递目标；伪造字段/跨用户/跨会话拒绝；同run不同用户隔离 | tools/muad-runtime-guard/test/long-task-preflight.test.mjs / PreflightS15 | node --test --test-name-pattern PreflightS15 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | verified |

### Acceptance Evidence

RED：S15真实sender与session别名误拒绝；同run不同agent缓存覆盖，两个断言失败。日志/tmp/muad-preflight-014-red.log。

GREEN：10例可信上下文/hooks/注册回归通过；投递只取服务端缓存verifiedPeerId，模型字段仍未知键拒绝；无已验证sender时原跨peer拒绝保持。session:别名规范化，turn key改agent/session/run，清理另一用户不受影响；读取与授权仍真实校验。
- S-15: verified — automated command passed; run_id=bb3ebdf4e5c545f7a435dc5f027cbffa (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=a68badae74f54a5983ee040dfa7970f3 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-15: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；编码集成复核发现原设计实现缺口，按cf-task-start终态修复要求显式追加)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-015: 后台长任务接入实际共享执行租约

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-014
- **Source**: skill-execution-preflight.design.md#3.5 质量实现与 Spec Compliance 落点
- **Spec-Refs**:
- **Acceptance-Refs**: S-16
- **Owned Files**: tools/muad-runtime-guard/src/index.mjs, tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs

### Description

集成复核发现的已批准设计实现缺口，显式追加修复任务，不重开终态、不降级原E2E或扩大产品设计。前台预检零lease；只有真实running后台任务取其可信Skill获取lease并在end释放；伪造后台不获取。

### Checklist
- [x] 先落实PreflightS16功能失败测试并记录RED。
- [x] 实现当前设计约束：前台预检零lease；只有真实running后台任务取其可信Skill获取lease并在end释放；伪造后台不获取。
- [x] [S-16][integration] 真实插件注册、manager任务索引与shared Skill lease；前台预检零lease；只有真实running后台任务取其可信Skill获取lease并在end释放；伪造后台不获取；命令 `node --test --test-name-pattern PreflightS16 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`。
- [x] 更新证据并通过官方Done Gate；人工规范留终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-16 | integration | 真实插件注册、manager任务索引与shared Skill lease | 前台预检零lease；只有真实running后台任务取其可信Skill获取lease并在end释放；伪造后台不获取 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs / PreflightS16 | node --test --test-name-pattern PreflightS16 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |

### Acceptance Evidence

RED：真实后台run消息不以/skill开头，现有lease hook未获取租约（actual=0 expected=1）。日志/tmp/muad-preflight-015-red.log。

GREEN：注册/健康8例通过；真实manager running索引关联Skill，后台从可信索引派生lease而非模型prompt，获取/释放实际共享目录租约；伪造任务session明确block且不获取；前台预检零槽仍保持。
- S-16: verified — automated command passed; run_id=ec218145a0d241b7b2415127919efea9 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=e9be5c6bf3f74ea3b21b1e6cc256608b (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-16: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；编码集成复核发现原设计实现缺口，按cf-task-start终态修复要求显式追加)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-016: 补齐取消候选规则与真实终验运行说明

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-015
- **Source**: skill-execution-preflight.design.md#3.2 架构与执行流程
- **Spec-Refs**:
- **Acceptance-Refs**: S-17
- **Owned Files**: bin/openclaw-config-renderer.mjs, bin/test/skill-preflight-guidance.test.mjs, tools/muad-runtime-guard/skill-preflight-e2e.md

### Description

集成复核发现的已批准设计实现缺口，显式追加修复任务，不重开终态、不降级原E2E或扩大产品设计。取消/改换目标/跨会话不得复用旧候选；显式opt-in E2E命令一致，实际IM斜杠与故障恢复准备明确。

### Checklist
- [x] 先落实PreflightS17功能失败测试并记录RED。
- [x] 实现当前设计约束：取消/改换目标/跨会话不得复用旧候选；显式opt-in E2E命令一致，实际IM斜杠与故障恢复准备明确。
- [x] [S-17][integration] 真实renderer指导输出与fixture配置文档；取消/改换目标/跨会话不得复用旧候选；显式opt-in E2E命令一致，实际IM斜杠与故障恢复准备明确；命令 `node --test --test-name-pattern PreflightS17 bin/test/skill-preflight-guidance.test.mjs`。
- [x] 更新证据并通过官方Done Gate；人工规范留终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-17 | integration | 真实renderer指导输出与fixture配置文档 | 取消/改换目标/跨会话不得复用旧候选；显式opt-in E2E命令一致，实际IM斜杠与故障恢复准备明确 | bin/test/skill-preflight-guidance.test.mjs / PreflightS17 | node --test --test-name-pattern PreflightS17 bin/test/skill-preflight-guidance.test.mjs | verified |

### Acceptance Evidence

RED：PreflightS17 缺取消候选、改换目标、“第2个”指导，断言失败；日志 /tmp/muad-preflight-016-red.log。第一次编辑脚本编码错误未落地，runner 再次失败记录保留。

GREEN：实际修改后 32 例 renderer/guidance/apply 回归通过，日志 /tmp/muad-preflight-016-green.log。固定指导明确取消清除候选、改换目标重新匹配、跨用户/跨会话隔离、“第2个”无有效列表澄清。文档补齐真实 IM ingress、humanUserId 推进 generation 和恢复原 prompt。E2E 命令显式 opt-in，未用文字断言替代真实模型 B01 终验。
- S-17: failed — automated command failed; run_id=e1db9c8491954496a1ec734d822440a7 (confirmed_by: runner)
- S-17: failed — automated command failed; run_id=4c885651e471404a9a58f1c438b61819 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=977ac0c51af841e3bd2ac1b5663ac37d (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=c018d4052baf4bce8f4bde164dfd6a1b (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-17: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；编码集成复核发现原设计实现缺口，按cf-task-start终态修复要求显式追加)
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-017: 会话别名中的提交幂等

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-016
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**:
- **Acceptance-Refs**: S-18
- **Owned Files**: tools/muad-runtime-guard/src/long-task-tool.mjs, tools/muad-runtime-guard/test/long-task-tool.test.mjs

### Description

集成复核发现的已批准设计实现缺口，显式追加修复任务，不重开终态、不降级原E2E或扩大产品设计。同peer池已有另一sourceSession时相同可信run重试仍只产生一个taskId和一次执行。

### Checklist
- [x] 先落实PreflightS18功能失败测试并记录RED。
- [x] 实现当前设计约束：同peer池已有另一sourceSession时相同可信run重试仍只产生一个taskId和一次执行。
- [x] [S-18][integration] 真实提交工具、manager与多session同peer队列；同peer池已有另一sourceSession时相同可信run重试仍只产生一个taskId和一次执行；命令 `node --test --test-name-pattern PreflightS18 tools/muad-runtime-guard/test/long-task-tool.test.mjs`。
- [x] 更新证据并通过官方Done Gate；人工规范留终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-18 | integration | 真实提交工具、manager与多session同peer队列 | 同peer池已有另一sourceSession时相同可信run重试仍只产生一个taskId和一次执行 | tools/muad-runtime-guard/test/long-task-tool.test.mjs / PreflightS18 | node --test --test-name-pattern PreflightS18 tools/muad-runtime-guard/test/long-task-tool.test.mjs | verified |

### Acceptance Evidence

Initial regression: PreflightS18 already passed before the lookup change; /tmp/muad-preflight-017-red.log records PASS, not RED. Manager updates its pool sourceSessionKey on submit, so the initial single-alias retry case was already covered. This is lookup hardening with an existing-behavior regression; no pre-implementation failure is claimed.

GREEN: all four submission integration tests passed. Lookup uses derived trusted agent/session/run taskId across existing agent pools, instead of pool sourceSessionKey; four alias retries return one ID and only one queued task. Input/auth/read rechecks remain before deduplication.
- S-18: verified — automated command passed; run_id=52f21502a02a432096b183aaf2309a76 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=21a97cd4ee4342e3a559e861de456068 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-18: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；编码集成复核发现原设计实现缺口，按cf-task-start终态修复要求显式追加)

---
- [2026-10-01] started
- [2026-10-01] completed (done)
## TASK-018: 真实模型终验配置集合复核

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-017
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**:
- **Acceptance-Refs**: S-19
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs

### Description

集成复核发现的已批准设计实现缺口，显式追加修复任务，不重开终态、不降级原E2E或扩大产品设计。只比较当前用户effective长任务集合，平台protected普通Skill保留；多余长任务拒绝，工具/model缺失明确失败。

### Checklist
- [x] 先落实PreflightS19功能失败测试并记录RED。
- [x] 实现当前设计约束：只比较当前用户effective长任务集合，平台protected普通Skill保留；多余长任务拒绝，工具/model缺失明确失败。
- [x] [S-19][integration] 真实renderer输出、终验配置校验和fixture文档；只比较当前用户effective长任务集合，平台protected普通Skill保留；多余长任务拒绝，工具/model缺失明确失败；命令 `node --test --test-name-pattern PreflightS19 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs`。
- [x] 更新证据并通过官方Done Gate；人工规范留终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-19 | integration | 真实renderer输出、终验配置校验和fixture文档 | 只比较当前用户effective长任务集合，平台protected普通Skill保留；多余长任务拒绝，工具/model缺失明确失败 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS19 | node --test --test-name-pattern PreflightS19 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence

RED: PreflightS19 configuration verifier was not exported, /tmp/muad-preflight-018-red.log.

GREEN: three fixture integration tests passed. Real Runtime DTO fixture and renderer feed the same verifier used by actual Worker E2E. Only effective long-task grants are compared; protected ordinary web-tools-guide remains installed. Extra/missing long-task sets, missing submit tool, and absent model fail explicitly. No model/deployment E2E executed.
- S-19: failed — automated command failed; run_id=dc268dc7521843cbb8e05898f6f70854 (confirmed_by: runner)
- S-19: failed — automated command failed; run_id=d960f071b1f346a98681da60e21a6886 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=367383e5388a4a6a9dbc25181d125b5e (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=6cfabacaa52541d89efe66f9661676eb (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-19: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created (draft；编码集成复核发现原设计实现缺口，按cf-task-start终态修复要求显式追加)
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-019: 修复上游工具注册与通道身份兼容

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-018
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**: RULE-runtime-directory-001（runtime-directory-structure，规则归属 TASK-009）, RULE-runtime-security-001（runtime-isolation-and-security，规则归属 TASK-003）, backend-platform-rules#RULE-backend-http-envelope-001
- **Acceptance-Refs**: S-20, S-21, S-22
- **Owned Files**: tools/muad-runtime-guard/openclaw.plugin.json, tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs, tools/muad-runtime-guard/src/long-task-preflight.mjs, tools/muad-runtime-guard/test/long-task-preflight.test.mjs, console/backend/internal/api/http_envelope_contract_test.go, .code-flow/specs/backend/platform-rules.md

### Description

真实Worker报plugin must declare contracts.tools，新提交工具无法注册。补齐外置插件manifest声明，沿用已批准的显式提交设计，不修改上游。

### Checklist
- [x] RULE-backend-http-envelope-001 verifier：沿用正式终验的真实验证及用户确认记录，规则和验收边界保持。
- [x] 记录真实Worker注册失败及manifest缺失的RED测试。
- [x] 补齐contracts.tools声明并验证插件契约。
- [x] [S-20][integration] 实际manifest包含muad_submit_long_task，工具注册名称一致；命令 `node --test --test-name-pattern PreflightS20 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`。
- [x] 记录GREEN并通过Done Gate。

- [x] [S-21][integration] 验证并修复Mattermost user:投递前缀与会话原始用户ID的等价比较；命令 `node --test --test-name-pattern PreflightS21 tools/muad-runtime-guard/test/long-task-preflight.test.mjs`。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-20 | integration | 实际插件manifest | 工具声明存在且与注册名一致 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs / PreflightS20 | node --test --test-name-pattern PreflightS20 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |

| S-21 | integration | 实际turn/read/preflight组件 | 同一Mattermost用户的投递前缀不导致拒绝，跨用户与其他通道拒绝保留 | tools/muad-runtime-guard/test/long-task-preflight.test.mjs / PreflightS21 | node --test --test-name-pattern PreflightS21 tools/muad-runtime-guard/test/long-task-preflight.test.mjs | verified |

| S-22 | integration | API实际Go源码AST及合法/违规对照fixture | 中央封装不误报，真实handler、别名、伪装helper拒绝 | console/backend/internal/api/http_envelope_contract_test.go / TestHTTPEncoder | go test ./internal/api -run TestHTTPEncoder -count=1 | verified |

### Acceptance Evidence

真实E2E工具目录缺少muad_submit_long_task，Worker日志显示plugin must declare contracts.tools；RED：PreflightS20退出1，contracts.tools为undefined；GREEN：补齐声明后PreflightS20与S11通过。证据保存在/tmp/muad-preflight-live-e2e-20261001/S20-{red,green}.log，runner记录S-20 verified。
- S-20: verified — automated command passed; run_id=f093dddc24cc493da575133eb30bd94d (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=422592ae0d9c41ee8442c7660fd83f2a (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=6a44330a5c984382ae12c989c87f9dcc (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=6a44330a5c984382ae12c989c87f9dcc (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=fc100e05cc6c4bdf8029c34ad34b3a55 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=fc100e05cc6c4bdf8029c34ad34b3a55 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=fc100e05cc6c4bdf8029c34ad34b3a55 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=97a4a7b34f9e49ae865dc1552882183a (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=97a4a7b34f9e49ae865dc1552882183a (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=97a4a7b34f9e49ae865dc1552882183a (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-20: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-21: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)
- S-22: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created；真实E2E发现注册契约遗漏，追加修复，不反转已完成任务。
- [2026-10-01] started
- [2026-10-01] resumed (in-progress)

- 真实工具可见后调用返回context_unavailable；本地真实hooks复现peerId=user:test-peer与session尾段test-peer不等价，修复仅通道地址规范化，不扩大身份信任。

- S-21 RED退出1（context_unavailable）；GREEN实际turn/read/preflight及注册回归通过；runner记录S-20/S-21 verified，日志/tmp/muad-preflight-live-e2e-20261001/S21-{red,green}.log。

- 门禁附属修复：HTTP envelope verifier改用真实Go AST函数级检查，保留禁止handler直接编码约束，仅放行既有两个中央封装；添加误报与真实违规对照回归，规范约束文字不变。

- S-22 RED为原官方verifier的regex_violation（中央封装被错误匹配）；新AST测试不改业务代码，合法/违规fixture均通过，未伪造Go测试先失败。
- [2026-10-01] completed (done)

---

## TASK-020: 更新Console生成的长任务提交说明

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-019
- **Source**: skill-execution-preflight.design.md#3.2 架构与执行流程
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-platform-rules#RULE-backend-platform-001
- **Acceptance-Refs**: S-23
- **Owned Files**: console/backend/internal/api/skill_bundle.go, console/backend/internal/api/skill_preflight_stub_test.go

### Description

真实Worker读取到Console上传时生成的旧_longtask_submit.md，仍禁止所有工具并要求未提交就确认后台执行。更新辅助说明对齐原设计的明确匹配/参数预检与专用工具提交；不改变上传契约、数据库和Skill源文档。

### Checklist
- [x] backend-platform-rules#RULE-backend-model-pool-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] RULE-backend-platform-001 verifier：沿用正式终验的真实验证及用户确认记录，规则和验收边界保持。
- [x] backend-logging#RULE-backend-redact-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] backend-logging#RULE-backend-logging-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] backend-directory-structure#RULE-backend-directory-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] backend-database#RULE-backend-no-select-star-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] backend-database#RULE-backend-database-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] backend-code-quality-performance#RULE-backend-write-err-001 verifier：已有用户人工确认或真实自动验证，需求终验20条规范全部通过；规则归属补齐，原verifier和真实边界不变。
- [x] RULE-backend-quality-001 verifier：沿用正式终验的真实验证及用户确认记录，规则和验收边界保持。
- [x] 为真实辅助文档生成编写失败测试并记录RED。
- [x] 更新说明：读真实SKILL.md，多候选等待、缺参追问、accepted后才回复实际taskId。
- [x] [S-23][integration] 保持0600落盘和普通Skill行为，旧虚假提交文案不出现；命令 `go test ./internal/api -run PreflightS23 -count=1`。
- [x] 记录GREEN与官方Done Gate。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-23 | integration | ensureLongTaskSubmitStub实际文件生成 | 新预检/提交文案、0600、普通Skill不生成辅助文件 | console/backend/internal/api/skill_preflight_stub_test.go / PreflightS23 | go test ./internal/api -run PreflightS23 -count=1 | verified |

### Acceptance Evidence

真实Worker读取旧辅助文档导致与平台新指导冲突；RED：PreflightS23退出1，缺少提交工具和参数字段且仍含虚假回执；GREEN：更新生成说明后API整包go test及go vet通过。日志/tmp/muad-preflight-live-e2e-20261001/S23-{red,green}.log，runner记录S-23 verified。
- S-23: verified — automated command passed; run_id=8a916c9804f4410fb8497415596d2483 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=7067cc5f73ed4c60b5942e003b89a30a (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-23: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created；真实终验发现遗漏，补齐原设计的Console产物，不反转已完成任务。
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-021: 支持两个真实Worker的独立终验用户

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-020
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-security-001（runtime-isolation-and-security，规则归属 TASK-003）
- **Acceptance-Refs**: S-24
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/skill-preflight-e2e.md

### Description

终验独立场景不能复用同一Agent工作区。两个现有Worker的可用容量足够，允许测试配置每个case覆盖workerExec argv，命令仍通过真实kubectl/Worker，不合并或伪造配置、队列与收件日志。

### Checklist
- [x] 为case Worker覆盖和非法argv编写RED测试。
- [x] 支持case级workerExec，缺省沿用环境全局配置；更新运行说明。
- [x] [S-24][integration] 不修改全局环境，实际场景实例保留正确Worker argv，非法类型拒绝；命令 `node --test --test-name-pattern PreflightS24 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs`。
- [x] 记录GREEN与官方Done Gate。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-24 | integration | RealWorkerScenario实际构造/环境配置 | case级argv覆盖、默认继承、环境不变、非法argv拒绝 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS24 | node --test --test-name-pattern PreflightS24 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence

首次现场发现同Agent跨case工作区不隔离；RED：S-24退出1，case覆盖未生效；GREEN：环境不可变、正确继承/覆盖及非法argv拒绝均通过；runner记录S-24 verified。日志/tmp/muad-preflight-live-e2e-20261001/S24-{red,green}.log。
- S-24: verified — automated command passed; run_id=ba09b5e55185484bb8539f24de53bf0c (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=04575370b6e3420d84ec396b66ccd687 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-24: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created；只补齐真实终验环境适配，不改变业务行为与原E2E期望。
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-022: 对齐上游工具发现与Hook注册的预检状态

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-021
- **Source**: skill-execution-preflight.design.md#3.4 工具与内部接口
- **Spec-Refs**: RULE-runtime-security-001（runtime-isolation-and-security，规则归属 TASK-003）, RULE-runtime-log-injection-001（runtime-skill-execution，规则归属 TASK-009）
- **Acceptance-Refs**: S-25
- **Owned Files**: tools/muad-runtime-guard/src/index.mjs, tools/muad-runtime-guard/src/long-task-hooks.mjs, tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs

### Description

真实上游工具发现会activate:false另注册插件，工具工厂与事件Hook的局部turn/ledger不共享，导致context_unavailable。复用同Worker globalThis上的有界预检ledger和turn Map，各注册实例仍按当前授权校验，同agent/session/run键隔离与结束清理不变。

### Checklist
- [x] 用两次实际插件注册复现读取Hook与工具工厂分属不同注册的RED。
- [x] 共享同进程预检状态，保留TTL、容量与键隔离，不把模型输入当身份。
- [x] [S-25][integration] 一实例读文档、另一实例提交成功；跨会话和结束后仍拒绝；命令 `node --test --test-name-pattern PreflightS25 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs`。
- [x] 回归并通过官方Done Gate。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-25 | integration | plugin.register实际多次注册及read/turn/submit链 | 跨注册共享，同Worker身份键仍隔离且生命周期清理 | tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs / PreflightS25 | node --test --test-name-pattern PreflightS25 tools/muad-runtime-guard/test/skill-preflight-registration.test.mjs | verified |

### Acceptance Evidence

上游resolvePluginTools的toolDiscovery/activate:false独立registry证据，真实已读且授权的提交仍context_unavailable；RED：两次实际插件注册后已读取文档仍rejected；GREEN：跨注册提交accepted、跨会话与结束后拒绝，Hook/授权回归通过；runner记录S-25 verified。日志/tmp/muad-preflight-live-e2e-20261001/S25-{red,green}.log。
- S-25: verified — automated command passed; run_id=5f99bfc531f04b7ba515be640f434adb (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=720b058f8e6f4f6da79de5b3c00c32d8 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=1b5bf437ce8d4cf6989840e2384cefba (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-25: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created；补齐原设计的上游适配，保持外置插件，不改上游。
- [2026-10-01] started
- [2026-10-01] completed (done)

---

## TASK-023: 按实际上游契约验证工具可用性

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-022
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-secret-file-mode-001（runtime-isolation-and-security，规则归属 TASK-004）
- **Acceptance-Refs**: S-26
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs

### Description

实际OpenClaw tools.catalog包含注册元数据和fallback entries，不表示Agent权限。S09仍保留实际目录注册检查，改用实际Gateway /tools/invoke空参数请求验证业务工具可用且不提交、main的404不可用；不以静态配置代替真实可用性。故障观测窗口覆盖实际2分钟health超时，不降低断言。

### Checklist
- [x] 验证实际Gateway主Agent404、业务Agent200/invalid_input；原catalog断言的失败证据保留。
- [x] 为Node配置读取与真实HTTP探测编写功能测试，E2E仍调用实际Worker Gateway。
- [x] [S-26][integration] 正确鉴权和空参数探测、不回显Token，明确返回实际HTTP状态和响应；命令 `node --test --test-name-pattern PreflightS26 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs`。
- [x] S09通过实际Gateway边界确认可用性，故障仍观察真实rollback；记录功能GREEN并Done Gate。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-26 | integration | Node实际私密配置读取与HTTP请求（外部Gateway响应使用隔离HTTP fixture） | 正确Bearer、空参数、实际状态/响应保留；真实Gateway仍由原S09验证 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS26 | node --test --test-name-pattern PreflightS26 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence

实际Worker主Agent tools.catalog含提交工具，但实际/tools/invoke主Agent404、业务200/invalid_input；原终验断言不符合上游契约。功能测试先因缺少实际探测函数失败（S26-red.log），实现后真实配置读取与HTTP传输测试通过；验收runner已保存GREEN证据。S09真实模型环境终验仍待后续执行。
- S-26: verified — automated command passed; run_id=752b7ce75c7741aba0b0e1f1981f95a0 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=9e396b00617449fc8c93318204e6ed87 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-26: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log

- [2026-10-01] created；按终验说明适配实际上游契约，原S09真实工具/健康/回滚边界保留。
- [2026-10-01] started
- [2026-10-01] completed (done)

## TASK-024: 修正真实终验文档与Console响应接线

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-023
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-skill-layering-001（runtime-skill-execution，规则归属 TASK-006）, RULE-runtime-secret-file-mode-001（runtime-isolation-and-security，规则归属 TASK-004）
- **Acceptance-Refs**: S-27
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/test/skill-preflight-deployment.e2e.test.mjs

### Description
真实S08文档末尾误写所有Skill均授权lookup，与缺ID禁止查询的说明矛盾，模型依据该误写查询并执行。修正测试文档仅lookup-report允许查询，保留零任务/零查询及补参后执行断言；隔离测试环境移除非lookup Agent误装的查询脚本。S09按实际HTTP接口data.humanUser解包，仍校验故障只影响隔离测试Agent。

### Checklist
- [x] 真实文档只给lookup-report明确查询授权，其余文档不矛盾。
- [x] 实际Console用户响应正确解包且继续校验Agent身份。
- [x] [S-27][integration] 先RED后GREEN，真实文档与响应对象边界不绕过。
- [x] 原S08/S09真实模型/查询/回滚场景继续终验，功能验证后Done Gate。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-27 | integration | 真实Skill文档生成；Console响应对象作为外部fixture，身份校验为真实函数 | 仅lookup文档授权名称查询；实际humanUser包裹正确解析，缺失与跨Agent拒绝 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS27 | node --test --test-name-pattern PreflightS27 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence
第一轮真实终验8/10通过。S08模型依据误写的查询授权调用lookup；S09实际data.humanUser被错误当作data读取。历史失败保留于e2e-final-runner.json和manifest运行记录。新增S27先RED（矛盾查询授权与缺少响应解包函数）后GREEN，runner已保存功能验证；原S08/S09仍待重新终验。
- S-27: verified — automated command passed; run_id=168755e1a006486e829b373842ed169b (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=a837322bffa846bfb84ba55811fb04c8 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=bc2ffdabf321484486fa6cfbbc4c5b06 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-27: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log
- [2026-10-01] created：不改变产品方案或真实终验断言，修正测试环境接线。
- [2026-10-01] started
- [2026-10-01] completed (done)

## TASK-025: 接受真实追问回复的等价表达

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-024
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-skill-layering-001（runtime-skill-execution，规则归属 TASK-006）
- **Acceptance-Refs**: S-28
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/test/skill-preflight-inputs.e2e.test.mjs, tools/muad-runtime-guard/test/skill-preflight-turns.e2e.test.mjs

### Description
实际S05回复两个候选并要求回复选项序号，B01跨用户回复哪一个并说明没有指向，原关键词断言误判。仅补足同义追问表达，保留所有真实候选、零任务/零业务/投递与后续选中执行断言。不修改产品行为或模拟模型。

### Checklist
- [x] 从原真实失败保留RED，新增真实回复样本与非追问拒绝测试。
- [x] S05/B01接受选项序号和哪一个等表达，其他实际边界与断言不变。
- [x] [S-28][integration] 追问检查函数真实执行，成功执行陈述不得算追问。
- [x] runner记录GREEN并Done Gate，真实模型仍走需求终验。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-28 | integration | 真实回复检查函数与原实际模型回复样本 | 两类真实追问接受，已执行无追问陈述拒绝；实际模型队列边界仍由S05/B01执行 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS28 | node --test --test-name-pattern PreflightS28 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence
verify-e2e-final.json保存原S05/B01实际模型回复误判；S09因故障命令无法暂停容器PID1被明确中止，不记通过。改用实际Docker宿主故障信号，已观测Gateway进程Tsl、真实health请求超时、CONT恢复。
- S-28: verified — automated command passed; run_id=98dfb2a577584aeba520ba3f3e302b13 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=cc5954afae574d8da7b9b9ef7f1e8a17 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=9b361c7f25ce413e81d0e240fd39c9fb (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-28: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log
- [2026-10-01] created：补足等价自然语言表达，不改变关键真实边界。
- [2026-10-01] started

- S28: 新增检查函数前RED（函数未实现），实现后GREEN；runner记录通过，原实际模型历史保留。
- [2026-10-01] completed (done)

## TASK-026: 唯一候选选择终验复用统一追问检查

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-025
- **Source**: skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-skill-layering-001（runtime-skill-execution，规则归属 TASK-006）
- **Acceptance-Refs**: S-29
- **Owned Files**: tools/muad-runtime-guard/test/skill-preflight-e2e-support.mjs, tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs, tools/muad-runtime-guard/test/skill-preflight-matching.e2e.test.mjs

### Description
真实终验9/10通过，包含实际健康故障、last-good回滚及恢复。S03实际列出两个候选并要求先选一个、回复选1/2，旧独立关键词断言误判。改用统一候选追问检查并支持此等价表达；保留实际候选及差异、首轮零任务/零业务/零投递和选择后只执行指定Skill断言。

### Checklist
- [x] [S-29][integration] 原实际回复误判证据与新追问样本测试RED，纯执行回执不得通过。
- [x] S03复用统一检查，真实边界与后续选中执行断言保持。
- [x] runner保存GREEN并Done Gate，需求终验由正式命令更新状态。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-29 | integration | 实际回复检查函数；真实模型回复样本 | 先选一个、回复选1/2合法追问接受；纯执行回执拒绝；S03真实模型入口仍保留 | tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs / PreflightS29 | node --test --test-name-pattern PreflightS29 tools/muad-runtime-guard/test/skill-preflight-e2e-fixtures.test.mjs | verified |

### Acceptance Evidence
verify-e2e-complete.json：9/10真实E2E通过，S03仅回复措辞误判；原失败记录和实际健康回滚通过证据保留。
- S-29: verified — automated command passed; run_id=962cfd68ea914684b45ec30eb3f6ddfc (confirmed_by: runner)
- S-29: verified — automated command passed; run_id=52316cc282b3412b87ae3c192cc90855 (confirmed_by: runner)
- S-29: verified — automated command passed; run_id=bb99e14e4e8547f0a362d6f82141fd98 (confirmed_by: runner)
- S-29: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-29: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-29: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log
- [2026-10-01] created：统一候选追问表达，产品行为不变。
- [2026-10-01] started

- S29: 真实样本先因先选一个不匹配而RED（S29-red.log）；实现后runner实际执行GREEN。
- [2026-10-01] completed (done)

## TASK-027: 后台直接使用已解析参数避免重复查询

- **Status**: verified
- **Priority**: P0
- **Depends**: TASK-026
- **Source**: skill-execution-preflight.design.md#3.3 数据与上下文, skill-execution-preflight.design.md#2.5 验收条件
- **Spec-Refs**: RULE-runtime-skill-001（runtime-skill-execution，规则归属 TASK-008）
- **Acceptance-Refs**: S-30
- **Owned Files**: tools/muad-runtime-guard/src/long-task-manager.mjs, tools/muad-runtime-guard/test/long-task-manager.test.mjs

### Description
正式真实E2E的S05发现前台已解析customerId后，后台再次执行同一个名称查询。细化既定FEAT08确定输入指导：绑定是权威执行输入，原始请求是历史背景，已绑定参数不得再执行转换查询，直接使用文档的业务调用。不新增Skill参数模型或语义解析器。保留S05实际查询一次与业务一次的断言。

### Checklist
- [x] [S-30][integration] 使用真实manager提交、持久记录与后台消息构造验证权威绑定和不重复查询指导，记录RED。
- [x] 补强后台固定指导，保留最终目标、原始请求和缺参停止行为。
- [x] GREEN及Done Gate通过后构建新本地候选镜像，正式终验验证S05真实查询一次。

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|---|---|---|---|---|---|---|
| S-30 | integration | 真实manager提交、持久记录、后台消息构造 | document_resolution参数保留，绑定优先于原始缺参请求，不重复解析，文档业务直接执行 | tools/muad-runtime-guard/test/long-task-manager.test.mjs / PreflightS30 | node --test --test-name-pattern PreflightS30 tools/muad-runtime-guard/test/long-task-manager.test.mjs | verified |

### Acceptance Evidence
S30 RED：真实manager构造消息缺少权威绑定指导，断言失败，记录S30-red.log。
真实失败：verify-e2e-final-pass.json中S05查询2次而预期1次；前台01:29:42、后台01:29:53执行同一个lookup.mjs。此修复的模型真实行为仍由既有S05终验，不以消息断言代替真实模型验证。
- S-30: verified — automated command passed; run_id=4258bc5117af4895af45190a42e3dcd1 (confirmed_by: runner)
- S-30: verified — automated command passed; run_id=51d2e96af6354be2a9b0d23128797322 (confirmed_by: runner)
- S-30: verified — automated command passed; run_id=e28b2f83b367499f855dd95ab2e01826 (confirmed_by: runner)
- S-30: verified — automated command passed; run_id=c39a99ad51b14398a661c9c6b7e772b5 (confirmed_by: runner)

### Log
- [2026-10-02] created：修复既定确定输入行为，不变更设计边界。
- [2026-10-02] started
- [2026-10-02] completed (done)

## 归档校验记录

2026-10-02：归档前完整代码检查通过。补齐后端规则计划追溯，重复规则保留复用说明并指定唯一责任TASK；规范契约状态据正式终验20条验证更新。产品代码、测试层级、验收条件与历史证据不变。

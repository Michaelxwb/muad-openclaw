# Tasks: OpenClaw 运行时升级（2026.9.8 冻结版，无回退 fail-forward）

- **Source**: `.code-flow/tasks/2026-10-06/openclaw-runtime-upgrade/openclaw-runtime-upgrade.design.md`
- **Created**: 2026-10-07
- **Updated**: 2026-10-07

## Proposal

把控制面与 Worker 镜像升级到冻结的 OpenClaw `2026.9.8`（含最新通道插件），在真实 pod01/pod02 状态副本上完成"无人工脚本、绑定/机器人/路由不变"的一次性无感升级。前置验证 G-01～G-08 已通过（状态自动迁移、双 Pod 路由 3/3 与 1/1、自有插件在 9.8 加载、构建链通过、租约语义安全）；本计划落地设计 §3.1.4 的 7 项适配清单与 G-09 的 Console fail-forward 编排改造，并补齐全部自动化回归。升级失败一律停在 error 人工修复（fail-forward），不设计回退。

### Alignment

- **Scope**: 镜像构建 pin（OpenClaw/插件/自检/CI/Docker 版）、renderer 与通道配置形态、entrypoint 承接 Doctor、插件 registry/prune 处置、重启协议与模型变更强制重启、路由验证全量与分批、Console 升级编排 fail-forward（去自动回滚、超时、维护门禁、操作记录）、隔离/技能/权限回归、验收材料与人工边界。
- **Decisions**:
  - 目标冻结最新稳定版（当前 2026.9.8），不设同线备选；
  - 无回退（fail-forward）：失败停 error，通过既有 error 态改镜像/restart 出口人工修复；升级路径不使用 50205/50215 回滚语义；
  - 模型修改必须触发 Gateway 重启（实测确认），信号由 pod 侧按自身版本协商（7.1=USR1，9.6+=USR2）；
  - 历史/会话迁移由目标版 Doctor 在启动链路自动完成，零人工迁移脚本；
  - 状态离线副本与 Doctor 原生备份仅用于前置验证与故障取证。
- **Non-goals**: 回退接口/恢复点编排、跨 SQLite 降级、上游 fork、微信业务启用、前端改版、真实机器人演练。
- **Acceptance**: 设计 §2.5 全部 28 个场景 + §4.0 门禁 G-01～G-09；S-08/B-04 为切换后人工验收。

---

## Acceptance Coverage

| 场景ID | 来源设计 | 测试层级 | 关键真实边界 | 负责任务 | 状态 | 执行命令 |
|--------|---------|---------|-------------|---------|------|---------|
| S-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 管理 HTTP → 临时 SQLite → 真实 builder/renderer | TASK-006 | planned | - |
| S-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实 Guard verifier + 路由解析契约 | TASK-005 | planned | ["node","--test","tools/muad-runtime-guard/test/route-verifier.test.mjs"] |
| S-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 创建用户 API → 真 Store → DTO/渲染 → 重启选择 | TASK-004 | planned | - |
| S-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 模型修改 API → Store → DTO → 目标重启协议 | TASK-004 | planned | - |
| S-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | UpgradeService 状态机 + Driver 事件序列 | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |
| S-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实临时文件树/SQLite + 自动迁移/新会话路径 | TASK-003 | planned | ["node","--test","bin/test/upgrade-doctor-chain.test.mjs"] |
| S-07 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实 Guard/policy/session-manager 模块 | TASK-007 | planned | ["node","--test","tools/muad-runtime-guard/test/multi-user-isolation.test.mjs"] |
| S-08 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | manual | 生产 native resolver、双 IM 原账号、真实模型响应 | TASK-008 | planned | - |
| S-09 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | HTTP 写入口 → Store → 维护状态 → reconcile 调度 | TASK-006 | planned | - |
| S-10 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 版本清单、自检逻辑、实际模块/配置文件 | TASK-001 | verified | ["node","--test","bin/test/runtime-image-self-check.test.mjs"] |
| S-11 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 任务/租约调度与真实临时任务记录 | TASK-006 | planned | ["node","--test","tools/muad-runtime-guard/test/long-task-drain.test.mjs"] |
| S-12 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 文档/测试清单/版本报告 | TASK-008 | planned | ["node","--test","bin/test/upgrade-report.test.mjs"] |
| E-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 临时 SQLite → 保护字段比较 → API 错误输出 | TASK-006 | planned | - |
| E-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 排空状态机与租约记录 | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |
| E-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 生效确认解析与计时器 | TASK-004 | planned | ["go","test","./internal/runtimeapply/..."] |
| E-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 取证材料校验 + fake 存储/Driver | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |
| E-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实临时状态树与自动迁移失败路径 | TASK-003 | planned | ["node","--test","bin/test/upgrade-doctor-chain.test.mjs"] |
| E-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实响应解析与严格验证器 | TASK-007 | planned | ["go","test","./internal/gateway/..."] |
| E-07 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 编排失败路径 + 原配置/状态引用 | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |
| E-08 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 失败终态/错误封装 | TASK-006 | planned | ["go","test","./internal/api/..."] |
| E-09 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实脱敏函数、日志回调与错误 envelope | TASK-006 | planned | ["go","test","./internal/api/..."] |
| E-10 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实操作记录原子写/加载 + fake 外部边界 | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |
| B-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | builder/Guard 校验 | TASK-005 | planned | ["node","--test","tools/muad-runtime-guard/test/route-verifier.test.mjs"] |
| B-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 路由规范化与 identityLinks | TASK-005 | planned | ["go","test","./internal/runtimeconfig/..."] |
| B-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 锁与阶段事件序列 | TASK-006 | planned | ["go","test","./internal/runtimeapply/..."] |
| B-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | manual | 正式验收记录 | TASK-008 | planned | - |
| B-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真分批/聚合器与 fake RPC | TASK-005 | planned | ["go","test","./internal/gateway/..."] |
| B-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 版本能力选择、配置/自检 | TASK-004 | planned | ["node","--test","bin/test/runtime-config-transaction.test.mjs"] |
| G-01～G-05、G-07～G-08 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | manual | pod01/pod02 状态副本、租约实测（已完成，记录保留） | TASK-008 | verified | - |
| G-06 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | integration | Docker 构建链、镜像内 CLI 自检 | TASK-001 | verified | ["docker","build","-f","Dockerfile.base","-t","muad-openclaw-base:98pin-test","."] |
| G-09 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | integration | Console 去自动回滚/超时/维护门禁 | TASK-006 | planned | ["go","test","./internal/runtimeupgrade/..."] |

> 全部 P0/P1 场景均有且仅有一个最终负责人；`manual` 场景为设计 §2.5/E2E 明确的外部边界（S-08/B-04 需真实 IM 账号，G-01～G-08 为已完成的离线预验证记录），已经用户确认。

---

## TASK-001: 版本冻结与镜像构建链升级

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `openclaw-runtime-upgrade.design.md#3.1.2 兼容清单`, `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`
- **Spec-Refs**: runtime-directory-structure#RULE-runtime-directory-001
- **Acceptance-Refs**: S-10, G-06

### Description

把全部版本 pin 冻结到 OpenClaw 2026.9.8 与最新通道插件（wecom 2026.9.15、mattermost 2026.9.8、wechat 2.4.9），覆盖基础镜像、Docker 版基础镜像、CI 默认值与镜像自检常量及其测试断言；在候选镜像上验证构建期 `--image-only` 自检与插件/离线依赖检查通过。

### Checklist

- [x] 更新 `Dockerfile.base`：`OPENCLAW_VERSION=2026.9.8`、`WECOM_PLUGIN_VERSION=2026.9.15`、`MATTERMOST_PLUGIN_VERSION=2026.9.8`、`WECHAT_PLUGIN_VERSION=2.4.9`
- [x] 更新 `.github/workflows/build-image.yml` 默认值、`build/docker-build/Dockerfile.openclaw` 的 `BASE_TAG`
- [x] 更新 `bin/runtime-image-self-check.mjs` 的 `PINNED_OPENCLAW_VERSION` 与 `bin/test/runtime-image-self-check.test.mjs` 断言
- [x] [S-10][integration] 断言版本清单一致、自检逻辑对 9.8 通过（真实边界：镜像内实际 CLI `openclaw --version` 与配置/插件检查）
- [x] G-06 verifier[integration]：构建候选镜像（base+app），构建期自检输出 `openclaw=2026.9.8 status=ok`；真实边界：Docker 构建链 + 镜像内自检
- [x] RULE-runtime-directory-001 verifier：确认版本资产仍只落在 Dockerfile/bin/tools/skills，不 vendor/fork 上游
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-10 | integration | 镜像内自检、实际模块/配置文件 | 版本一致、自检通过、无未启用插件阻断 | `bin/test/runtime-image-self-check.test.mjs`、`bin/test/runtime-image-recipe.test.mjs` | `node --test bin/test/runtime-image-self-check.test.mjs` | verified |
| G-06 | integration | Docker 构建链、镜像内 CLI | 构建成功且 `openclaw=2026.9.8 status=ok` | 构建日志（base+app） | `docker build -f Dockerfile.base -t muad-openclaw-base:98pin-test .` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-10 | FAIL: `OpenClaw image version is pinned exactly` 期望 2026.9.8 实际 2026.7.1；recipe 断言 Dockerfile.base/workflow 仍锁旧版 | `node --test bin/test/*.test.mjs` → 115 pass / 0 fail；self-check 9/9 | `bin/test/runtime-image-self-check.test.mjs:66-70`；`bin/test/runtime-image-recipe.test.mjs:15,151-153` | 镜像内 `openclaw --version`=2026.9.8；base label `io.muad.openclaw.version=2026.9.8`；app base name `ghcr.io/openclaw/openclaw:2026.9.8`；插件 wecom 2026.9.15 / mattermost 2026.9.8 / weixin 2.4.9 | verified |
| G-06 | 未改前默认构建产物为 2026.7.1（与冻结目标不符） | `docker build -f Dockerfile.base …98pin-test` 成功（manifest 与 98latest 一致）；`docker build -f Dockerfile …98pin-test` 输出 `[muad-self-check] openclaw=2026.9.8 status=ok` | Dockerfile.base:4,24-28；Dockerfile:87（`--image-only`） | 构建日志 + 镜像 label/插件版本检查 | verified |
- S-10: verified — automated command passed; run_id=cde1be36bf274c0c8fda4d30ff29cf29 (confirmed_by: runner)

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started；pin 变更 TDD：先更新断言取 RED（self-check + recipe 共 3 处失败），后改 5 处 pin → bin 全量 115/115 GREEN
- [2026-10-07] G-06 验证：默认参数构建 base+app 成功，构建期自检 `openclaw=2026.9.8 status=ok`
- [2026-10-07] started
- [2026-10-07] completed (done)

---

## TASK-002: Renderer 与通道配置形态适配（9.8 validate 通过）

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`, `openclaw-runtime-upgrade.design.md#3.5.2 重启与配置生效`
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: S-04, S-10, B-06

### Description

修复 9.8 实测拒绝的三个配置形态：删除 `browser.profiles.*.color` 与 `plugins.bundledDiscovery`；mattermost `streaming` 从字符串改为 `{ mode: "off" }`；将 `agents` 输出迁移为 `agents.entries`（保留 `ownership`）并保留/生成 Doctor 迁移产生的 `main` 通道级 fallback 绑定（多 Agent 无匹配 binding 时 9.8 fail-closed，且避免每次迁移后 apply 触发重启）。保证候选配置在 9.8 `openclaw config validate` 通过。

### Checklist

- [ ] `bin/openclaw-config-renderer.mjs`：删除 `browser.profiles.*.color` 与 `plugins.bundledDiscovery`
- [ ] `bin/channel-config.mjs`：`streaming = { mode: "off" }`（对象）
- [ ] renderer `agents` 输出改为 `agents.entries`（keyed）并保留 `agents.ownership`；不再写 `agents.list`
- [ ] renderer/handoff 保留或生成每个启用通道的 `main` fallback 绑定（`match.accountId="*"`）
- [ ] [S-04][E2E] 模型/agents 渲染变化在候选配置上 validate 通过并选择正确重启协议（真实边界：renderer → 9.8 CLI validate → restartMode）
- [ ] [B-06][integration] 旧/新版本能力选择与配置/自检（真实边界：版本表、候选配置、自检）
- [ ] [S-10][integration] 候选配置 validate 通过且无 unrecognized key（真实边界：9.8 `openclaw config validate`）
- [ ] RULE-runtime-config-001 verifier：候选配置经 schema 校验与事务管线（prepare/validate/commit）且验证回滚/健康语义不被破坏
- [ ] RULE-runtime-validate-before-write-001 verifier：materialize 前调用 validateRuntimeConfig、0600 原子写、generation 单调
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | E2E | renderer、9.8 CLI validate、重启选择 | 配置 valid、restartMode 正确 | planned | planned | planned |
| B-06 | integration | 版本能力表、配置/自检 | 旧新版本各自协议正确 | planned | `node --test bin/test/runtime-config-transaction.test.mjs` | planned |
| S-10 | integration | 9.8 config validate | 无 unrecognized key | planned | `node --test bin/test/runtime-image-self-check.test.mjs` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-003: Entrypoint 承接 Doctor 与插件 registry 处置

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `openclaw-runtime-upgrade.design.md#3.1.3 当前必须处理的兼容差异`, `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`, `openclaw-runtime-upgrade.design.md#4.2.1 正式升级顺序`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-06, E-05, G-01, G-04

### Description

在自有 entrypoint 的 Gateway 启动前显式执行 `openclaw doctor --fix --non-interactive`（fail-closed），承接状态自动迁移；对 9.8 已移除的 `installed_plugin_index` 兼容旧 prune（7.1 状态）并避免 9.8 静默失配，遵循 Doctor 自动刷新 registry 的新机制；保证写入文件的权限仍符合 0600/0400 约束。

### Checklist

- [ ] `entrypoint.sh` 在启动 Gateway 前执行 `openclaw doctor --fix --non-interactive`，失败退出（非零）
- [ ] prune/registry：核对 7.1 状态与 9.8 状态两条路径；9.8 下以 Doctor registry 刷新为准，确保不再依赖 `installed_plugin_index`
- [ ] [S-06][integration] 历史自动兼容/自动新会话、全程无人工迁移脚本（真实边界：真实临时文件树/SQLite + Doctor 链路）
- [ ] [E-05][integration] 自动迁移失败停 error 且不把“手工脚本”当出口（真实边界：临时状态树与失败路径）
- [ ] RULE-runtime-secret-file-mode-001 verifier：检查 entrypoint/迁移产物权限（config/bundle 0600，Pod token 0400 规范路径）
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-06 | integration | 真实状态树/SQLite、Doctor | 自动迁移成功、零人工脚本 | planned | `node --test bin/test/upgrade-doctor-chain.test.mjs` | planned |
| E-05 | integration | 自动迁移失败路径 | fail-closed、停 error | planned | `node --test bin/test/upgrade-doctor-chain.test.mjs` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-004: 重启协议与模型变更强制重启

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `openclaw-runtime-upgrade.design.md#3.5.2 重启与配置生效`, `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`
- **Spec-Refs**:
- **Acceptance-Refs**: S-03, S-04, E-03, B-06

### Description

保持"模型修改触发 Gateway 重启"的产品行为：在 `bin/runtime-config-transaction.mjs` 的 `selectRestartMode` 中把 providers/agents 模型变化纳入 `gateway`；重启信号按 pod 自身版本协商（7.1=USR1，9.6+=USR2），由 prepare 结果携带提示，`runtimeapply` 使用该提示而非硬编码 USR1；处置 `inject-channels.mjs`（无调用方的 SIGUSR1 死代码）。

### Checklist

- [ ] `selectRestartMode` 增加模型/Provider 变化检测（providers 与 agents 模型段），命中即 `gateway`
- [ ] prepare 结果附带 `gatewaySignal`（按 pod 内 OpenClaw 版本：9.6+→USR2，旧版→USR1），`runtimeapply/apply.go` 使用该提示发送对应信号
- [ ] `inject-channels.mjs`：按版本适配或移除（当前无 Go 调用方），避免 9.6+ 误发 USR1
- [ ] [S-04][E2E] 模型修改后 apply 选择 Gateway 重启并按版本协议发送信号（真实边界：模型修改 API → Store → DTO → 重启协议）
- [ ] [S-03][E2E] 新增用户/Agent 热重启路径不重建 Pod（真实边界：创建用户 API → 真 Store → DTO/渲染 → 重启选择）
- [ ] [E-03][integration] 信号发送成功但 generation/配置未收敛时到期失败（真实边界：生效确认解析与计时器）
- [ ] [B-06][integration] 旧/新版本选择正确重启协议（真实边界：版本能力选择、事务 prepare）
- [ ] RULE-backend-quality-001 的触达包 verifier 由 TASK-006 承担；本任务保证 runtimeapply/transaction 改动错误显式处理、有界 context
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | E2E | 模型 API、Store、DTO、重启协议 | 模型变化→gateway；9.8 用 USR2 | planned | planned | planned |
| S-03 | E2E | 创建用户 API、Store、渲染 | 热重启、不重建 Pod | planned | planned | planned |
| E-03 | integration | probe 解析、计时器 | 未收敛到期失败 | planned | `cd console/backend && go test ./internal/runtimeapply/...` | planned |
| B-06 | integration | 版本能力、事务 prepare | 协议选择正确 | planned | `node --test bin/test/runtime-config-transaction.test.mjs` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-005: 路由验证全量与分批

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `openclaw-runtime-upgrade.design.md#3.5.4 全量技术验收`, `openclaw-runtime-upgrade.design.md#2.5 验收条件`
- **Spec-Refs**:
- **Acceptance-Refs**: S-02, B-01, B-02, B-05

### Description

把运行时路由核对改为"全量 + 有界分批"：`gateway/probe.go` 单次 RPC 拆为 ≤1000 路由的有界批次并聚合（同 generation、checked 求和、RPC 错仍为 Unknown）；`apply.go` 期望集过滤不得静默丢弃非 direct/dm 身份（扩展 verifier 或 fail-closed 并列入报告）；verifier 的 `sessionMatchesAgent` 与 `parseSessionKey` 与新口径一致（dm→direct、支持 group/channel 判定）。

### Checklist

- [ ] `gateway/probe.go` 实现 ≤1000 分批聚合（同 generation、checked/failed 求和、RPC 错→Unknown）
- [ ] `runtimeapply/apply.go` 期望集口径：全量 active 路由；非 direct/dm 不得静默过滤（fail-closed 或扩展 verifier）
- [ ] `route-verifier.mjs`/`binding-context.mjs`：dm 路由标记识别与 peerKind 对应校验
- [ ] [S-02][integration] 双用户/双通道/不同 accountId 全量严格聚合（真实边界：真实 Guard verifier + 路由解析契约）
- [ ] [B-05][integration] 1000/1001 条合成路由分批聚合、checked 精确合计（真实边界：真分批/聚合器与 fake RPC）
- [ ] [B-01][integration] 0 有效路由、禁用身份、未知 sender 不进入业务 Agent（真实边界：builder/Guard 校验）
- [ ] [B-02][integration] default account、双账号、同用户双通道语义保持（真实边界：路由规范化与 identityLinks）
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02 | integration | Guard verifier、路由解析 | 全部命中原 Agent、无 default 兜底 | planned | `node --test tools/muad-runtime-guard/test/route-verifier.test.mjs` | planned |
| B-05 | integration | 分批/聚合器、RPC | 1000/1001 完整分批、checked 合计 | planned | `cd console/backend && go test ./internal/gateway/...` | planned |
| B-01 | integration | builder/Guard | 0 路由不虚报、禁用不放行 | planned | `node --test tools/muad-runtime-guard/test/route-verifier.test.mjs` | planned |
| B-02 | integration | routes/identityLinks | 账号与通道语义保持 | planned | `cd console/backend && go test ./internal/runtimeconfig/...` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-006: Console 升级编排 fail-forward（G-09）

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-005
- **Source**: `openclaw-runtime-upgrade.design.md#3.4 接口设计`, `openclaw-runtime-upgrade.design.md#2.4 范围与边界`, `openclaw-runtime-upgrade.design.md#4.2 原位升级流程`, `openclaw-runtime-upgrade.design.md#4.5 中断处理与运维观察`
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-code-quality-performance#RULE-backend-write-err-001, backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001, backend-directory-structure#RULE-backend-directory-001, backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001, backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-http-envelope-001, backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: S-01, S-05, S-09, S-11, E-01, E-02, E-04, E-07, E-08, E-09, E-10, B-03, G-09

### Description

按无回退决策改造 Console 升级编排：新增 `internal/runtimeupgrade` 模块承载阶段、维护门禁、操作记录与 fail-forward 流程；`/upgrade` 与镜像 PATCH 共用编排；跨迁移失败不再自动回滚旧镜像/旧状态（停 error，走既有 error 态改镜像/restart 出口）；总操作与健康超时按首次迁移调整并支持镜像预热；维护门禁覆盖已核对的未持锁写入口；失败使用新的稳定错误码（不使用 50205/50215）；操作记录原子写入 Console 持久目录并支持中断恢复。

### Checklist

- [ ] 新增 `internal/runtimeupgrade`：阶段状态机（PREPARED→STARTING_TARGET→VERIFYING→COMPLETED/FAILED）、持久操作记录、启动扫描
- [ ] `pod_upgrade.go`：移除跨迁移自动回滚（失败停 error + 新稳定错误码）；保留 error 态改镜像/restart 出口
- [ ] 超时调整：总操作/健康窗口按首次迁移实测与镜像预热配置化
- [ ] 维护门禁覆盖写入口矩阵（用户/身份/绑定码/模型/通道/技能/资源/token/镜像 PATCH/apply-config/channels PUT）
- [ ] [S-01][E2E] 合成双用户绑定升级编排前后保护字段逐条一致（真实边界：管理 HTTP → 临时 SQLite → 真实 builder/renderer）
- [ ] [S-05][integration] 先排空/停旧、取证材料就绪、再启动新版且无双 Gateway（真实边界：状态机 + Driver 事件序列）
- [ ] [S-09][E2E] 维护期间写入口被拒绝/有界等待、解除后恢复（真实边界：HTTP 写入口 → Store → 维护状态 → reconcile）
- [ ] [S-11][integration] 维护期间停止新调度、排空已有任务、恢复不重放未知副作用（真实边界：任务/租约调度 + 临时任务记录）
- [ ] [E-01][E2E] 同数量但字段被替换 → 失败不报绑定完整（真实边界：临时 SQLite → 保护字段比较 → API 错误）
- [ ] [E-02][integration] 任务无法安全结束 → 切换前中止、不自动重放（真实边界：排空状态机与租约记录）
- [ ] [E-04][integration] 取证材料缺损/空间不足 → 未改写时安全拒绝（真实边界：材料校验 + fake Driver）
- [ ] [E-07][integration] 新版启动/迁移失败 → 停 error，不恢复旧镜像/旧状态（真实边界：编排失败路径）
- [ ] [E-08][integration] 失败终态返回稳定升级失败码（非 50205/50215）（真实边界：错误封装）
- [ ] [E-09][integration] 注入 Token/Cookie 的错误输出/审计无明文（真实边界：脱敏函数 + 日志回调 + envelope）
- [ ] [E-10][integration] Console 各阶段中断后按 fail-forward 收敛或停 error（真实边界：操作记录原子写/加载）
- [ ] [B-03][integration] 并发升级/持锁后重读基线、串行且无第二个 Gateway（真实边界：锁与阶段事件序列）
- [ ] G-09 verifier[integration]：Console 编排无自动回滚、超时/维护门禁生效
- [ ] RULE-backend-quality-001 verifier：显式错误处理、有界远程调用、`go vet`/`go test` 触达包通过
- [ ] RULE-backend-write-err-001 verifier：错误响应仅走 writeErr/writeRuntimeFailure/writeRepoError 且只传 errcode 常量
- [ ] RULE-backend-database-001 verifier：SQL 参数化且限于 internal/repo；不新增/破坏绑定 schema
- [ ] RULE-backend-no-select-star-001 verifier：查询显式列，无 `SELECT *`
- [ ] RULE-backend-directory-001 verifier：internal 分层，handler 不承载存储/驱动细节
- [ ] RULE-backend-logging-001 verifier：结构化日志/审计、无秘密、审计与技能 telemetry 分离
- [ ] RULE-backend-redact-001 verifier：持久化/输出前经 RedactDiagnostic
- [ ] RULE-backend-platform-001 verifier：多用户隔离、模型绑定、注入、generation/health/失败语义保持
- [ ] RULE-backend-http-envelope-001 verifier：writeJSON/writeErr + 稳定 code 常量
- [ ] RULE-backend-model-pool-001 verifier：创建 Human User 必须绑定未占用模型，冲突返回稳定错误
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | 管理 HTTP、临时 SQLite、builder/renderer | 保护字段逐条一致、只变运行字段 | planned | planned | planned |
| S-05 | integration | 状态机、Driver 事件 | 停旧→取证→启动、无回滚路径 | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |
| S-09 | E2E | HTTP 写入口、Store、reconcile | 冻结与解除行为正确 | planned | planned | planned |
| S-11 | integration | 任务/租约 | 排空、不重放副作用 | planned | `node --test tools/muad-runtime-guard/test/long-task-drain.test.mjs` | planned |
| E-01 | E2E | SQLite、比较器、API | 绑定差异失败 | planned | planned | planned |
| E-02 | integration | 排空状态机 | 超时中止不杀后重放 | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |
| E-04 | integration | 材料校验、fake Driver | 未改写时拒绝 | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |
| E-07 | integration | 失败路径 | 停 error、不回退 | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |
| E-08 | integration | 错误封装 | 新稳定错误码 | planned | `cd console/backend && go test ./internal/api/...` | planned |
| E-09 | integration | 脱敏、审计、envelope | 无明文秘密 | planned | `cd console/backend && go test ./internal/api/...` | planned |
| E-10 | integration | 操作记录 | 中断恢复 fail-forward | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |
| B-03 | integration | 锁、事件序列 | 串行无第二 Gateway | planned | `cd console/backend && go test ./internal/runtimeapply/...` | planned |
| G-09 | integration | Console 编排 | 无自动回滚、超时/门禁生效 | planned | `cd console/backend && go test ./internal/runtimeupgrade/...` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-007: 插件、隔离与技能回归（9.8 宿主契约）

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: `openclaw-runtime-upgrade.design.md#3.5.3 多用户隔离与技能回归`, `openclaw-runtime-upgrade.design.md#3.1.2 兼容清单`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-security-001, runtime-skill-execution#RULE-runtime-skill-001, runtime-skill-execution#RULE-runtime-skill-layering-001, runtime-skill-execution#RULE-runtime-log-injection-001, runtime-skill-execution#RULE-runtime-log-prefix-001, runtime-skill-execution#RULE-runtime-skill-fail-loud-001
- **Acceptance-Refs**: S-07, E-06

### Description

在 9.8 宿主上回归自有插件与隔离面：Runtime Guard hooks/工具策略/浏览器与技能租约、session-manager 工具与缓存、技能分层与门禁、日志注入与固定前缀、技能失败语义；处理插件 capture 的包旁依赖约束（`/opt/muad/shared` 与 guard 包同级）与 `binding_code_spec.json` 随包进入 capture；确认最新通道插件（wecom 2026.9.15 / mattermost 2026.9.8）加载与响应解析。

### Checklist

- [ ] 校验插件布局满足 9.8 capture：`/opt/muad/shared` 与 guard 同级、`binding_code_spec.json` 在包内；必要时将 shared 收进 guard 包
- [ ] Runtime Guard：hooks、trustedToolPolicies、`muad.runtime.verify-routes`、租约与浏览器限制在 9.8 正常
- [ ] session-manager：工具注册、上下文、缓存不随历史清理
- [ ] skills：system/public/private 分层与 system protected、激活门禁、失败 stderr+非零、进度/并发遵守
- [ ] [S-07][integration] 跨 workspace/profile/model/credential 合成请求拒绝、技能分层/激活/租约保持（真实边界：真实 Guard/policy/session-manager 模块）
- [ ] [E-06][integration] 健康但通道未连/Bot 身份不符/路由命中 default 不能通过（真实边界：真实响应解析与严格验证器）
- [ ] RULE-runtime-security-001 verifier：凭据运行时注入、每用户 workspace/profile/session 隔离
- [ ] RULE-runtime-skill-001 verifier：激活/策略门禁、进度/telemetry 无秘密、并发/租约限制
- [ ] RULE-runtime-skill-layering-001 verifier：system protected 优先，public/private 不静默覆盖
- [ ] RULE-runtime-log-injection-001 verifier：模块经注入 log（插件 api.logger / CLI console.warn）
- [ ] RULE-runtime-log-prefix-001 verifier：`[muad-runtime-guard]`/`[session-manager]` 稳定前缀与动作子标签
- [ ] RULE-runtime-skill-fail-loud-001 verifier：失败 stderr + 非零退出，stdout 只放机器结果
- [ ] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-07 | integration | Guard/policy/session-manager | 跨用户拒绝、技能与租约保持 | planned | `node --test tools/muad-runtime-guard/test/multi-user-isolation.test.mjs` | planned |
| E-06 | integration | 响应解析、严格验证器 | 通道/身份/default 不通过 | planned | `cd console/backend && go test ./internal/gateway/...` | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写。

### Log
- [2026-10-07] created (draft)

---

## TASK-008: 验收材料、报告与人工边界

- **Status**: draft
- **Priority**: P0
- **Depends**: TASK-006, TASK-007
- **Source**: `openclaw-runtime-upgrade.design.md#4.3 正式切换后的业务验收`, `openclaw-runtime-upgrade.design.md#4.6 工作量与实施阶段`
- **Spec-Refs**:
- **Acceptance-Refs**: S-08, S-12, B-04, G-01～G-08

### Description

固化验收材料与报告：S-08（真实 IM 收发、双用户隔离、模型/Agent 生效）与 B-04（业务报告保持待验收）为切换后人工边界；S-12 输出 FEAT 验证/依赖记录、零人工迁移步骤、实测/预计/人工待验收区分；保留 G-01～G-08 预验证记录与 G-09 结论。

### Checklist

- [ ] [S-12][integration] 生成版本/验证/收益报告：FEAT 对应验证、零人工迁移步骤、实测与人工待验收分列（真实边界：文档/测试清单/版本报告）
- [ ] [S-08][manual] 记录真实 IM 收发/双用户隔离/模型生效的验收步骤与责任人（原因：依赖生产账号，无法提前演练）
- [ ] [B-04][manual] 业务报告在取得真实证据前保持 `pending_manual`（原因：不得用 mock 补成已通过）
- [ ] G-01～G-08[manual] 归档预验证记录（pod01/pod02 副本、构建链、租约实测）
- [ ] 运行验收命令并填写 Acceptance Evidence（manual 场景登记原因/边界/验收方式）

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-12 | integration | 文档/测试清单/版本报告 | 记录零人工迁移步骤、区分实测/待验收 | planned | `node --test bin/test/upgrade-report.test.mjs` | planned |
| S-08 | manual | 真实 IM 账号与用户 | 原机器人收发、双用户隔离 | manual | - | planned |
| B-04 | manual | 正式验收记录 | 未验收保持 pending | manual | - | planned |

### Acceptance Evidence

> 待 `cf-task-start` 填写；manual 场景只登记原因/边界/验收方式。

### Log
- [2026-10-07] created (draft)

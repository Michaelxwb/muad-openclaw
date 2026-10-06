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
| S-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 管理 HTTP → 临时 SQLite → 真实 builder/renderer | TASK-006 | e2e_deferred | - |
| S-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实 Guard verifier + 路由解析契约 | TASK-005 | verified | ["node","--test","tools/muad-runtime-guard/test/route-verifier.test.mjs"] |
| S-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 创建用户 API → 真 Store → DTO/渲染 → 重启选择 | TASK-004 | e2e_deferred | - |
| S-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 模型修改 API → Store → DTO → 目标重启协议 | TASK-004 | e2e_deferred | - |
| S-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | UpgradeService 状态机 + Driver 事件序列 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| S-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实临时文件树/SQLite + 自动迁移/新会话路径 | TASK-003 | verified | ["node","--test","bin/test/e2e/upgrade-doctor-chain.test.mjs"] |
| S-07 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实 Guard/policy/session-manager 模块 | TASK-007 | planned | ["node","--test","tools/muad-runtime-guard/test/multi-user-isolation.test.mjs"] |
| S-08 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | manual | 生产 native resolver、双 IM 原账号、真实模型响应 | TASK-008 | planned | - |
| S-09 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | HTTP 写入口 → Store → 维护状态 → reconcile 调度 | TASK-006 | e2e_deferred | - |
| S-10 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 版本清单、自检逻辑、实际模块/配置文件 | TASK-001 | verified | ["node","--test","bin/test/runtime-image-self-check.test.mjs"] |
| S-11 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | guard health longTask 计数 + 排空状态机 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| S-12 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 文档/测试清单/版本报告 | TASK-008 | planned | ["node","--test","bin/test/upgrade-report.test.mjs"] |
| E-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | E2E | 临时 SQLite → 保护字段比较 → API 错误输出 | TASK-006 | e2e_deferred | - |
| E-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 排空状态机与租约记录 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| E-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 生效确认解析与计时器 | TASK-004 | verified | ["go","-C","console/backend","test","./internal/runtimeapply/..."] |
| E-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 取证材料校验 + fake 存储/Driver | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| E-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实临时状态树与自动迁移失败路径 | TASK-003 | verified | ["node","--test","bin/test/e2e/upgrade-doctor-chain.test.mjs"] |
| E-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实响应解析与严格验证器 | TASK-007 | planned | ["go","-C","console/backend","test","./internal/gateway/..."] |
| E-07 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 编排失败路径 + 原配置/状态引用 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| E-08 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 失败终态/错误封装 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/api/..."] |
| E-09 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实脱敏函数、日志回调与错误 envelope | TASK-006 | verified | ["go","-C","console/backend","test","./internal/api/..."] |
| E-10 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真实操作记录原子写/加载 + fake 外部边界 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |
| B-01 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | builder/Guard 校验 | TASK-005 | verified | ["node","--test","tools/muad-runtime-guard/test/route-verifier.test.mjs"] |
| B-02 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 路由规范化与 identityLinks | TASK-005 | verified | ["go","-C","console/backend","test","./internal/runtimeconfig/..."] |
| B-03 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 锁与阶段事件序列 | TASK-006 | verified | ["go","-C","console/backend","test","./internal/runtimeapply/..."] |
| B-04 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | manual | 正式验收记录 | TASK-008 | planned | - |
| B-05 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 真分批/聚合器与 fake RPC | TASK-005 | verified | ["go","-C","console/backend","test","./internal/gateway/..."] |
| B-06 | openclaw-runtime-upgrade.design.md#2.5 验收条件 | integration | 版本能力选择、配置/自检 | TASK-004 | verified | ["node","--test","bin/test/runtime-config-transaction.test.mjs"] |
| G-01～G-05、G-07～G-08 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | manual | pod01/pod02 状态副本、租约实测（已完成，记录保留） | TASK-008 | verified | - |
| G-06 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | integration | Docker 构建链、镜像内 CLI 自检 | TASK-001 | verified | ["docker","build","-f","Dockerfile.base","-t","muad-openclaw-base:98pin-test","."] |
| G-09 | openclaw-runtime-upgrade.design.md#4.0 可行性前置门禁 | integration | Console 去自动回滚/超时/维护门禁 | TASK-006 | planned | ["go","-C","console/backend","test","./internal/runtimeupgrade/..."] |

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

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`, `openclaw-runtime-upgrade.design.md#3.5.2 重启与配置生效`
- **Spec-Refs**: runtime-config-and-apply#RULE-runtime-config-001, runtime-config-and-apply#RULE-runtime-validate-before-write-001
- **Acceptance-Refs**: S-04, S-10, B-06

### Description

修复 9.8 实测拒绝的三个配置形态：删除 `browser.profiles.*.color` 与 `plugins.bundledDiscovery`；mattermost `streaming` 从字符串改为 `{ mode: "off" }`；将 `agents` 输出迁移为 `agents.entries`（保留 `ownership`）并保留/生成 Doctor 迁移产生的 `main` 通道级 fallback 绑定（多 Agent 无匹配 binding 时 9.8 fail-closed，且避免每次迁移后 apply 触发重启）。保证候选配置在 9.8 `openclaw config validate` 通过。

### Checklist

- [x] `bin/openclaw-config-renderer.mjs`：删除 `browser.profiles.*.color` 与 `plugins.bundledDiscovery`
- [x] `bin/channel-config.mjs`：`streaming = { mode: "off" }`（对象）
- [x] renderer `agents` 输出改为 `agents.entries`（keyed）并保留 `agents.ownership`；不再写 `agents.list`
- [x] renderer/handoff 保留或生成每个启用通道的 `main` fallback 绑定（`match.accountId="*"`）
- [x] [S-04][E2E] 模型/agents 渲染变化在候选配置上 validate 通过并选择正确重启协议（真实边界：renderer → 9.8 CLI validate → restartMode）；登记为 e2e_deferred，留待终验
- [x] [B-06][integration] 旧/新版本能力选择与配置/自检（真实边界：版本表、候选配置、自检）
- [x] [S-10][integration] 候选配置 validate 通过且无 unrecognized key（真实边界：9.8 `openclaw config validate`）
- [x] RULE-runtime-config-001 verifier：候选配置经 schema 校验与事务管线（prepare/validate/commit）且验证回滚/健康语义不被破坏
- [x] RULE-runtime-validate-before-write-001 verifier：materialize 前调用 validateRuntimeConfig、0600 原子写、generation 单调
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | E2E | renderer、9.8 CLI validate、重启选择 | 配置 valid、restartMode 正确 | renderer 候选 → 9.8 CLI（终验执行） | - | e2e_deferred |
| B-06 | integration | 版本能力表、配置/自检 | 旧新版本各自协议正确 | `bin/test/runtime-config-transaction.test.mjs` | `node --test bin/test/runtime-config-transaction.test.mjs` | verified |
| S-10 | integration | 9.8 config validate | 无 unrecognized key | `bin/test/inject-multi-user-config.test.mjs` + 9.8 validate | `node --test bin/test/inject-multi-user-config.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| B-06 / S-10 | 7 处新断言失败：agents.entries 缺失、color/bundledDiscovery 仍存在、streaming 为字符串、main fallback 缺失 | `node --test bin/test/inject-multi-user-config.test.mjs` → 24/24；bin 全量 117/117 | `bin/test/inject-multi-user-config.test.mjs`（entries/ownership/fallback/color/bundledDiscovery/streaming 断言） | 真实迁移后配置（pod01 副本）→ 本仓库 renderer → 候选：agents.entries+ownership、无 color/bundledDiscovery、streaming `{mode:"off"}`、bindings 3 路由+2 main fallback → 9.8 `openclaw config validate` = `valid:true` | verified |
| S-04 | -（E2E 只登记） | pending（终验） | 候选 validate 通过；restartMode=gateway 已在 prepare 输出观测 | `runtime-config-transaction prepare` 输出 `restartMode:"gateway"` | e2e_deferred |

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started；RED：更新/新增 9.8 形态断言后 7 处失败
- [2026-10-07] 实现 renderer entries/ownership、去 color/bundledDiscovery、main fallback、channel-config streaming 对象；bin 全量 117/117 GREEN
- [2026-10-07] 集成验证：真实 pod01 迁移后配置经 renderer 生成候选 → 9.8 validate `valid:true`
- [2026-10-07] completed (done)

---

## TASK-003: Entrypoint 承接 Doctor 与插件 registry 处置

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: `openclaw-runtime-upgrade.design.md#3.1.3 当前必须处理的兼容差异`, `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`, `openclaw-runtime-upgrade.design.md#4.2.1 正式升级顺序`
- **Spec-Refs**: runtime-isolation-and-security#RULE-runtime-secret-file-mode-001
- **Acceptance-Refs**: S-06, E-05, G-01, G-04

### Description

在自有 entrypoint 的 Gateway 启动前显式执行 `openclaw doctor --fix --non-interactive`（fail-closed），承接状态自动迁移；对 9.8 已移除的 `installed_plugin_index` 兼容旧 prune（7.1 状态）并避免 9.8 静默失配，遵循 Doctor 自动刷新 registry 的新机制；保证写入文件的权限仍符合 0600/0400 约束。

### Checklist

- [x] `entrypoint.sh` 在启动 Gateway 前执行 `openclaw doctor --fix --non-interactive`，失败退出（非零）
- [x] prune/registry：核对 7.1 状态与 9.8 状态两条路径；9.8 下以 Doctor registry 刷新为准，确保不再依赖 `installed_plugin_index`
- [x] [S-06][integration] 历史自动兼容/自动新会话、全程无人工迁移脚本（真实边界：真实临时文件树/SQLite + Doctor 链路）
- [x] [E-05][integration] 自动迁移失败停 error 且不把“手工脚本”当出口（真实边界：临时状态树与失败路径）
- [x] RULE-runtime-secret-file-mode-001 verifier：检查 entrypoint/迁移产物权限（config/bundle 0600，Pod token 0400 规范路径）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-06 | integration | 真实状态树/SQLite、Doctor | 自动迁移成功、零人工脚本 | `bin/test/e2e/upgrade-doctor-chain.test.mjs` | `node --test bin/test/e2e/upgrade-doctor-chain.test.mjs` | verified |
| E-05 | integration | 自动迁移失败路径 | fail-closed、停 error | `bin/test/e2e/upgrade-doctor-chain.test.mjs`（只读卷失败路径） | `node --test bin/test/e2e/upgrade-doctor-chain.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| S-06 | recipe 测试断言 entrypoint 必须含 Doctor 且位于 gateway 前 → 失败；prune 9.8 形态测试 → 失败（会误删 npm 项目） | `bin` 全量 118/118；`node --test bin/test/e2e/upgrade-doctor-chain.test.mjs` 2/2 | `bin/test/runtime-image-recipe.test.mjs`（doctor 顺序 + fail-closed）；`bin/test/prune-managed-plugin-installs.test.mjs`（9.8 no-op） | 真实 9.8 镜像 Doctor：合成 7.1 状态 → `openclaw-agent.sqlite` session_nodes≥1；本仓库镜像 `98task3` 完整链路：inject→prune→self-check→Doctor（自动备份）→gateway，路由 3/3、transaction validate `valid:true` | verified |
| E-05 | - | 只读挂载 Doctor 非零退出（GatewayLockError, exit 1），entrypoint `set -e` 直接退出 | e2e 第二用例 | 真实镜像 + 只读临时状态树 | verified |
- S-06: verified — automated command passed; run_id=4bb2685126224019825598d54525be7c (confirmed_by: runner)
- E-05: verified — automated command passed; run_id=4bb2685126224019825598d54525be7c (confirmed_by: runner)

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started；RED：recipe Doctor 顺序断言失败、prune 9.8 用例失败
- [2026-10-07] 实现：entrypoint 增 Doctor（fail-closed）；prune 在无 installed_plugin_index 时整体 no-op（交由 Doctor registry 刷新）
- [2026-10-07] GREEN：bin 118/118；e2e 真实 Doctor 2/2；镜像 `98task3` 端到端链路 + 路由 3/3 + validate valid
- [2026-10-07] completed (done)

---

## TASK-004: 重启协议与模型变更强制重启

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `openclaw-runtime-upgrade.design.md#3.5.2 重启与配置生效`, `openclaw-runtime-upgrade.design.md#3.1.4 实机预验证结论`
- **Spec-Refs**:
- **Acceptance-Refs**: S-03, S-04, E-03, B-06

### Description

保持"模型修改触发 Gateway 重启"的产品行为：在 `bin/runtime-config-transaction.mjs` 的 `selectRestartMode` 中把 providers/agents 模型变化纳入 `gateway`；重启信号按 pod 自身版本协商（7.1=USR1，9.6+=USR2），由 prepare 结果携带提示，`runtimeapply` 使用该提示而非硬编码 USR1；处置 `inject-channels.mjs`（无调用方的 SIGUSR1 死代码）。

### Checklist

- [x] `selectRestartMode` 增加模型/Provider 变化检测（providers 与 agents 模型段），命中即 `gateway`
- [x] prepare 结果附带 `gatewaySignal`（按 pod 内 OpenClaw 版本：9.6+→USR2，旧版→USR1），`runtimeapply/apply.go` 使用该提示发送对应信号
- [x] `inject-channels.mjs`：按版本适配或移除（当前无 Go 调用方），避免 9.6+ 误发 USR1
- [x] [S-04][E2E] 模型修改后 apply 选择 Gateway 重启并按版本协议发送信号（真实边界：模型修改 API → Store → DTO → 重启协议）；登记 e2e_deferred，镜像内集成证据已记录
- [x] [S-03][E2E] 新增用户/Agent 热重启路径不重建 Pod（真实边界：创建用户 API → 真 Store → DTO/渲染 → 重启选择）；登记 e2e_deferred
- [x] [E-03][integration] 信号发送成功但 generation/配置未收敛时到期失败（真实边界：生效确认解析与计时器）
- [x] [B-06][integration] 旧/新版本选择正确重启协议（真实边界：版本能力选择、事务 prepare）
- [x] RULE-backend-quality-001 的触达包 verifier 由 TASK-006 承担；本任务保证 runtimeapply/transaction 改动错误显式处理、有界 context
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-04 | E2E | 模型 API、Store、DTO、重启协议 | 模型变化→gateway；9.8 用 USR2 | 终验执行（镜像内 prepare 已给出 gateway+USR2 集成证据） | - | e2e_deferred |
| S-03 | E2E | 创建用户 API、Store、渲染 | 热重启、不重建 Pod | 终验执行 | - | e2e_deferred |
| E-03 | integration | probe 解析、计时器 | 未收敛到期失败 | `console/backend/internal/runtimeapply/apply_test.go` | `go -C console/backend test ./internal/runtimeapply/...` | verified |
| B-06 | integration | 版本能力、事务 prepare | 协议选择正确 | `bin/test/runtime-config-transaction.test.mjs`、`bin/test/gateway-signal.test.mjs` | `node --test bin/test/runtime-config-transaction.test.mjs` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| E-03 / B-06 | JS：gateway-signal 模块缺失、模型变更两条断言失败、prepare 信号断言失败（4 fail）；Go：USR2 用例收到 USR1、未知信号未拒绝（2 fail） | JS 20/20；bin 全量 125/125；`go test ./...` 全绿；`go vet` clean | `bin/test/gateway-signal.test.mjs`；`bin/test/runtime-config-transaction.test.mjs`；`console/backend/internal/runtimeapply/apply_test.go`（USR2/default/reject） | 镜像 `98task4`（9.8）内真实事务：模型变更 prepare → `{"restartMode":"gateway","gatewaySignal":"USR2"}`，validate `valid:true`；commit 后幂等 prepare → `none` + USR2 | verified |
| S-04 | - | 集成证据：模型变更选择 gateway 且信号 USR2（见上） | - | 真实镜像内事务 + 真实 9.8 CLI | e2e_deferred |
- S-03: e2e_deferred — automated command e2e_deferred; run_id=336aac07629342d397a5e5a2081f9930 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=336aac07629342d397a5e5a2081f9930 (confirmed_by: runner)
- E-03: failed — automated command failed; run_id=336aac07629342d397a5e5a2081f9930 (confirmed_by: runner)
- B-06: verified — automated command passed; run_id=336aac07629342d397a5e5a2081f9930 (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=4b3ba18f24ab44b4a863af797eeb4e8c (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=4b3ba18f24ab44b4a863af797eeb4e8c (confirmed_by: runner)
- E-03: failed — automated command failed; run_id=4b3ba18f24ab44b4a863af797eeb4e8c (confirmed_by: runner)
- S-03: e2e_deferred — automated command e2e_deferred; run_id=efd6af9baace4206992e3f70d2987d34 (confirmed_by: runner)
- S-04: e2e_deferred — automated command e2e_deferred; run_id=efd6af9baace4206992e3f70d2987d34 (confirmed_by: runner)
- E-03: verified — automated command passed; run_id=efd6af9baace4206992e3f70d2987d34 (confirmed_by: runner)
- B-06: verified — automated command passed; run_id=efd6af9baace4206992e3f70d2987d34 (confirmed_by: runner)

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started；RED：JS 4 fail（缺 gateway-signal/模型检测/prepare 信号）、Go 2 fail（USR2 未生效/未知信号未拒绝）
- [2026-10-07] 实现：gateway-signal 助手（版本映射）、transaction 模型检测+信号输出、inject-channels 版本化信号、apply.go 解析校验并透传（默认 USR1，未知信号 prepare 阶段拒绝）
- [2026-10-07] 集成发现并修复：gateway-signal.mjs 未加入镜像 COPY 列表（recipe 测试补防回归断言）；镜像内事务实测 gateway+USR2+validate valid
- [2026-10-07] completed (done)

---

## TASK-005: 路由验证全量与分批

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `openclaw-runtime-upgrade.design.md#3.5.4 全量技术验收`, `openclaw-runtime-upgrade.design.md#2.5 验收条件`
- **Spec-Refs**:
- **Acceptance-Refs**: S-02, B-01, B-02, B-05

### Description

把运行时路由核对改为"全量 + 有界分批"：`gateway/probe.go` 单次 RPC 拆为 ≤1000 路由的有界批次并聚合（同 generation、checked 求和、RPC 错仍为 Unknown）；`apply.go` 期望集过滤不得静默丢弃非 direct/dm 身份（扩展 verifier 或 fail-closed 并列入报告）；verifier 的 `sessionMatchesAgent` 与 `parseSessionKey` 与新口径一致（dm→direct、支持 group/channel 判定）。

### Checklist

- [x] `gateway/probe.go` 实现 ≤1000 分批聚合（同 generation、checked/failed 求和、RPC 错→Unknown）
- [x] `runtimeapply/apply.go` 期望集口径：全量 active 路由；非 direct/dm 不得静默过滤（fail-closed 或扩展 verifier）
- [x] `route-verifier.mjs`/`binding-context.mjs`：dm 路由标记识别与 peerKind 对应校验（现有实现已支持 dm→direct 映射；口径由后端 fail-closed 保证）
- [x] [S-02][integration] 双用户/双通道/不同 accountId 全量严格聚合（真实边界：真实 Guard verifier + 路由解析契约）
- [x] [B-05][integration] 1000/1001 条合成路由分批聚合、checked 精确合计（真实边界：真分批/聚合器与 fake RPC）
- [x] [B-01][integration] 0 有效路由、禁用身份、未知 sender 不进入业务 Agent（真实边界：builder/Guard 校验）
- [x] [B-02][integration] default account、双账号、同用户双通道语义保持（真实边界：路由规范化与 identityLinks）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-02 | integration | Guard verifier、路由解析 | 全部命中原 Agent、无 default 兜底 | `tools/muad-runtime-guard/test/route-verifier.test.mjs` | `node --test tools/muad-runtime-guard/test/route-verifier.test.mjs` | verified |
| B-05 | integration | 分批/聚合器、RPC | 1000/1001 完整分批、checked 合计 | `console/backend/internal/gateway/probe_test.go` | `go -C console/backend test ./internal/gateway/...` | verified |
| B-01 | integration | builder/Guard | 0 路由不虚报、禁用不放行 | `tools/muad-runtime-guard/test/route-verifier.test.mjs`、`apply_test.go`（fail-closed） | `node --test tools/muad-runtime-guard/test/route-verifier.test.mjs` | verified |
| B-02 | integration | routes/identityLinks | 账号与通道语义保持 | `console/backend/internal/runtimeconfig` | `go -C console/backend test ./internal/runtimeconfig/...` | verified |

### Acceptance Evidence

| 场景ID | RED | GREEN | 断言位置 | 真实边界证据 | 状态 |
|--------|-----|-------|---------|-------------|------|
| B-05 | 单次调用批大小 `[1001]`、第二批 RPC 失败未生效、聚合仅一批（3 处失败） | `go -C console/backend test ./internal/gateway/...` 全绿 | `console/backend/internal/gateway/probe_test.go`（batching/RPC unknown/deterministic 聚合） | 真实 VerifyRoutes 分批逻辑 + fake RPC 记录每批 payload 大小（1000+1，无截断） | verified |
| B-01 | `TestApplyRejectsUnsupportedPeerKindRoutes` 失败（group 被静默过滤后仍 commit） | `go -C console/backend test ./internal/runtimeapply/...` 全绿 | `console/backend/internal/runtimeapply/apply_test.go`；`apply.go selectVerifiableRoutes` | 非 direct/dm 直接 fail-closed（prepare 阶段拒绝，不 commit） | verified |
| S-02 / B-02 | - | route-verifier 与 runtimeconfig 测试全绿；镜像链路真实 3/3 路由（TASK-003 记录） | `tools/muad-runtime-guard/test/route-verifier.test.mjs` | 真实 verifier 模块 + 真实 routes/identityLinks 渲染契约 | verified |
- S-02: verified — automated command passed; run_id=efe1ecbb6dcf418383ffd801e5c6ba6e (confirmed_by: runner)
- B-01: verified — automated command passed; run_id=efe1ecbb6dcf418383ffd801e5c6ba6e (confirmed_by: runner)
- B-02: verified — automated command passed; run_id=efe1ecbb6dcf418383ffd801e5c6ba6e (confirmed_by: runner)
- B-05: verified — automated command passed; run_id=efe1ecbb6dcf418383ffd801e5c6ba6e (confirmed_by: runner)

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started；RED：分批 3 处失败、apply fail-closed 1 处失败
- [2026-10-07] 实现：probe.go ≤1000 分批聚合（RPC 错仍 Unknown、checked/failed 求和）；apply.go selectVerifiableRoutes 对 group/channel/未知 peerKind fail-closed
- [2026-10-07] GREEN：go 全量测试通过（gateway/runtimeapply 含新用例）；route-verifier 测试通过
- [2026-10-07] completed (done)

---

## TASK-006: Console 升级编排 fail-forward（G-09）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-005
- **Source**: `openclaw-runtime-upgrade.design.md#3.4 接口设计`, `openclaw-runtime-upgrade.design.md#2.4 范围与边界`, `openclaw-runtime-upgrade.design.md#4.2 原位升级流程`, `openclaw-runtime-upgrade.design.md#4.5 中断处理与运维观察`
- **Spec-Refs**: backend-code-quality-performance#RULE-backend-quality-001, backend-code-quality-performance#RULE-backend-write-err-001, backend-database#RULE-backend-database-001, backend-database#RULE-backend-no-select-star-001, backend-directory-structure#RULE-backend-directory-001, backend-logging#RULE-backend-logging-001, backend-logging#RULE-backend-redact-001, backend-platform-rules#RULE-backend-platform-001, backend-platform-rules#RULE-backend-http-envelope-001, backend-platform-rules#RULE-backend-model-pool-001
- **Acceptance-Refs**: S-01, S-05, S-09, S-11, E-01, E-02, E-04, E-07, E-08, E-09, E-10, B-03, G-09

### Description

按无回退决策改造 Console 升级编排：新增 `internal/runtimeupgrade` 模块承载阶段、维护门禁、操作记录与 fail-forward 流程；`/upgrade` 与镜像 PATCH 共用编排；跨迁移失败不再自动回滚旧镜像/旧状态（停 error，走既有 error 态改镜像/restart 出口）；总操作与健康超时按首次迁移调整并支持镜像预热；维护门禁覆盖已核对的未持锁写入口；失败使用新的稳定错误码（不使用 50205/50215）；操作记录原子写入 Console 持久目录并支持中断恢复。

### Checklist

- [x] 新增 `internal/runtimeupgrade`：阶段状态机（prepared→starting→completed/failed；技术校验在 execute 内）、持久操作记录（原子 0600/目录 0700）、启动扫描（Recover）
- [x] `pod_upgrade.go`：移除跨迁移自动回滚（失败停 error + 新稳定错误码 50216）；保留 error 态改镜像/restart 出口；`/upgrade` 与镜像 PATCH 共用同一编排
- [x] 超时调整：健康 5 分钟、总操作 15 分钟（首次迁移 + 镜像预热；实测 Doctor+启动远小于窗口）
- [x] 维护门禁 helper + 接入关键写入口：用户创建/修改/删除、身份增删改、绑定码生成/撤销、通道 PUT、资源 PUT、token 轮换、镜像 PATCH、apply-config；模型/技能入口沿用同一 helper（plan 矩阵续接）
- [x] [S-01][E2E] 合成双用户绑定升级编排前后保护字段逐条一致（真实边界：管理 HTTP → 临时 SQLite → 真实 builder/renderer）；登记 e2e_deferred
- [x] [S-05][integration] 排空→切换→完成且无回滚路径（真实边界：状态机 + 事件序列）
- [x] [S-09][E2E] 维护期间写入口被拒绝、解除后恢复（真实边界：HTTP 写入口 → Store → 维护状态 → reconcile）；登记 e2e_deferred（单元层已覆盖 helper/服务）
- [x] [S-11][integration] 排空失败中止、不重放未知副作用（真实边界：真实 guard health 的 longTask 计数解析 + 排空状态机）
- [x] [E-01][E2E] 同数量但字段被替换 → 失败不报绑定完整（真实边界：临时 SQLite → 保护字段比较 → API 错误）；登记 e2e_deferred
- [x] [E-02][integration] 任务无法安全结束 → 切换前中止、不自动重放（真实边界：排空状态机）
- [x] [E-04][integration] 取证材料/前置校验失败 → 未改写时安全拒绝（真实边界：preflight + fake Driver）
- [x] [E-07][integration] 新版启动/迁移失败 → 停 error，不恢复旧镜像/旧状态（真实边界：编排失败路径）
- [x] [E-08][integration] 失败终态返回稳定升级失败码 50216（非 50205/50215）（真实边界：错误封装）
- [x] [E-09][integration] 注入 Token/Cookie 的错误输出/审计无明文（真实边界：脱敏函数 + 日志回调 + envelope）
- [x] [E-10][integration] Console 各阶段中断后按 fail-forward 收敛或停 error（真实边界：操作记录原子写/加载 + 启动扫描）
- [x] [B-03][integration] 并发升级串行、无第二个 Gateway（真实边界：锁与阶段事件序列）
- [x] G-09 verifier[integration]：Console 编排无自动回滚、维护门禁生效、失败停 error
- [x] RULE-backend-quality-001 verifier：`go vet ./...`、`go test ./...` 全绿；有界 context/超时
- [x] RULE-backend-write-err-001 verifier：错误响应仅走 writeErr/writeRuntimeFailure/writeRepoError + errcode 常量（50216/40905）
- [x] RULE-backend-database-001 verifier：SQL 参数化且限于 internal/repo；未新增/破坏绑定 schema
- [x] RULE-backend-no-select-star-001 verifier：查询显式列（本次无新 SQL）
- [x] RULE-backend-directory-001 verifier：runtimeupgrade 为 internal 包；handler 仅编排调用
- [x] RULE-backend-logging-001 verifier：结构化日志、审计事件 upgrade/upgrade_failed，无秘密
- [x] RULE-backend-redact-001 verifier：FailPodConfigApply 前经 RedactDiagnostic（回归测试覆盖）
- [x] RULE-backend-platform-001 verifier：隔离/模型绑定/generation/失败语义保持；回退语义按用户决策移除
- [x] RULE-backend-http-envelope-001 verifier：writeJSON/writeErr + 稳定 code 常量
- [x] RULE-backend-model-pool-001 verifier：创建 Human User 仍强制未占用模型（现有回归通过）
- [x] 运行验收命令并填写 Acceptance Evidence

### Acceptance Contract

| 场景ID | 测试层级 | 不得 Mock 的真实边界 | 关键断言 | 测试文件 / 用例 | 执行命令 | 状态 |
|--------|---------|--------------------|---------|----------------|---------|------|
| S-01 | E2E | 管理 HTTP、临时 SQLite、builder/renderer | 保护字段逐条一致、只变运行字段 | 终验执行 | - | e2e_deferred |
| S-05 | integration | 状态机、事件序列 | 排空→切换→完成、无回滚 | `console/backend/internal/runtimeupgrade/service_test.go` | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| S-09 | E2E | HTTP 写入口、Store、reconcile | 冻结与解除行为正确 | 终验执行 | - | e2e_deferred |
| S-11 | integration | guard health longTask + 排空状态机 | 排空失败中止、不重放 | `service_test.go`、`probe_test.go`（LongTask 解析） | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| E-01 | E2E | SQLite、比较器、API | 绑定差异失败 | 终验执行 | - | e2e_deferred |
| E-02 | integration | 排空状态机 | 超时中止不杀后重放 | `service_test.go TestRunDrainFailureAbortsBeforeExecute` | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| E-04 | integration | preflight、fake Driver | 未改写时拒绝 | `service_test.go TestRunPreflightFailureLeavesPodUntouched` | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| E-07 | integration | 失败路径 | 停 error、不回退 | `service_test.go TestRunExecuteFailureStopsInErrorWithoutRollback`；`test/pod_operations_api_test.go` | `go -C console/backend test ./test/ -run UpgradeFailure` | verified |
| E-08 | integration | 错误封装 | 新稳定错误码 50216 | `console/backend/test/pod_upgrade_api_test.go` | `go -C console/backend test ./test/...` | verified |
| E-09 | integration | 脱敏、审计、envelope | 无明文秘密 | `pod_upgrade_api_test.go`（私有 key/token 用例） | `go -C console/backend test ./test/...` | verified |
| E-10 | integration | 操作记录 | 中断恢复 fail-forward | `service_test.go TestRecoverFailsUnfinishedOperations` | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| B-03 | integration | 锁、事件序列 | 串行无第二 Gateway | `service_test.go TestConcurrentRunsSerializePerPod`；runtimeapply 回归 | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |
| G-09 | integration | Console 编排 | 无自动回滚、维护门禁生效 | `service_test.go`（maintenance gate/失败路径/恢复扫描） | `go -C console/backend test ./internal/runtimeupgrade/...` | verified |

### Acceptance Evidence

| 项 | 证据 | 状态 |
|----|------|------|
| runtimeupgrade 模块 | journal 原子写/0600/目录 0700/非法 ID 拒绝；service 阶段与 fail-forward；Recover 标记未完成并置 pod error | verified |
| pod_upgrade 行为 | 失败停 error + 目标镜像保留；无 rollback replace（`replaceErrors` 第二次未被消费）；PATCH 同编排；50216 目录项齐全 | verified |
| 超时 | `upgradeHealthTimeout=5m`、`podRuntimeOpTimeout=15m`（首次迁移+预热） | verified |
| 维护门禁 | helper + 已接入入口（用户/身份/绑定码/通道/资源/token/镜像 PATCH/apply-config）；维护中返回 40905 | verified |
| 全量回归 | `go vet ./...`、`go test ./...` 全绿；`go vet -tags "e2e integration" ./test/` 通过 | verified |
| RED 说明 | 本任务为行为取舍（用户确认无回退）+ 新模块同批引入：旧回滚断言测试被改写为 fail-forward，未保留可复现 RED；未伪造失败 | recorded |
- S-01: e2e_deferred — automated command e2e_deferred; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- S-05: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- S-09: e2e_deferred — automated command e2e_deferred; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- S-11: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-01: e2e_deferred — automated command e2e_deferred; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-02: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-04: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-07: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-08: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-09: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- E-10: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)
- B-03: verified — automated command passed; run_id=0ba9ff501ae145f49b3ca2e027576be2 (confirmed_by: runner)

### Log
- [2026-10-07] created (draft)
- [2026-10-07] started
- [2026-10-07] 实现 runtimeupgrade（journal/service/Recover）、pod_upgrade fail-forward（50216）、超时 5m/15m、维护门禁 helper + 入口接入、main 装配（journal/Recover/quiescer）
- [2026-10-07] 既有回滚测试改写为 fail-forward；新增 runtimeupgrade 8 用例、LongTask 解析用例；全量后端测试与 vet 通过
- [2026-10-07] completed (done)

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

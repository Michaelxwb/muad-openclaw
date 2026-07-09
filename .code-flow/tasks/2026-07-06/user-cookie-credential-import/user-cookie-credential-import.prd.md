# PRD: 用户业务系统登录态与 Cookie 凭证托管

> **文档编号**: PRD-2026-07-06-01
> **文档版本**: v0.4
> **创建日期**: 2026-07-06
> **修订日期**: 2026-07-08
> **产品负责人**:
> **状态**: 草稿

**评审边界说明**:
- **需求基线**: 第 2-6 章（背景/用户/功能/非功能/范围）通过后锁定
- **设计输入**: 第 3-6 章为 `cf-task:align` / 技术设计提供输入

**ID 体系**: US（用户故事）、FEAT（功能）、NFR（非功能指标）、RISK（风险）

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 背景与目标](#2-背景与目标)
- [3. 用户与场景](#3-用户与场景)
- [4. 功能需求](#4-功能需求)
- [5. 非功能需求](#5-非功能需求)
- [6. 范围与边界](#6-范围与边界)
- [7. 依赖与风险](#7-依赖与风险)
- [附录：术语表](#附录术语表)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 产品经理 | | 需求定义、业务验收 |
| 开发负责人 | | 技术方案确认、实现拆解 |
| 测试负责人 | | 验收用例、稳定性验证 |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-07-06 | Codex | 初始草稿（Cookie 导入方案） |
| v0.2 | 2026-07-07 | Codex | 方案变更为服务账号 + token API 交换 |
| v0.3 | 2026-07-07 | Codex | 简化为 session-manager + 插件式登录脚本，Console 侧零改动 |
| v0.4 | 2026-07-08 | Codex | 按最新对齐补充 public/private skill、OpenClaw/Hermes 双 Agent 适配、session-manager tool/plugin 方案 |

---

## 2. 背景与目标

### 2.1 问题陈述

集中化部署后，skill 运行在服务器 Pod 内，不能再复用用户本地浏览器的 Cookie。业务 skill 访问 SOAR、Sea_SOAR、MSSW、XDR、SDSP 等企业系统时，需要一个稳定、低感知、按用户隔离的登录态获取机制。

当前需要同时满足这些约束：

| 维度 | 内容 |
|------|------|
| 部署形态 | 每个用户一个 Worker Pod，业务 skill 在 Pod 内运行。 |
| 用户入口 | 内部用户主要通过企业微信触发业务 skill；客户侧通过微信触发客户服务能力。 |
| 业务系统约束 | 业务平台有验证码、多步校验、单浏览器 session 互踢等约束，不能依赖 headless 浏览器自动登录。 |
| 平台能力 | 业务平台可提供 token API 与 cookie API，由服务账号标识换取短期登录态。 |
| Agent 可切换 | 底层 Agent 可能在 OpenClaw 与 Hermes Agent 之间切换，登录态能力不能绑定单一 Agent 实现。 |
| Skill 分层 | public skill 需要所有 Pod 共享；private skill 需要随用户 State PVC 私有保存。 |

### 2.2 核心目标

实现一个跨 Agent 可复用的 session-manager 能力，为业务 skill 提供统一登录态接口：

```text
业务 skill -> session-manager tool -> session-manager core -> 平台 token/cookie API
```

目标结果：

| 目标 | 说明 |
|------|------|
| 用户无感 | 用户触发业务 skill 时无需手工导入 Cookie、无需输入密码。 |
| 不阻塞体验 | 登录态准备失败或超时时必须有确定反馈，不能让 Agent 无限等待或反复猜测。 |
| 按用户隔离 | Cookie、storageState、private skill 均落在当前用户 State PVC。 |
| public/private skill 分层 | public skill 通过共享只读 PVC 分发；private skill 位于每用户 State PVC。 |
| 双 Agent 适配 | OpenClaw 与 Hermes 各有薄适配层，核心登录态逻辑复用一套。 |
| Console 低改造 | 首期不新增 Console 凭证管理 UI/API，不新增 DB 表。 |

### 2.3 成功指标

| 指标 | 目标值 | 衡量方式 |
|------|--------|----------|
| 首次登录态获取 | 在平台 API 正常时，业务 skill 可自动获得 Cookie/storageState | SOAR/XDR 等端到端验收 |
| 缓存复用 | 第二次访问同一平台优先复用 State PVC 中的有效登录态 | 观察 `source=cache` |
| Pod 重建恢复 | Worker Pod 删除重建后可从 State PVC 恢复有效登录态 | 删除 Pod 后再次调用 |
| 用户不卡住 | cache 读取、刷新、预热均有明确超时和状态返回 | 人工断网/接口超时演练 |
| 新平台接入 | 新增平台只需新增平台适配脚本/模块，不改 Console | 新增一个模拟平台验收 |
| 双 Agent 复用 | OpenClaw/Hermes 切换时核心 session-store 与平台逻辑可复用 | 两种 Agent 下调用同一 core |

---

## 3. 用户与场景

### 3.1 目标用户

| 用户 | 诉求 |
|------|------|
| 内部用户 | 在企微中直接使用 SOAR、Sea_SOAR、MSSW、XDR、SDSP 等业务 skill，不关心登录态准备过程。 |
| 客户 | 在微信中发起服务请求，由客户服务 skill 使用必要业务系统能力完成响应。 |
| skill 开发者 | 使用统一 session-manager 接口，不在每个业务 skill 中重复实现 Cookie 获取、缓存、刷新。 |
| 平台管理员 | 能通过 public skill / plugin 发布统一能力，并保证用户私有数据隔离。 |
| 运维人员 | 能定位登录态获取失败、平台 API 不可达、Cookie 失效等问题。 |

### 3.2 用户故事

| 编号 | 用户故事 | 优先级 |
|------|---------|--------|
| US-01 | 作为内部用户，我希望在企微触发业务 skill 后系统自动准备业务系统登录态，以便不用手工上传 Cookie 或输入密码。 | P0 |
| US-02 | 作为 skill 开发者，我希望通过统一 tool 获取平台登录态，以便业务 skill 不再关心鉴权细节。 | P0 |
| US-03 | 作为平台管理员，我希望 public skill 所有 Pod 共享、private skill 每用户私有，以便公共能力统一发布且用户扩展互不影响。 | P0 |
| US-04 | 作为架构负责人，我希望底层 Agent 在 OpenClaw/Hermes 之间切换时不用重写业务登录逻辑，以便降低后续切换成本。 | P0 |
| US-05 | 作为用户，我希望业务平台登录态准备失败时能收到明确反馈，以便知道是稍后重试、联系管理员还是平台异常。 | P0 |
| US-06 | 作为运维人员，我希望系统不存储密码或 token 持久明文，日志不出现 Cookie/token，以便降低凭证泄露风险。 | P0 |

---

## 4. 功能需求

### 4.1 功能清单

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-01 | session-manager core | 提供平台登录态获取、缓存、刷新、锁、文件读写、状态返回等核心逻辑，独立于具体 Agent。 | P0 | US-02, US-04 |
| FEAT-02 | Agent 适配层 | OpenClaw 通过 plugin/tool 或 CLI wrapper 暴露；Hermes 通过 Python plugin `ctx.register_tool` 暴露。 | P0 | US-02, US-04 |
| FEAT-03 | Public/Private Skill 分层 | public skill 从共享只读 PVC 加载；private skill 存在每用户 State PVC，和用户 session-store 同生命周期。 | P0 | US-03 |
| FEAT-04 | 平台登录态适配 | 每个平台提供独立适配模块，调用 token API -> cookie API，返回 Cookie、expiresAt、可选 storageState。 | P0 | US-01, US-02 |
| FEAT-05 | Session Store 持久化 | 按用户、平台、账号维度写入 State PVC，Pod 重建后优先复用。 | P0 | US-01 |
| FEAT-06 | 流畅体验保障 | 支持预热、懒加载、超时、singleflight 锁、stale-if-error、结构化错误，保证用户不会无反馈卡住。 | P0 | US-05 |
| FEAT-07 | 浏览器登录态注入 | 对浏览器类 skill 输出 Playwright storageState 或等价浏览器 profile 登录态。 | P1 | US-02 |
| FEAT-08 | 安全日志与状态 | 记录登录成功、失败、复用、刷新、超时等事件；日志脱敏，不记录 Cookie/token 明文。 | P0 | US-06 |

### 4.2 关键功能验收

#### FEAT-01: session-manager core

- **描述**: 将平台登录、缓存、刷新、锁、存储等逻辑放在独立 core 中，OpenClaw 与 Hermes 只做适配。
- **验收标准**:
  - [ ] core 可通过 CLI 以 JSON 输入/输出调用。
  - [ ] core 不依赖 OpenClaw/Hermes 的插件 API。
  - [ ] core 支持 `get-state`、`refresh`、`status`、`clear` 四类动作。
  - [ ] core 返回结构化状态，不通过自然语言 stdout 让 Agent 猜。

#### FEAT-02: Agent 适配层

- **描述**: 为不同 Agent 提供薄适配。
- **验收标准**:
  - [ ] OpenClaw 适配暴露 `session_get_state` 等 tool，或通过固定 CLI wrapper 调用 core。
  - [ ] Hermes 适配以 plugin 方式注册 `session_get_state` 等 tool。
  - [ ] 适配层只负责参数校验、路径注入、调用 core、返回 tool 结果，不复制平台登录逻辑。
  - [ ] 切换 Agent 后 session-store 目录结构保持兼容。

#### FEAT-03: Public/Private Skill 分层

- **描述**: 公共能力统一发布，用户私有能力独立保存。
- **验收标准**:
  - [ ] OpenClaw public skill 可通过 `skills.load.extraDirs` 指向共享目录。
  - [ ] OpenClaw private skill 位于用户 workspace skills 目录，并落 State PVC。
  - [ ] Hermes public skill 可通过 `skills.external_dirs` 指向共享目录。
  - [ ] Hermes private skill 位于 `~/.hermes/skills`，并落 State PVC。
  - [ ] 共享 public skill 目录在 K8s 中只读挂载。

#### FEAT-04: 平台登录态适配

- **描述**: 平台适配模块负责调用对应业务系统 token/cookie API。
- **验收标准**:
  - [ ] 平台适配输入包含 `platform`、`svcAccount`、`account`、`userId`。
  - [ ] 平台适配输出包含 Cookie、expiresAt，必要时包含 storageState。
  - [ ] token 仅在内存中短暂存在，不写入 session-store 和日志。
  - [ ] 新增平台只新增平台模块和配置映射，不改业务 skill。

#### FEAT-05: Session Store 持久化

- **描述**: 每用户 Worker Pod 的 State PVC 保存登录态。
- **验收标准**:
  - [ ] 默认路径为 `/home/node/.agent-session-store/{platform}/{account}/`。
  - [ ] 兼容 OpenClaw 路径 `/home/node/.openclaw/session-store/`。
  - [ ] 兼容 Hermes 路径 `/home/node/.hermes/session-store/`。
  - [ ] 文件权限为当前运行用户可读写，避免跨用户共享。
  - [ ] 文件损坏时清理并重新刷新。

#### FEAT-06: 流畅体验保障

- **描述**: 平台异常时不能让用户无反馈卡住。
- **验收标准**:
  - [ ] cache 读取默认超时不超过 1s。
  - [ ] 单次刷新默认超时不超过 20s。
  - [ ] 同一用户同一平台同一账号并发刷新只触发一次实际刷新。
  - [ ] 刷新失败且旧登录态未明确失效时，可返回 `source=stale`。
  - [ ] 无可用登录态时返回明确错误：`platform_unavailable`、`credential_error`、`timeout`、`not_configured`。
  - [ ] 高频平台支持 Worker 启动后或首次任务前预热。

#### FEAT-07: 浏览器登录态注入

- **描述**: 对需要浏览器访问的业务 skill，输出 Playwright storageState。
- **验收标准**:
  - [ ] 支持 `mode=cookie` 与 `mode=storage_state`。
  - [ ] storageState 写入 State PVC。
  - [ ] 浏览器类 skill 使用指定 profile/storageState 后可直接访问目标平台。

#### FEAT-08: 安全日志与状态

- **描述**: 提供可观测性，不泄露凭证。
- **验收标准**:
  - [ ] 事件包含 `session.cache_hit`、`session.refresh_success`、`session.refresh_failed`、`session.timeout`、`session.stale_used`。
  - [ ] 日志字段包含 userId、platform、account、event、status、errorCode、durationMs、timestamp。
  - [ ] 日志不包含 Cookie、token、Set-Cookie 原文或可还原片段。

### 4.3 边缘情况

| 场景 | 预期行为 |
|------|----------|
| 平台适配不存在 | 返回 `not_configured`，提示管理员补充平台适配。 |
| token API 认证失败 | 返回 `credential_error`，不重试无意义认证失败。 |
| token/cookie API 网络超时 | 按重试策略刷新，超过预算返回 `platform_unavailable` 或 `timeout`。 |
| Pod 删除重建 | 从 State PVC 加载 session-store，登录态有效则复用。 |
| session-store 文件损坏 | 移到隔离文件或删除，重新刷新。 |
| 同平台并发请求 | singleflight/文件锁，其他请求等待同一次刷新结果。 |
| Agent 切换 | 适配层变化，core 与 session-store 不迁移或只做路径兼容。 |
| public/private skill 同名 | 不依赖同名覆盖，要求命名唯一或使用分类路径。 |

---

## 5. 非功能需求

| 指标ID | 类型 | 要求 |
|--------|------|------|
| NFR-SEC-01 | 安全 | 不存储服务账号密码或 token 持久明文；Cookie/storageState 仅写入当前用户 State PVC。 |
| NFR-SEC-02 | 安全 | Public Skills PVC 只读挂载，避免运行时被业务 skill 或 Agent 改写。 |
| NFR-SEC-03 | 安全 | 日志、错误、审计事件不得包含 Cookie/token 明文。 |
| NFR-REL-01 | 可用性 | 所有外部调用必须有超时，失败必须返回结构化错误。 |
| NFR-REL-02 | 可用性 | 登录态刷新失败不能导致 Agent 无限等待；用户必须收到可理解反馈。 |
| NFR-REL-03 | 可用性 | Pod 重建后优先复用 State PVC 登录态，减少平台 API 压力。 |
| NFR-COMPAT-01 | 兼容性 | 核心逻辑与 Agent 插件机制解耦，支持 OpenClaw/Hermes 双适配。 |
| NFR-OPS-01 | 运维 | 支持预热和状态查询，便于定位平台不可达、凭证失败、缓存失效。 |

---

## 6. 范围与边界

| 类别 | 内容 |
|------|------|
| 范围（In Scope） | session-manager core；OpenClaw/Hermes 适配；public/private skill 分层；Session Store；平台登录态适配；浏览器 storageState；超时/锁/预热/降级；安全日志。 |
| 非范围（Out of Scope） | Console 凭证管理 UI/API；DB 表变更；业务平台 token/cookie API 开发；绕过验证码的自动化登录；跨用户共享 Cookie；长期 token 托管。 |
| 前置假设 | 业务平台提供 token API 与 cookie API；用户 ID 到 svcAccount 的派生规则已确认；Worker Pod 具备访问业务系统网络；State PVC 每用户隔离；Public Skills PVC 可只读挂载。 |

---

## 7. 依赖与风险

### 7.1 项目依赖

| 依赖方 | 依赖内容 | 风险等级 |
|--------|----------|---------|
| 业务平台团队 | 提供 token API、cookie API、health check 或登录态校验方式 | 高 |
| OpenClaw 运行时 | 支持 public/private skill 加载、plugin/tool 或 CLI wrapper 调用 | 中 |
| Hermes 运行时 | 支持 `skills.external_dirs`、`~/.hermes/skills`、plugin tool 安装启用 | 中 |
| K8s 平台 | State PVC per user、Public Skills PVC readOnly、Worker 启动预热 | 中 |
| 镜像环境 | Node/Python/Playwright/Chromium 或 session-manager CLI 运行依赖 | 中 |

### 7.2 风险识别

| 风险ID | 描述 | 影响 | 缓解方案 |
|--------|------|------|---------|
| RISK-01 | 业务平台 token/cookie API 变更 | 登录态刷新失败 | 平台适配模块独立维护；状态查询和日志快速定位。 |
| RISK-02 | 外部平台异常导致用户等待 | 用户体验差 | 超时、结构化错误、stale-if-error、预热。 |
| RISK-03 | Public Skills PVC 可写 | 公共 skill 被误改或污染 | K8s readOnly 挂载；只允许发布流程更新。 |
| RISK-04 | OpenClaw/Hermes 插件机制不同 | 重复开发 | core 一套，Agent adapter 两套薄封装。 |
| RISK-05 | Cookie/storageState 泄露 | 安全事故 | State PVC 隔离、权限控制、日志脱敏、禁止跨用户共享。 |
| RISK-06 | 同名 public/private skill 冲突 | 加载结果不稳定或 ambiguous | 命名规范要求唯一；使用分类路径。 |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| Session Manager | 负责获取、缓存、刷新、持久化业务系统登录态的能力集合。 |
| session-manager core | 独立于 Agent 的核心逻辑，可通过 CLI/库调用。 |
| Agent Adapter | OpenClaw/Hermes 侧的薄适配层，负责把 core 暴露为对应 tool/plugin。 |
| Public Skill | 所有 Worker Pod 共享的公共 skill，来自共享只读 PVC。 |
| Private Skill | 当前用户私有 skill，保存于用户 State PVC。 |
| Session Store | 保存 Cookie/storageState/meta/lock 的用户私有目录。 |
| storageState | Playwright 可加载的浏览器登录态文件。 |
| svcAccount | 服务账号标识，默认由 `{userId}@skill.sangfor.com` 派生。 |
| stale-if-error | 刷新失败时，在旧登录态未明确失效的情况下临时返回旧登录态。 |

---

*文档结束*

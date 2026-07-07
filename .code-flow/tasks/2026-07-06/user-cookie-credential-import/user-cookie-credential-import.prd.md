# PRD: Skill 服务账号鉴权与浏览器会话管理

> **文档编号**: PRD-2026-07-06-01
> **文档版本**: v0.3
> **创建日期**: 2026-07-06
> **修订日期**: 2026-07-07
> **产品负责人**:
> **状态**: 草稿

**评审边界说明**:
- **需求基线**: 第 2-6 章（背景/用户/功能/非功能/范围）→ 通过后锁定
- **设计输入**: 第 3-6 章 → 为 `cf-task:align` 提供 US / FEAT / NFR / 范围

**ID 体系**: US（用户故事）、FEAT（功能）、NFR（非功能指标）

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

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-07-06 | Codex | 初始草稿（Cookie 导入方案） |
| v0.2 | 2026-07-07 | Codex | 方案变更为服务账号 + token API 交换 |
| v0.3 | 2026-07-07 | Codex | 简化为 session-manager + 插件式登录脚本，Console 侧零改动，无需 DB 表 |

---

## 2. 背景与目标

### 2.1 问题陈述

| 维度 | 内容 |
|------|------|
| **问题描述** | 集中化部署后，skill 运行在服务器 Pod 内，无法访问用户本地浏览器的登录态（Cookie）。skill 需要通过浏览器操作或 API 调用业务平台（如 MSS/SOAR）时，缺乏合法的鉴权凭证。 |
| **当前替代方案** | 无。集中化部署之前，skill 运行在用户本地，直接复用本地浏览器 Cookie。 |
| **业务平台约束** | 一个用户账号只允许一个浏览器 session（多端登录互踢），且登录页有验证码和多步校验，无法通过 headless Chromium 自动化登录。 |
| **业务平台能力** | 业务平台提供 token API（用服务账号 userId 换取一次性 token）和 cookie API（用 token 换取 session cookie）。纯 API 调用，无需经过浏览器登录页。 |
| **触发原因** | 通过 session-manager 共享 skill + 插件式登录脚本，每个平台对接只需一个脚本文件，无需密码存储、无需 Console 改造。 |

### 2.2 目标与价值

| 维度 | 内容 |
|------|------|
| **核心目标** | 实现 session-manager 共享 skill，通过插件式登录脚本（`platforms/{platform}.mjs`）调用业务平台 token API → cookie API 获取 Cookie、持久化到 PVC，并为对应 skill 提供可用 Cookie。Console 侧无需新增任何功能。 |
| **预期价值** | 无需存储密码、无需数据库变更、无需 Console UI/API 改动；登录脚本由 session-manager 统一管理，新增平台对接只需一个脚本文件；Cookie 持久化到 PVC，Pod 重启可恢复。 |

**成功指标**

| 指标 | 当前值 | 目标值 | 衡量方式 |
|------|--------|--------|----------|
| session-manager 获取 Cookie | 不可用 | skill 调用 session-manager 后获得有效 Cookie | 端到端验收 |
| Pod 重启后 Cookie 恢复 | 不可用 | Pod 重建后加载 PVC session-store，Cookie 有效则直接复用 | 删除 pod 后确认复用 |
| 新增平台对接成本 | 不存在 | 只需新增 `platforms/{platform}.mjs`，无需改 Console 或 DB | 新增一个平台验收 |
| 无密码存储 | 存在风险 | 整个系统不存储任何服务账号密码、token 或 Cookie 持久明文 | 安全检查 |

---

## 3. 用户与场景

### 3.1 目标用户

| 维度 | 内容 |
|------|------|
| **用户画像** | 通过企微使用 Claw skill 的终端用户。管理员负责安装 skill 和维护 session-manager 的登录脚本，不参与日常凭证管理。 |
| **使用场景** | 管理员在共享 skills PVC 中部署 session-manager 及对应平台的登录脚本 → 用户在企微触发 skill → skill 调用 session-manager → session-manager 通过登录脚本获取 Cookie → 返回给 skill；Cookie 持久化到用户 PVC session-store，重启自动恢复。 |

### 3.2 用户故事

| 编号 | 用户故事 | 优先级 |
|------|---------|--------|
| US-01 | 作为 skill 开发者，我希望在 session-manager 中新增一个平台登录脚本即可支持新业务平台，以便快速对接不同的外部系统。 | P0 |
| US-02 | 作为 skill 开发者/用户，我希望 skill 调用 session-manager 即可按 service 获取有效 Cookie，以便 skill 无需关心鉴权细节。 | P0 |
| US-03 | 作为 skill 开发者/用户，我希望 Pod 重启后浏览器登录态能从 PVC 恢复，以便短暂中断不影响 skill 可用性。 | P0 |
| US-04 | 作为平台运维人员，我希望系统不存储任何服务账号密码或 token 明文，以便降低凭证泄露风险。 | P0 |

---

## 4. 功能需求

### 4.1 功能清单

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源用户故事 |
|--------|---------|---------|--------|-------------|
| FEAT-01 | 插件式登录脚本框架 | session-manager 按 `platform` 加载 `platforms/{platform}.mjs`，传入 `svcAccount`（`{userId}@skill.sangfor.com`），脚本负责调 token API → cookie API 并返回 Cookie。 | P0 | US-01 |
| FEAT-02 | Cookie 持久化与缓存 | session-manager 将 Cookie 按 service 写入 PVC session-store，Pod 重启可恢复；内存缓存加速本次生命周期返回。 | P0 | US-02, US-03 |
| FEAT-03 | Cookie 有效性管理 | 返回前验证 Cookie 有效性（过期检查 + 可选 health check 探测），失效自动触发重新登录。 | P0 | US-02 |
| FEAT-04 | 对外函数契约 | 对业务 skill 暴露统一接口：入参 `{ platform }`、出参 `{ cookie, source }`，不暴露 token/cookie API 细节。 | P0 | US-02 |
| FEAT-05 | 浏览器 Cookie 注入 | 可将 Cookie 注入 Chromium user-data-dir（Playwright storageState），浏览器类 skill 用同一 profile 即为登录态。 | P1 | US-02 |
| FEAT-06 | 登录审计上报 | 上报登录成功/失败、Cookie 复用等事件到 Console 审计日志；不含 Cookie 或 token 明文。 | P0 | US-04 |

#### FEAT-01: 插件式登录脚本框架

- **描述**: session-manager 按 `platform` 参数加载 `platforms/{platform}.mjs`，脚本内硬编码 tokenApi/cookieApi 调用逻辑。
- **验收标准**:
  - [ ] 脚本路径约定：`platforms/{platform}.mjs`，由 session-manager 统一管理。
  - [ ] 脚本导出：`export async function login(svcAccount: string): Promise<{cookie, expiresAt}>`。
  - [ ] `svcAccount = "{userId}@skill.sangfor.com"` 由 session-manager 派生传入。
  - [ ] 新增平台只需新增一个脚本文件，不改 session-manager 核心代码。

#### FEAT-02: Cookie 持久化与缓存

- **描述**: Cookie 写入 PVC，重启可恢复；内存缓存加速返回。
- **验收标准**:
  - [ ] 写入 `/home/node/.openclaw/session-store/{service}/cookies.json`。
  - [ ] 写入 `/home/node/.openclaw/session-store/{service}/meta.json`（source、expiresAt、lastCheckedAt）。
  - [ ] Pod 重建后优先加载 session-store 中有效 Cookie。
  - [ ] 文件权限：仅 node 用户可读写。

#### FEAT-03: Cookie 有效性管理

- **描述**: 返回 Cookie 前检查有效性。
- **验收标准**:
  - [ ] 检查 `expiresAt` 是否已过期。
  - [ ] 可选 `healthCheckUrl` 探测目标平台是否仍接受该 Cookie。
  - [ ] 失效时自动触发重新登录。

#### FEAT-04: 对外函数契约

- **描述**: 对业务 skill 暴露统一接口。
- **验收标准**:
  - [ ] 入参：`{ platform: "soar" }`。
  - [ ] 成功出参：`{ cookie: "JSESSIONID=...", source: "cache" | "login" }`。
  - [ ] 错误出参：`{ error: "not_configured" | "auth_failed" | "network_unreachable" }`。

#### FEAT-05: 浏览器 Cookie 注入

- **描述**: 将 Cookie 注入 Chromium profile，浏览器类 skill 直接使用。
- **验收标准**:
  - [ ] 通过 Playwright `storageState` API 写入 Chromium user-data-dir。
  - [ ] skill 用同一 profile 打开浏览器即为已登录态。

#### FEAT-06: 登录审计上报

- **描述**: 登录行为上报 Console 审计日志。
- **验收标准**:
  - [ ] 事件类型：`login.success`、`login.failed`、`cookie.reused`。
  - [ ] 审计字段：userId、svcAccount、service、event、result、errorCode、timestamp。
  - [ ] 审计记录不含 Cookie、token 明文或可还原片段。

---

### 4.2 边缘情况

| 场景 | 预期行为 |
|------|----------|
| 平台登录脚本不存在 | session-manager 返回 `not_configured` |
| token API 返回认证失败 | 返回 `auth_failed`，上报审计 |
| token API 或 cookie API 不可达 | 退避重试（间隔递增）；连续失败后返回 `network_unreachable` |
| Pod 删除重建 | 加载 PVC session-store；Cookie 有效则复用，无效则重新登录 |
| session-store 文件损坏 | 清理损坏文件，重新调登录脚本 |
| 同一 service 并发请求 | 文件锁或内存锁，避免并发触发多次登录 |

---

## 5. 非功能需求

| 指标ID | 类型 | 要求 |
|--------|------|------|
| NFR-SEC-01 | 安全 | 系统不存储服务账号密码、token 持久明文或 Cookie 持久明文；审计日志不含 Cookie/token 明文。 |
| NFR-SEC-02 | 安全 | session-store 文件仅当前用户 Pod 可访问（PVC 隔离 + node 用户权限）。 |
| NFR-REL-01 | 可用性 | 登录失败时给出可操作错误码，通知用户或管理员。 |
| NFR-REL-02 | 可用性 | Pod 重建后 Cookie 恢复成功率 >= 90%（排除密码变更等不可控因素）。 |
| NFR-COMPAT-01 | 兼容性 | 登录脚本接口与 session-manager 框架解耦，脚本独立维护。 |

---

## 6. 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | session-manager 共享 skill（插件式登录脚本框架）；Cookie 持久化（PVC session-store）；Cookie 有效性管理；浏览器 Cookie 注入；登录审计上报。 |
| **非范围（Out of Scope）** | Console 凭证管理 UI/API；数据库表变更（无 user_credentials、service_registry 等）；BuildEnv 扩展注入凭证配置；服务账号密码存储。 |
| **前置假设** | 业务平台提供 token API（user_id -> 一次性 token）和 cookie API（token -> cookie）；服务账号命名 `{userId}@skill.sangfor.com` 经业务平台团队确认；Pod 已有 headless Chromium + Playwright；session-manager 通过共享 skills PVC 分发。 |

---

## 7. 依赖与风险

### 7.1 项目依赖

| 依赖方 | 依赖内容 | 风险等级 |
|--------|----------|---------|
| 业务平台团队 | 提供 token API + cookie API | 高 |
| openclaw skill 机制 | session-manager 以 skill 形态运行 | 低（已验证） |
| Docker 镜像 | headless Chromium + Playwright | 低（已内置） |

### 7.2 风险识别

| 风险ID | 描述 | 影响 | 缓解方案 |
|--------|------|------|---------|
| RISK-01 | 业务平台 token/cookie API 接口变更 | session-manager 对应登录脚本失效 | 脚本按平台独立维护；API 变更由业务平台团队提前通知 |
| RISK-02 | 服务账号并发 token 请求被限流 | 首次全量 Pod 同时请求 token | 首次登录加随机延迟；已有 session 不复调 API |
| RISK-03 | session-store Cookie 泄露 | 用户 PVC 被非授权访问 | PVC per user 隔离 + node 用户权限 + 不存 token 明文 |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| Session Manager | Pod 内共享 skill，负责通过登录脚本获取 Cookie、持久化、缓存和有效性管理。 |
| 登录脚本 | `platforms/{platform}.mjs`，由 session-manager 统一管理，硬编码 tokenApi/cookieApi 调用逻辑。 |
| Session Store | PVC 中 Cookie 快照路径：`/home/node/.openclaw/session-store/{service}/cookies.json`。 |
| svcAccount | 服务账号标识，如 `53842@skill.sangfor.com`，由 `{userId}@skill.sangfor.com` 派生。 |

---

*文档结束*

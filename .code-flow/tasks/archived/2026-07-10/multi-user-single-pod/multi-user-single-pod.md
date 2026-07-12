# Tasks: Multi-User Single-Pod

- **Source**: `.code-flow/tasks/2026-07-10/multi-user-single-pod/multi-user-single-pod.design.md`
- **Created**: 2026-07-11
- **Updated**: 2026-07-11

## Proposal

将当前“一用户一容器”的控制面和运行时重构为“一个 Pod 承载最多 10 个 Human User”，以稳定的 agent、IM identity、Browser Profile 和私有状态实现逻辑隔离。同步引入绑定码、业务平台凭证、session-manager、Runtime Guard 和配置调和机制，在不 fork OpenClaw 上游代码的前提下完成多 IM 路由、凭证隔离、浏览器隔离和可回滚部署。开发阶段直接重建数据库，不实现旧 `users` 数据和旧 API 语义迁移。

---

## TASK-001: 补齐多用户运行时默认配置

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `multi-user-single-pod.design.md#3.3.2 pods`, `multi-user-single-pod.design.md#3.5.9 当前代码改造范围`

### Description
在 Console 配置中增加 Skill、Browser 并发和 Browser 端口范围等多用户运行时默认值，保持 YAML、环境变量和默认值的覆盖规则一致。

### Checklist
- [x] 定义 `runtimeDefaults` 配置结构、开发期安全默认值和环境变量映射
- [x] 校验并发值、端口范围和继承语义，拒绝无效配置
- [x] 确保配置结构不包含 service token、API key 等 secret
- [x] 补充默认值、覆盖优先级和非法值测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-002: 重建 SQLite Schema 和领域模型

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: `multi-user-single-pod.design.md#3.3 数据设计`, `multi-user-single-pod.design.md#4.4 数据重建`

### Description
删除旧 `users` 语义并建立 Pod、Human User、Identity、Binding Code 和 Platform Config 数据模型，同时保留管理员、审计、全局模型和全局资源表。

### Checklist
- [x] 创建 `pods`、`human_users`、`user_identities`、`binding_codes`、`platform_configs` 表和索引
- [x] 定义对应 Go 模型、状态枚举和时间字段转换
- [x] 保持 `foreign_keys=ON`、WAL 和 `busy_timeout=5000` 的统一连接初始化
- [x] 删除旧 `users` 表依赖且不实现旧数据迁移
- [x] 补充 schema、CHECK、复合外键、级联删除和测试库 pragma 测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-003: 实现 Pod、服务令牌和配置代次 Repository

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `multi-user-single-pod.design.md#3.3.2 pods`, `multi-user-single-pod.design.md#3.5.1 Repository`

### Description
实现 Pod 聚合根的数据访问、分页容量统计、service token 生命周期和 generation 条件更新，替代旧 User Repository。

### Checklist
- [x] 实现 Pod CRUD、分页筛选和单次聚合容量统计
- [x] 生成并加密保存 Pod service token，保存完整 fingerprint 并恒定时间校验
- [x] 实现配置 pending、applying、applied、failed 的 generation 条件更新
- [x] 实现 token 查询和轮换所需的 Repository 原语
- [x] 补充 CRUD、分页、token 校验和过期 generation 防覆盖测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-004: 实现 Human User 容量、端口和生命周期 Repository

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003
- **Source**: `multi-user-single-pod.design.md#3.3.3 human_users`, `multi-user-single-pod.design.md#3.5.7 生命周期与状态清理`

### Description
实现 Human User 的不可变运行时标识、稳定 Browser CDP 端口、Pod 容量控制和状态迁移。

### Checklist
- [x] 使用安全随机 UUID 创建用户并校验 agent/profile 保留名与格式
- [x] 在 `BEGIN IMMEDIATE` 中分配稳定 CDP 端口并检查 Pod 容量
- [x] 实现 pending、active、disabled、deleting 状态迁移和物理删除前置条件
- [x] 为列表提供分页、状态和名称筛选且排除 deleting 容量
- [x] 补充并发创建、端口冲突、重新启用和降低容量上限测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-005: 实现 IM Identity Repository

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: `multi-user-single-pod.design.md#3.3.4 user_identities`, `multi-user-single-pod.design.md#3.5.1 Repository`

### Description
以 Pod、OpenClaw channel、account、peer kind 和原始 external ID 为作用域管理 IM 身份，并保持 Human User 为唯一 agent 事实源。

### Checklist
- [x] 实现 Identity 创建、查询、启禁用和删除
- [x] 保留 external ID 原始大小写并执行 scoped unique 约束
- [x] 删除或禁用最后一个 active identity 时将用户转为 pending
- [x] 补充跨 account/channel 可复用、同作用域冲突和状态联动测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-006: 实现绑定码密码学和原子激活事务

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-005
- **Source**: `multi-user-single-pod.design.md#3.3.5 binding_codes`, `multi-user-single-pod.design.md#3.4.3 Identity / Binding Code API`

### Description
实现一次性绑定码的安全生成、HMAC 存储、生命周期管理和 Identity 原子激活，明文绑定码只在创建时返回一次。

### Checklist
- [x] 生成 `MUAD-` 加 8 位无歧义安全随机码并规范化输入
- [x] 从 Console master key 域隔离派生 HMAC key，只保存 hash 和 hint
- [x] 实现创建、列表、吊销、过期和失败计数 Repository 方法
- [x] 在单个 `BEGIN IMMEDIATE` 中完成激活、Identity 创建、用户状态和 generation 更新
- [x] 补充重放、过期、错 Pod/account、唯一冲突和五次失败吊销测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-007: 实现平台配置和用户平台凭证 Repository

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-004
- **Source**: `multi-user-single-pod.design.md#3.3.3 human_users`, `multi-user-single-pod.design.md#3.3.6 platform_configs`

### Description
实现轻量业务平台配置，以及 Human User 加密 JSON 数组中的单平台 API key 增删改查和解析。

### Checklist
- [x] 实现平台创建、列表、更新、启禁用和 platform 名称校验
- [x] 校验镜像支持的 adapter，seed 首期业务平台但不动态安装代码
- [x] 在 `BEGIN IMMEDIATE` 中完成凭证数组解密、修改、加密和写回
- [x] 列表仅返回 fingerprint、更新时间和平台状态，Resolver 才可短暂取得明文
- [x] 补充空密文、解密失败、并发覆盖、禁用平台和凭证删除测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-008: 建立类型化审计事件和脱敏规则

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002
- **Source**: `multi-user-single-pod.design.md#3.3.7 保留或调整的现有表`, `multi-user-single-pod.design.md#4.3 监控与审计`

### Description
在保留现有审计表的基础上增加 Pod、用户、身份、凭证、绑定、配置调和和 Guard 语义事件，避免只从 URL 推断 target。

### Checklist
- [x] 定义事件名、管理员和 `pod:<pod_id>` actor 规则
- [x] 提供类型化审计 helper 并与通用 HTTP 审计去重
- [x] metadata 仅记录 ID、状态和 fingerprint，禁止 secret/Cookie/绑定码明文
- [x] 补充事件字段、脱敏和重复事件测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-009: 定义 PodSpec 和版本化 Runtime DTO

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-003, TASK-004, TASK-005, TASK-007
- **Source**: `multi-user-single-pod.design.md#3.2 架构设计`, `multi-user-single-pod.design.md#3.5.3 Driver / Runtime`

### Description
将 Driver 和配置渲染输入从旧 UserSpec 迁移为 PodSpec，并定义 Go/Node 共用的版本化多用户 Runtime DTO 契约。

### Checklist
- [x] 定义 Pod、agent、route、profile、provider、平台和并发 DTO
- [x] 定义 Secret 文件和 Driver apply/restart/cleanup 能力契约
- [x] 移除业务调用中的旧 UserSpec 和 userId 等于容器 ID 的语义
- [x] 补充 DTO 序列化、版本拒绝和 Driver fake 编译契约测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-010: 改造 Docker Driver 的 Secret 和状态卷策略

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-009
- **Source**: `multi-user-single-pod.design.md#3.5.3 Driver / Runtime`, `multi-user-single-pod.design.md#3.5.7 生命周期与状态清理`

### Description
让 Docker Driver 消费 PodSpec，通过私有宿主目录只读挂载 service token，并显式处理状态卷 retain、delete 和 adopt。

### Checklist
- [x] 将容器创建、更新和查询接口迁移到 PodSpec
- [x] 创建权限受控的 token 文件并只读挂载到固定容器路径
- [x] 在删除和轮换时清理旧 token 文件，避免出现在 env、命令行和日志
- [x] retained volume 默认拒绝同名 Pod 自动接管并提供显式 adopt 原语
- [x] 使用 fake command/helper 补充权限、挂载、清理和 retain 冲突测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-011: 改造 Kubernetes Driver 的 Secret 和 PVC 策略

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-009
- **Source**: `multi-user-single-pod.design.md#3.5.3 Driver / Runtime`, `multi-user-single-pod.design.md#4.1 部署架构`

### Description
让 Kubernetes Driver 使用 namespace Secret volume 注入 service token，并补齐 PVC retain、防自动复用和显式 adopt 行为。

### Checklist
- [x] 将 Deployment、Service 和 PVC 生成逻辑迁移到 PodSpec
- [x] 创建并挂载 Pod 专属 Secret，固定路径、只读权限和 runtime UID/GID
- [x] 实现 token 轮换、资源清理以及 retained PVC 所有权标记
- [x] 同名新 Pod 遇到 retained PVC 时返回冲突，显式 adopt 才可继续
- [x] 补充 manifest、权限、轮换、删除策略和 adopt 测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-012: 迁移采集、缓存和监控到 Pod 语义

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-003, TASK-009
- **Source**: `multi-user-single-pod.design.md#3.4.6 LLM / Resource API 兼容调整`, `multi-user-single-pod.design.md#4.3 监控与审计`

### Description
将运行状态缓存、资源采集和告警指标从旧 userId 迁移为 podId，并使用 Pod 有效资源限制计算阈值。

### Checklist
- [x] 统一 collector、monitor cache 和 probe 的 podId key
- [x] 聚合用户容量、Skill/Browser 并发、排队和 generation lag 指标
- [x] 按 Pod 覆写或全局默认资源计算有效告警阈值
- [x] 补充缓存隔离、资源继承和指标聚合测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-013: 构建稳定的多用户 Runtime 配置 DTO

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-005, TASK-007, TASK-009
- **Source**: `multi-user-single-pod.design.md#3.2.1 运行时路由原则`, `multi-user-single-pod.design.md#3.5.2 API / Helper`

### Description
从数据库聚合单 Pod 的完整 Runtime DTO，稳定排序 agent、路由、profile、provider 和平台映射，并计算 canonical hash。

### Checklist
- [x] 聚合 main、业务 agent、active routes、identityLinks 和稳定 Browser Profile
- [x] 生成 per-user 模型 provider alias 和 session-manager/Guard 映射
- [x] 排除 disabled/deleting 用户并保留 pending agent 的预创建状态
- [x] 对所有列表和 map 执行确定性排序后计算 canonical hash
- [x] 补充乱序输入幂等、同厂商多 key、channel alias 和非法状态测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-014: 实现严格的多用户 OpenClaw 配置注入器

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-013
- **Source**: `multi-user-single-pod.design.md#3.2.2 OpenClaw 配置渲染原则`, `multi-user-single-pod.design.md#3.5.4 注入脚本`

### Description
新增 Node 注入脚本作为 Runtime DTO 到 OpenClaw strict config 的唯一转换器，避免 Go 和 Node 双重 schema 实现。

### Checklist
- [x] 从 env 或 stdin 解析同一版本 DTO 并拒绝未知版本和无效字段
- [x] 渲染 main、业务 agent、strict bindings、identityLinks 和 channel alias
- [x] 渲染 quarantine 默认 profile、稳定用户 profile、provider alias 和工具边界
- [x] 显式启用三个外置插件并写入 session-manager/Guard 运行配置
- [x] 补充 stable JSON/hash、strict schema、profile、route 和插件配置 fixture 测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-015: 将启动注入脚本改为兼容入口

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-014
- **Source**: `multi-user-single-pod.design.md#3.5.4 注入脚本`, `multi-user-single-pod.design.md#3.5.9 当前代码改造范围`

### Description
收敛现有 `inject-env.mjs` 的职责，使启动和运行中应用均调用同一多用户转换器。

### Checklist
- [x] 让旧脚本只收集 Runtime DTO、路径和启动上下文
- [x] 移除独立 bindings/provider/profile 拼装逻辑
- [x] 保持现有容器入口兼容并显式传播转换错误
- [x] 补充 env 与 stdin 等价、错误退出和启动兼容测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-016: 实现配置应用、健康检查和原子回滚

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-008, TASK-010, TASK-011, TASK-014
- **Source**: `multi-user-single-pod.design.md#3.5.3 Driver / Runtime`, `multi-user-single-pod.design.md#4.2 发布与回滚`

### Description
提供一次配置应用执行能力，完成临时文件校验、原子替换、差异化重启、Gateway/插件健康检查和失败回滚。

### Checklist
- [x] 用临时配置执行 `openclaw config validate` 并保留上一有效版本
- [x] 根据变更类型选择 Gateway 重启或完整 Pod 重启
- [x] 调用 Gateway 和 `muad.runtime.health` 校验目标 generation
- [x] 失败时恢复旧配置并重新启动，返回结构化 apply error
- [x] 使用 fake driver 补充 validate、重启、健康失败和回滚测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-017: 实现按 Pod 串行的配置调和协调器

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-016
- **Source**: `multi-user-single-pod.design.md#3.5.2 API / Helper`, `multi-user-single-pod.design.md#3.5.3 Driver / Runtime`

### Description
实现每 Pod 单队列、请求合并和 generation 防陈旧写的 Runtime apply coordinator，并支持 Console 重启后的自动恢复。

### Checklist
- [x] 队列只投递 podId，执行时重新读取最新 generation 和 DTO
- [x] 同 Pod 串行合并请求，不同 Pod 允许并行
- [x] 使用 generation 条件更新 apply 状态，旧任务不得覆盖新结果
- [x] 启动时扫描未收敛 Pod 并有界重试 pending/applying/failed generation
- [x] 补充队列合并、并行隔离、陈旧任务和重启恢复测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-018: 建立新 API 路由、错误码和内部令牌鉴权

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-008
- **Source**: `multi-user-single-pod.design.md#3.4 接口设计`, `multi-user-single-pod.design.md#3.5.2 API / Helper`

### Description
为管理员 API 和 Pod 内部 API 建立统一路由、响应和错误映射，内部请求只能通过 service token 确定 Pod。

### Checklist
- [x] 注册 Pod、Human User、Identity、Binding、Platform 和 internal 路由骨架
- [x] 实现 Bearer token 解析、fingerprint 候选查询和恒定时间最终校验
- [x] 请求体禁止覆盖 token 确定的 podId，轮换后旧 token 立即失效
- [x] 全部 handler 通过 `writeJSON`/`writeErr` 输出并补鉴权和错误码测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-019: 实现 Pod CRUD、分页、详情和通道 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-009, TASK-013, TASK-017, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.4.1 Pod API`, `multi-user-single-pod.design.md#3.5.9 当前代码改造范围`

### Description
将 `/containers` 调整为 Pod 管理入口，提供容量、运行状态、通道和配置收敛状态。

### Checklist
- [x] 实现 Pod 列表、创建、详情、更新和显式 PVC 删除策略
- [x] 实现通道配置的加密写入、脱敏读取和 channel alias 校验
- [x] 返回用户数、可用槽位、Driver 派生状态和 generation 状态
- [x] 容量下调在事务中校验且 retained PVC 冲突返回明确错误
- [x] 使用 httptest 和 fake driver 补充分页、CRUD、脱敏和冲突测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-020: 实现 Pod 生命周期和运维 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-010, TASK-011, TASK-019
- **Source**: `multi-user-single-pod.design.md#3.4.1 Pod API`, `multi-user-single-pod.design.md#3.5.7 生命周期与状态清理`

### Description
迁移 Pod 启停、重启、日志、二维码、镜像升级、配置应用和 Skill reload API。

### Checklist
- [x] 实现 start、stop、restart、logs、qrcode 和 apply-config
- [x] 升级镜像后重新应用期望 Runtime DTO 并检查健康状态
- [x] Skill reload 批量参数改为 `podIds` 并保持部分失败可观察
- [x] 删除 Pod 时强制调用方选择 retain/delete，显式记录审计
- [x] 使用 fake driver 补充状态冲突、升级失败、日志和批量操作测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-021: 实现 Pod 资源、并发和告警 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-003, TASK-009, TASK-012, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.4.6 LLM / Resource API 兼容调整`, `multi-user-single-pod.design.md#4.3 监控与审计`

### Description
将现有资源 API 改为 Pod 覆写和全局默认继承，并支持 Skill/Browser 并发限制及有效值查询。

### Checklist
- [x] 读取和更新 Pod CPU、内存、重启策略及并发覆写
- [x] 返回全局默认、Pod 原始值和解析后的有效值
- [x] 资源变化触发完整 Pod 调和，并发变化触发对应运行时配置更新
- [x] 补充继承、非法限制、告警阈值和调和触发测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-022: 实现 Human User CRUD 和模型配置 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004, TASK-007, TASK-013, TASK-017, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.4.2 Human User API`, `multi-user-single-pod.design.md#3.5.7 生命周期与状态清理`

### Description
提供 Pod 下 Human User 的创建、分页、详情、状态、备注、删除和 per-agent 模型覆写能力。

### Checklist
- [x] 支持直接 Identity 或绑定码激活两种创建方式
- [x] 禁止普通 PATCH 修改 agent、profile 和 CDP port 等不可变字段
- [x] 模型覆写支持保留旧 key、替换 key、清除和脱敏查询
- [x] 删除先进入 deleting、应用路由变更并清理私有状态后再物理删除
- [x] 补充容量、状态迁移、模型脱敏和离线清理重试 API 测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-023: 实现 Identity 和绑定码管理员 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005, TASK-006, TASK-017, TASK-018, TASK-022
- **Source**: `multi-user-single-pod.design.md#3.4.3 Identity / Binding Code API`, `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
支持管理员直接维护 IM Identity，或为 pending/已有用户生成、查看和吊销绑定码。

### Checklist
- [x] 实现 Identity 新增、启禁用和删除接口
- [x] 实现绑定码创建、状态列表和吊销接口，明文仅创建响应返回一次
- [x] 校验 channel alias、OpenClaw channel、account、peer kind 和用途
- [x] Identity 变化递增 Pod generation 并进入 apply 队列
- [x] 补充新增 IM、最后 Identity 删除、code 不回显和 scoped 冲突测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-024: 实现内部绑定激活和限流

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-008, TASK-017, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.4.3 Identity / Binding Code API`, `multi-user-single-pod.design.md#3.5.6 Muad Runtime Guard`

### Description
实现 Runtime Guard 调用的确定性绑定接口，依据可信消息上下文完成激活，并用持久失败计数和内存窗口双重限流。

### Checklist
- [x] service token 确定 Pod，校验 code 与 channel/account/direct 上下文一致
- [x] 实现单 sender 十分钟窗口限流及单码累计失败上限
- [x] 激活事务提交后投递配置调和并区分“已绑定”和“配置应用中”
- [x] 记录 bind success/fail/reject 审计但不记录绑定码明文
- [x] 补充未授权 sender、重放、群聊、错作用域、限流和调和测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-025: 实现平台配置和用户凭证 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-007, TASK-008, TASK-018, TASK-022
- **Source**: `multi-user-single-pod.design.md#3.4.4 Platform Config / Credential API`, `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
提供管理员维护业务平台和每用户每平台 API key 的接口，公开响应只显示配置状态和 fingerprint。

### Checklist
- [x] 实现平台列表、新增、更新和启禁用接口
- [x] 实现用户凭证列表、覆盖和删除接口
- [x] 写入前校验平台存在、启用且 adapter 已安装
- [x] 凭证更新/删除不重启 Pod，但使 session cache 在下次解析时失效
- [x] 补充明文不回显、覆盖语义、禁用平台和审计测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-026: 实现凭证 Resolver 和 Pod Token 轮换

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-007, TASK-008, TASK-010, TASK-011, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.4.5 Internal Credential Resolver API`, `multi-user-single-pod.design.md#3.5.1 Repository`

### Description
让 Pod 内 session-manager 按可信 agentId 和 platform 解析 active 用户凭证，并支持 service token 安全轮换。

### Checklist
- [x] 根据已认证 Pod、agentId 和 platform 反查唯一 active Human User
- [x] 返回短暂明文 API key、用户/平台 fingerprint 和最小平台配置
- [x] 非本 Pod、disabled/deleting 用户、未配置凭证和禁用平台均明确拒绝
- [x] 实现 token 轮换、Driver Secret 更新和旧 token 立即失效
- [x] 补充跨 Pod 越权、脱敏日志、错误码和轮换中断恢复测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-027: 迁移 LLM API 到 Pod 和用户模型语义

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003, TASK-004, TASK-013, TASK-017, TASK-018
- **Source**: `multi-user-single-pod.design.md#3.3.7 保留或调整的现有表`, `multi-user-single-pod.design.md#3.4.6 LLM / Resource API 兼容调整`

### Description
保留全局模型配置，同时将旧容器关联改为 Pod，并支持用户模型覆写的 provider/model 脱敏查询。

### Checklist
- [x] 将关联参数和响应从 userId 调整为 podId/humanUserId
- [x] 全局、Pod 和用户模型配置均不在查询响应回显 API key
- [x] 更新模型配置后递增对应 Pod generation 并触发调和
- [x] 补充旧 key 保留、不同用户不同 DeepSeek key 和无明文响应测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-028: 迁移审计查询和告警语义

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-008, TASK-012, TASK-018, TASK-021
- **Source**: `multi-user-single-pod.design.md#3.5.9 当前代码改造范围`, `multi-user-single-pod.design.md#4.3 监控与审计`

### Description
让审计和告警接口展示 Pod、Human User、Identity、Binding、配置代次及运行时拒绝事件。

### Checklist
- [x] 更新审计筛选、target 展示和事件 metadata DTO
- [x] 暴露 apply error、generation lag、Resolver/绑定失败和并发排队告警
- [x] 保持分页和通用审计兼容且不输出敏感字段
- [x] 补充事件筛选、阈值、分页和脱敏回归测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-029: 搭建 session-manager CLI 和 Resolver 客户端

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-026
- **Source**: `multi-user-single-pod.design.md#3.5.5 session-manager 集成`

### Description
在 `tools/session-manager` 建立 Node.js 24 包、共享核心和稳定 CLI，由可信环境注入 agent 上下文并调用 Console Resolver。

### Checklist
- [x] 建立 TypeScript 包、构建、测试和 `/usr/local/bin/session-manager` CLI 入口
- [x] 实现 `get-state --platform`，禁止 `--agent-id` 等跨用户参数
- [x] 从固定 Secret 文件读取 token，并以超时、一次 jitter 重试调用 Resolver
- [x] stdout 仅输出稳定 JSON，stderr/退出码结构化且不包含 API key/Cookie
- [x] 补充参数、超时、重试、错误码和输出脱敏测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-030: 实现 session 状态缓存、Adapter 和刷新锁

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-025, TASK-029
- **Source**: `multi-user-single-pod.design.md#3.5.5 session-manager 集成`, `multi-user-single-pod.design.md#5 风险与依赖`

### Description
按 agent/platform/default 隔离 Cookie/storageState，依据 owner 和双 fingerprint 判定复用，并对并发刷新执行单飞控制。

### Checklist
- [x] 实现平台 adapter 接口和首期已安装平台 adapter 注册表
- [x] 写入固定 cookies、storageState、meta 路径且 API key 永不落盘
- [x] 校验 humanUser、agent、pod、credential/platform fingerprint 和过期时间
- [x] 使用原子 `refresh.lock` 单飞、有限等待和超时锁回收
- [x] 补充 owner 不匹配、禁用/删 key、认证失败、并发刷新和崩溃恢复测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-031: 实现 session-manager OpenClaw Tool 和跨语言契约

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-030
- **Source**: `multi-user-single-pod.design.md#3.5.5 session-manager 集成`, `multi-user-single-pod.design.md#3.7 测试方案`

### Description
将共享核心暴露为 OpenClaw `session_get_state` Tool，并验证 Python、TypeScript 和 Shell Skill 均可通过同一 CLI 集成。

### Checklist
- [x] 提供插件 manifest、Tool 注册和可信 `toolContext.agentId` 提取
- [x] Tool 参数只接受 platform，不接受模型提供 agentId 或路径
- [x] Tool 与 CLI 共用 Resolver、adapter、缓存和错误类型
- [x] 提供 Python、TypeScript、Shell 调用 fixture 而不维护三套 SDK
- [x] 补充插件加载、上下文伪造、入口等价和跨语言测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-032: 加固 muad-run-skill 的可信上下文和并发控制

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-029
- **Source**: `multi-user-single-pod.design.md#3.5.5 session-manager 集成`, `multi-user-single-pod.design.md#3.5.8 Skill 分层与可信发布边界`

### Description
让通用 Skill runner 从可信 Tool Context 注入 agent/session，并仅执行当前 agent 可见且通过 manifest 声明的入口。

### Checklist
- [x] 注入 `MUAD_AGENT_ID`、`MUAD_SESSION_KEY` 和当前 workspace 上下文
- [x] 拒绝任意命令、绝对路径、目录穿越和未声明 entrypoint
- [x] 解析 public/private Skill 可见性并拒绝未经审批的同名覆盖
- [x] 按 Pod 有效并发限制有界排队，超时返回明确 busy 错误
- [x] 补充上下文伪造、路径越界、manifest、并发和纯提示 Skill 回归测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-033: 实现 Runtime Guard 绑定命令和健康检查

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-024, TASK-031
- **Source**: `multi-user-single-pod.design.md#3.5.6 Muad Runtime Guard`

### Description
新增外置 Runtime Guard 插件，确定性消费 `/bind` 并暴露控制面可验证的 runtime health，不修改 OpenClaw 上游。

### Checklist
- [x] 注册 `acceptsArgs:true`、`requireAuth:false` 的 `/bind` 命令
- [x] 从可信 command context 读取 sender/channel/account/session 并限制 direct message
- [x] 调用激活 API 后返回 `continueAgent:false`，避免进入模型生成重复回复
- [x] 暴露 `muad.runtime.health` 并校验 DTO generation、映射和 session-manager 状态
- [x] 补充企微/微信 context、无效 sender、群聊、重复回复和健康契约测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-034: 实现 Runtime Guard 工具策略和 Browser 并发租约

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-013, TASK-033
- **Source**: `multi-user-single-pod.design.md#3.5.6 Muad Runtime Guard`, `multi-user-single-pod.design.md#5 风险与依赖`

### Description
通过 Trusted Tool Policy 强制 Browser Profile、main denylist 和 workspace 文件边界，并对 Browser 调用执行有界并发控制。

### Checklist
- [x] 在 manifest 声明并注册 browser、main 和 agent-files trusted policies
- [x] 按可信 agent 覆盖 Browser profile，拒绝 profile 管理和跨 profile 操作
- [x] 对 main、Shell/Exec 和跨 workspace/agentDir/session-store 访问 fail-closed
- [x] 实现带 TTL/watchdog 的 Browser lease、排队超时和异常回收
- [x] 补充参数伪造、跨用户访问、main deny、并发上限和 lease 回收测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-035: 固定 OpenClaw 版本并装配运行时插件镜像

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-015, TASK-031, TASK-032, TASK-034
- **Source**: `multi-user-single-pod.design.md#3.5.9 当前代码改造范围`, `multi-user-single-pod.design.md#5.1 发布前验证门槛`

### Description
构建包含锁定 OpenClaw 版本、session-manager、Runtime Guard、muad-run-skill 和注入脚本的可复现镜像。

### Checklist
- [x] 固定 OpenClaw `2026.6.10` 版本或 digest 并记录构建元数据
- [x] 构建安装三个插件及其生产依赖到约定 `/opt/muad` 路径
- [x] 安装 session-manager CLI，确保运行用户可读插件和 Secret 文件
- [x] 增加启动时插件 manifest、显式启用和版本自检
- [x] 补充镜像结构、CLI、插件加载和上游契约 smoke test

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-036: 重构前端 API 类型和集中调用封装

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-019, TASK-020, TASK-021, TASK-022, TASK-023, TASK-025, TASK-027, TASK-028
- **Source**: `multi-user-single-pod.design.md#3.6.3 前端 API 封装`

### Description
将前端旧用户容器类型迁移为 Pod、Human User、Identity、Binding、Platform 和配置代次类型，所有请求继续集中在 `api.ts`。

### Checklist
- [x] 定义严格的分页、状态、脱敏凭证和错误响应类型
- [x] 封装 Pod、用户、Identity、绑定码、平台凭证和配置应用 API
- [x] 保持 auth header、401 处理和 BASE path 行为一致
- [x] 移除页面对旧 user/container 字段和裸 fetch 的依赖
- [x] 补充 URL、payload、响应解析、401 和类型回归测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-037: 实现 Pod 列表、分页和创建流程

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-036
- **Source**: `multi-user-single-pod.design.md#3.6.1 页面结构`, `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
将 Containers 首页调整为 Pod 管理入口，展示容量和配置状态，并支持创建带通道、资源和上限的 Pod。

### Checklist
- [x] 展示 Pod ID、名称、状态、通道、容量和 generation/apply 状态
- [x] 实现分页、状态筛选、名称查询和刷新
- [x] 创建弹窗收集 Pod、通道、资源、镜像和 maxUsers
- [x] 表单遵循 busy、try/catch/finally、错误和成功三态
- [x] 补充列表、筛选、容量、创建成功和错误状态组件测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-038: 实现 Pod 详情和运维操作视图

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-020, TASK-021, TASK-036, TASK-037
- **Source**: `multi-user-single-pod.design.md#3.6.1 页面结构`, `multi-user-single-pod.design.md#3.6.3 前端 API 封装`

### Description
在现有轻量页面切换模式下增加 Pod 详情子视图和用户、通道、配置 Tab，不强制引入路由库。

### Checklist
- [x] 实现用户、通道、配置和资源/并发详情 Tab
- [x] 展示期望/已应用 generation、apply error、未收敛和健康状态
- [x] 提供应用、重试、启停、重启、升级、日志和二维码操作
- [x] 删除 Pod 时明确选择 retain/delete PVC 并展示影响
- [x] 补充 Tab、状态刷新、危险确认和操作错误组件测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-039: 实现 Human User 管理和模型配置界面

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-022, TASK-036, TASK-038
- **Source**: `multi-user-single-pod.design.md#3.6.1 页面结构`, `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
在 Pod 详情中实现 Human User 列表、创建和详情，支持直接 Identity、绑定码激活、状态和模型覆写。

### Checklist
- [x] 展示用户状态、agent、Identity 数、Browser Profile 和容量影响
- [x] 新增用户支持已知 external ID 和未知 ID 绑定码两条旅程
- [x] 用户详情支持名称、备注、状态、模型覆写和删除
- [x] 删除确认明确列出 workspace、browser、session 和 private Skill 清理
- [x] 补充两种创建方式、状态、模型脱敏和删除确认测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-040: 实现 Identity 和绑定码管理界面

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-023, TASK-036, TASK-039
- **Source**: `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
支持管理员直接增加 IM Identity，或为已有用户新增 IM 生成一次性绑定码并查看激活状态。

### Checklist
- [x] 展示 channel/account/external ID 类型、状态和原始 ID
- [x] 支持 Identity 新增、启禁用和删除
- [x] 创建绑定码时只展示一次明文，并显示用途、hint、状态和过期时间
- [x] 补充新增 IM、一次展示、吊销、过期和 scoped 冲突测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-041: 实现平台配置和用户凭证界面

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-025, TASK-036, TASK-039
- **Source**: `multi-user-single-pod.design.md#3.6.1 页面结构`, `multi-user-single-pod.design.md#3.6.2 管理员核心旅程`

### Description
提供业务平台设置区和用户平台 API key 管理，只显示平台状态、fingerprint 和更新时间。

### Checklist
- [x] 实现平台列表、新增、最小配置编辑和启禁用
- [x] 在用户详情中实现各平台 API key 新增、覆盖和删除
- [x] 输入后清空明文，页面和错误信息不回显 secret
- [x] 补充平台禁用、凭证覆盖/删除、脱敏和失败状态测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-042: 回归 LLM、资源、审计、通知和应用导航

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-027, TASK-028, TASK-036, TASK-038, TASK-041
- **Source**: `multi-user-single-pod.design.md#3.6.1 页面结构`, `multi-user-single-pod.design.md#3.7 测试方案`

### Description
保留现有轻量导航和管理页面，将所有旧 user 语义调整为 Pod，并展示新增审计和告警信息。

### Checklist
- [x] 更新 App 页面切换、LLM、Settings、Audit 和 Notification 类型及文案
- [x] LLM 页面保持全局能力并确保 key 永不回显
- [x] 资源、告警和通知使用 Pod 有效限制和 generation 状态
- [x] 审计页面支持新增语义事件、actor 和 target 展示
- [x] 运行全量 strict typecheck、现有组件测试和新增页面回归测试

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-11] completed (done)

---

## TASK-043: 完成数据库重建和后端 API 集成回归

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-018, TASK-019, TASK-020, TASK-021, TASK-022, TASK-023, TASK-024, TASK-025, TASK-026, TASK-027, TASK-028
- **Source**: `multi-user-single-pod.design.md#3.7 测试方案`, `multi-user-single-pod.design.md#4.4 数据重建`

### Description
以全新数据库串联 Repository、API、调和和审计，清除旧 user fixture 并验证开发期 reset 后的完整控制面行为。

### Checklist
- [x] 更新所有旧 user fixture、测试 helper 和路由断言为 Pod/Human User
- [x] 覆盖 Pod 创建、容量、Identity、绑定、平台凭证、Resolver 和模型完整旅程
- [x] 覆盖事务回滚、并发容量、token 轮换、generation 冲突和敏感字段
- [x] 验证旧 DB 备份后全量重建及管理员/全局配置重新初始化
- [x] 运行后端单元、API、race 可执行范围和静态检查并修复回归

### Log
- [2026-07-11] created (draft)
- [2026-07-11] started (in-progress)
- [2026-07-12] completed (done): 旧库已备份为 `data/console.db.legacy-20260711.bak`，新库完成 schema/admin/platform seed/global LLM 初始化；`go test ./...`、`go vet ./...` 与可执行范围 race 通过

---

## TASK-044: 完成 Docker 镜像和插件契约集成验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-035, TASK-043
- **Source**: `multi-user-single-pod.design.md#3.7 测试方案`, `multi-user-single-pod.design.md#5.1 发布前验证门槛`

### Description
构建最新镜像并在 Docker 环境验证 Secret、配置注入、三个插件和 OpenClaw 上游公开 API 契约。

### Checklist
- [x] 构建镜像并核对固定 OpenClaw 版本、插件产物和 CLI
- [x] 验证 token 文件权限、固定路径、非 env 暴露和轮换清理
- [x] 验证 strict config、manifest、Trusted Tool Policy、command context 和 health method
- [x] 验证 validate、Gateway/Pod 重启、失败回滚和 retained volume 防复用
- [x] 保存可重复的 Docker 集成测试结果和镜像标识

### Log
- [2026-07-11] created (draft)
- [2026-07-12] started (in-progress)
- [2026-07-12] completed (done): 镜像 `sha256:d9ef134d...` 完成 cold start、插件、Secret、generation 8/9 应用回滚和真实 DockerDriver retained-state 验证；记录见 `docker-validation-20260712.md`

---

## TASK-045: 完成 Kubernetes Secret、PVC 和生命周期集成验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-035, TASK-043
- **Source**: `multi-user-single-pod.design.md#3.7 测试方案`, `multi-user-single-pod.design.md#5.1 发布前验证门槛`

### Description
在 Kubernetes 测试环境验证 Deployment、Secret、PVC、配置调和、deleting 重试和显式 adopt。

### Checklist
- [x] 验证 Secret volume 权限、runtime UID/GID 和轮换后旧 token 失效
- [x] 验证 Runtime DTO、Gateway-only/full restart 和健康检查
- [x] 验证配置原子回滚、Console 重启恢复和 generation 防陈旧写
- [x] 验证离线 deleting 重试、PVC retain/delete 和同名 Pod 防自动接管
- [x] 固化 K8s fake/integration 测试和故障诊断记录

### Log
- [2026-07-11] created (draft)
- [2026-07-12] started (in-progress)
- [2026-07-12] completed (done): 真实集群 Secret/initContainer、token rollout、generation 8 Gateway/Pod restart、PVC retain/adopt/delete 全链路通过；记录见 `k8s-validation-20260712.md`

---

## TASK-046: 在 66667 完成多用户端到端验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-037, TASK-038, TASK-039, TASK-040, TASK-041, TASK-042, TASK-044, TASK-045
- **Source**: `multi-user-single-pod.design.md#2.5.2 功能验收场景`, `multi-user-single-pod.design.md#3.7 测试方案`, `multi-user-single-pod.design.md#5.1 发布前验证门槛`

### Description
在 66667 或等价测试 Pod 上按管理员真实旅程验证多 IM、多模型、平台凭证、浏览器和私有状态隔离。

### Checklist
- [x] 从空 DB 创建 Pod、通道、用户、Identity、绑定码和平台凭证
- [x] 验证企微/微信 direct `/bind`、已有用户新增 IM 和跨 IM 共享记忆
- [x] 验证 Alice/Charlie 使用不同 DeepSeek key 并发调用且不串 provider
- [x] 验证 Alice/Bob Browser 并发强制使用各自 profile，main 使用 quarantine
- [x] 验证 XDR/MSSW 等平台凭证、session cache 和删除/禁用即时失效
- [x] 验证最终结果、附件/图片通道能力不被进度或插件处理破坏并记录结果

### Log
- [2026-07-11] created (draft)
- [2026-07-12] started (in-progress)
- [2026-07-12] completed (done): generation 单调启动保护、绑定码、多模型、Browser、session cache 与企微图片最终交付均通过；记录见 `e2e-validation-66667-20260712.md`

---

## TASK-047: 完成单 Pod 10 用户压测并固化运维参数

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-046
- **Source**: `multi-user-single-pod.design.md#2.5.3 非功能指标`, `multi-user-single-pod.design.md#4.3 监控与审计`, `multi-user-single-pod.design.md#5.1 发布前验证门槛`

### Description
执行 10 用户 LLM、Skill、Browser 和平台 session 的混合负载测试，依据数据确定生产资源和并发默认值。

### Checklist
- [x] 定义 10 用户混合负载、持续时间、成功率和隔离断言
- [x] 采集 CPU、内存、LLM、Skill/Browser 排队、Resolver 和 generation 指标
- [x] 验证并发过载时有界排队、明确 busy/timeout 且无状态串用
- [x] 将资源和 `max_skill_concurrency`、`max_browser_concurrency` 结论写入部署配置
- [x] 记录容量边界、回滚步骤、残余风险和发布验收结果

### Log
- [2026-07-11] created (draft)
- [2026-07-12] started (in-progress)
- [2026-07-12] completed (done): 10 用户 LLM/Skill/Browser/Resolver 混合负载 10/10 通过，生产基线固化为 2 CPU/3 GiB、Skill 2、Browser 2；记录见 `capacity-validation-66667-20260712.md`

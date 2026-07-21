# Agent 运行时选型调研：OpenClaw vs Hermes 与部署单元演进

| 项目 | 内容 |
| ---- | ---- |
| 状态 | 调研归档（支撑总设选型结论） |
| 日期 | 2026-07-21 |
| 关联总设 | `docs/muad-openclaw-总体设计说明书.md` §4 |
| Hermes 源码 | `/Users/jahan/workspace/hermes-agent`（本地深度对照） |
| 既有笔记 | `docs/multi-user-single-pod.md` §10 |

---

## 1. 调研目的与方法

### 1.1 要回答的问题

1. Agent 内核用 **OpenClaw** 还是 **Hermes**（或其它）？  
2. 部署单元用 **单 Pod 单用户** 还是 **单 Pod 多用户**？  
3. 缺口用控制面 + 外置工具链补，还是换栈？

### 1.2 方法

| 输入 | 做法 |
| ---- | ---- |
| 业务约束 | 企微私聊交付、SOP Skill、~100 用户、隔离与不 fork |
| Hermes 源码 | 读 `gateway/`、`plugins/platforms/wecom/`、`hermes_state.py`、`tools/skills_*.py`、`agent/secret_scope.py` 等 |
| 我方实现 | muad Console / tools / Runtime DTO 投资路径 |
| 既有笔记 | multi-user 文档 §10 与容量文档 |

总设只引用本文 **§7 结论**；细节以本文为准。

---

## 2. 业务约束（选型输入）

| 约束 | 含义 |
| ---- | ---- |
| 主入口 | 服务经理 **企微私聊** 交付（非群聊优先） |
| 能力 | 标准 SOP → Skill；预防流/报告可扩展 |
| 规模 | 约 100 服务经理并行 |
| 安全 | 用户/凭证/浏览器/Skill 隔离；密钥不进 Skill |
| 工程 | Go+TS 控制面；不维护 fork 的上游内核 |
| 节奏 | 先助手，专家平权后置 |

---

## 3. 部署单元演进：单用户 → 多用户

### 3.1 阶段

```text
阶段 1  单 Pod 单用户
  · 一人一 Gateway；隔离强、验证快
  · 用户↑ → Pod/PVC/通道/基线资源近似线性↑

阶段 2  单 Pod 多用户（当前）
  · 一 Gateway 内多 agent / workspace / browser profile
  · Console 管用户、模型、Skill、apply
  · tools/ 补绑定、隔离、执行、凭证、进度、并发

阶段 3  业务纵向
  · Skill 内容扩展；专家同链加深（P2）
```

### 3.2 为何不能停在单用户 Pod

| 维度 | 单用户 Pod | 规模化问题 |
| ---- | ---------- | ---------- |
| 隔离 | 容器级，强 | 用成本换隔离 |
| 资源 | 每用户一套 Gateway 基线 | 空闲基线与 K8S 对象膨胀 |
| 通道 | 模型简单 | 连接数与运维复杂度上升 |
| 治理 | 弱统一模型池/Skill/审计 | 不满足平台化 |

容量与优化对比：`docs/k8s-architecture-100users.md`。

### 3.3 多用户在 OpenClaw 上如何落地

OpenClaw 原生：`dmScope: per-channel-peer`、`agents.list`、`bindings`、`browser.profiles`、per-agent workspace。

muad 补齐（不 fork）：Human User/Identity/绑定码、Runtime DTO apply、Guard、run-skill、session-manager、progress 链、concurrency。机制：`docs/multi-user-single-pod.md`。

---

## 4. Hermes 源码深度分析

对照树：`/Users/jahan/workspace/hermes-agent`。

### 4.1 仓库结构（与选型相关的部分）

| 路径 | 作用 |
| ---- | ---- |
| `gateway/run.py` | Gateway 入口：多平台适配器生命周期、会话 Agent 缓存（LRU/空闲淘汰） |
| `gateway/session.py` | **SessionSource / build_session_key / SessionStore** — 多用户会话核心 |
| `gateway/platforms/` | 部分内置平台适配 |
| `plugins/platforms/` | 平台插件（**含 wecom**、telegram、discord、slack、feishu、whatsapp…） |
| `plugins/memory/` | 外部记忆后端（honcho、mem0、holographic、supermemory 等） |
| `hermes_state.py` | **SessionDB**：`~/.hermes/state.db`，WAL + FTS5 |
| `agent/` | 对话循环、压缩、skill 预处理、凭证 scope、浏览器等 |
| `tools/skills_tool.py` 等 | Skill 发现/加载/安全 |
| `skills/`、`optional-skills/` | 捆绑与可选技能包 |
| `cron/` | 定时任务与隔离执行 |
| `acp_adapter/`、`tui_gateway/` | ACP/TUI 与 state.db 集成 |

Hermes 是 **「多平台 Gateway + 强会话库 + 技能/记忆/定时」** 的一体化 Agent，不是「仅聊天 SDK」。

### 4.2 多用户会话模型（源码级）

#### 4.2.1 `SessionSource`（`gateway/session.py`）

显式描述消息来源，用于回程路由、系统提示上下文、cron 投递等，字段包括：

- `platform`, `chat_id`, `chat_type`（`dm` / `group` / `channel` / `thread`）  
- `user_id`, `user_name`, `user_id_alt`  
- `thread_id`, `scope_id`（guild/workspace 级隔离）  
- `profile`（多 profile 网关时的配置域）  
- 以及 bot 标记、消息 id、relay 信任信号等  

→ 身份不是「埋在字符串里碰运气」，而是 **结构化入站上下文**。

#### 4.2.2 `build_session_key`（同文件，默认参数关键）

```text
build_session_key(
  source,
  group_sessions_per_user=True,   # 默认：群内按用户隔离
  thread_sessions_per_user=False, # 默认：线程内共享
  profile=None,                   # 默认命名空间 agent:main
)
```

行为摘要（源码注释 + 实现）：

| 场景 | Key 形态（示意） | 隔离效果 |
| ---- | ---------------- | -------- |
| DM 有 chat_id | `agent:main:<platform>:dm:<chat_id>` | 私聊分会话 |
| DM 无 chat_id 有 user | `...:dm:<user_id>` | 避免无 chat_id 时多人塌缩到同一 DM session（防历史串话） |
| 群 + `group_sessions_per_user=True` | `...:group:<chat_id>:<user_id>` | **群内每人独立 session（默认）** |
| 群关闭 per-user | `...:group:<chat_id>` | 群共享 session |
| 线程默认 | 线程 id 进 key，**不加 user** | 线程内共享（论坛/Discord 线程 UX） |
| 命名 profile | `agent:<profile>:...` | 多 profile 不碰撞 |

`is_shared_multi_user_session()` 与上述规则镜像：DM 永不 shared；群是否 shared 取决于 `group_sessions_per_user`。

→ **相对 OpenClaw：Hermes 默认把「群聊多用户隔离」做成一等公民；OpenClaw 群聊通常是共享 session。**

#### 4.2.3 Session 存储与 Gateway 并发

- **SessionDB**（`hermes_state.py`）：SQLite，`WAL`、短 timeout + 应用层写重试抖动、定期 checkpoint/FTS optimize，应对 **gateway + CLI + 多进程** 共写一库。  
- FTS5 支撑历史检索；损坏有修复/重建路径（桌面端自愈叙述）。  
- Gateway 侧对同步 DB 访问有 **Async 封装与「禁止在事件循环裸调 SessionDB」** 的测试门禁（`tests/gateway/test_async_session_db.py`），说明多会话长驻进程是一等设计场景。  
- `gateway/run.py`：`AIAgent` **按 session 缓存**，有 max size 与 idle TTL，防止长驻 gateway 内存无限涨。

→ Hermes 的「多用户」不仅是 key 规则，还包括 **状态库、写并发、Agent 缓存** 一整套。

### 4.3 企微适配（源码级）

`plugins/platforms/wecom/adapter.py`：

| 能力 | 实现印象 |
| ---- | -------- |
| 连接 | WeCom AI Bot **WebSocket**（`wss://openws.work.weixin.qq.com`） |
| 入站 | `aibot_msg_callback` / event callback |
| 出站 | `aibot_send_msg`（markdown）、`aibot_upload_media_*` 媒体 |
| 入站媒体 | 图片/文件下载缓存，供 agent 上下文 |
| 访问控制 | `dm_policy` / `group_policy`：open / allowlist / disabled / **pairing** |
| 其它 | 长消息客户端拆分处理；callback 模式另有 `wecom_crypto.py` |

→ Hermes **具备可用的企微通道**。是否在「模板卡片、富交互」上达到 OpenClaw 官方插件完整度，需按产品消息类型清单逐项比；**不能默认 Hermes 企微更强**，只能说「能接企微」。

### 4.4 Skills 模型（源码级）

| 点 | 源码事实 | 对「企业多租户 Skill」的含义 |
| -- | -------- | ---------------------------- |
| 主目录 | `~/.hermes/skills/` 为单一真相源（安装时从捆绑 `skills/` 播种） | **默认全局**，不是 per-agent workspace |
| 发现 | `tools/skills_tool.py` / `agent/skill_utils.py`：本地 dir + `external_dirs` | 可外挂目录，仍非 OpenClaw 那套 per-workspace 优先级 |
| 安全 | 拒绝不可信绝对路径逃逸；平台 frontmatter 等 | 有基础护栏 |
| 策展 | `agent/curator.py` 等：agent 自创建/维护 skills | 偏「自进化个人/实例技能」 |
| 多 profile | `HERMES_HOME` / profile 切换 skills 根；multiplex 时凭证 scope 分离 | **per-profile ≈ 粗粒度多租户**，不是 Console 里「public 全员 + private 每 Human User」 |

→ Hermes 强在 **个人/实例技能生态与记忆闭环**；muad 要的 **控制面统一 public/private 生效、冲突策略、全 Pod 应用** 更贴 OpenClaw workspace/extraDirs + Console。

### 4.5 多 Profile Multiplexing（源码级）

`agent/secret_scope.py`：

- 网关可 `multiplex_profiles`：一进程服务多 profile。  
- 开启后 **`get_secret` 无 scope 则 fail-closed**，防止读到别的 profile 的环境变量密钥。  
- 与 session key 的 `agent:<profile>` 命名空间配套。

→ 这是「单进程多配置域」的认真设计，接近「多租户配置隔离」的一种形态；但仍是 **profile 级**，不是 muad 的 Human User / 模型池 / 绑定码产品模型。

### 4.6 记忆与其它能力（选型相关）

- `plugins/memory/*`：多种外部记忆后端可插拔。  
- cron：定时任务、隔离 session 执行。  
- 子代理 / 异步委托、多终端后端（Docker/SSH/Modal 等）：产品面更「全能个人 Agent」。  

→ 对 **MSS 企业交付控制面** 是加分项但非刚需；换栈成本远高于「在 OpenClaw 上补 tools」。

### 4.7 OpenClaw vs Hermes 对照（基于源码 + 我方实现）

| 维度 | OpenClaw | Hermes（源码核实） | 对 muad |
| ---- | -------- | ------------------ | ------- |
| 会话身份 | 多在 session key / peer | **SessionSource 结构化** | Hermes 模型更清晰 |
| 群聊 per-user | 基本不支持 | **`group_sessions_per_user` 默认 True** | 群聊场景 Hermes 胜 |
| DM 多用户 | `per-channel-peer` + bindings | 默认按 dm chat/user 隔离 | 均可 |
| 企微 | 官方插件，类型全（我方主路径） | WeCom WS 适配完整可用 | **交付主路径仍偏 OpenClaw 生态** |
| Skill 企业分层 | workspace / extraDirs 自然 | **~/.hermes/skills 全局为主** | **public/private 治理偏 OpenClaw** |
| 跨 IM 同记忆 | 同 agent workspace + identityLinks | 无对等 identityLinks | **跨企微/微信偏 OpenClaw** |
| 会话持久化 | 偏文件 | **state.db WAL+FTS，多进程写有工程化** | Hermes 会话库更强；企业审计在 Console |
| 多配置域 | 多 Pod / 多 agent | profile multiplex + secret scope | 不同切分方式 |
| 与 muad 工具链 | 已实现全套 | 仅 progress-adapters/hermes | **换 Hermes = 重做主路径** |
| 控制面 | 自研 Console | 无对等「企业开通/模型池/apply」 | 必须自研，已押 OpenClaw 契约 |

---

## 5. 部署单元三选一

| 方案 | 结论 | 一句话 |
| ---- | ---- | ------ |
| 每用户一 Pod | 否（稳态） | 隔离最强，100 用户成本不可接受 |
| **单 Pod 多用户（默认 ~10）** | **是** | 成本、隔离可补、故障半径可配 |
| 全局 Message Router | 否（当前） | 复杂度高；管理员分配 Pod 足够 |

---

## 6. 为何最终不选 Hermes 作主运行时（决策）

| Hermes 源码级优势 | 权重（我方场景） |
| ----------------- | ---------------- |
| 群聊默认 per-user | **低**（主路径企微**私聊** SOP） |
| SessionSource + state.db 工程化 | **中**（企业真相源/审计在 Console SQLite） |
| 多平台/记忆/cron 产品面 | **中**（非当前助手 P0） |

| 选 OpenClaw 的硬理由 |
| -------------------- |
| 企微官方插件与交付体验匹配主入口 |
| Skill workspace 分层贴企业 public/private + Console |
| tools 六件套与 Runtime DTO 已按 OpenClaw 契约落地 |
| 换 Hermes = 重做绑定、执行、凭证、进度主路径 |

**Hermes 定位：** 对照系与备选；保留 `tools/progress-adapters/hermes`；群聊强隔离若升 P0 再专项评估。

---

## 7. 给总设用的结论（唯一入口摘要）

```text
企微私聊交付 + SOP Skill 化 + 多服务经理规模 + 不 fork
  → Agent 内核：OpenClaw（Hermes 为对照，非默认 Gateway）
  → 租户单元：单 Pod 多用户（单用户仅为演进起点）
  → 治理：muad Console + Runtime DTO
  → 扩展：tools/ 六件套
  → 业务：Skill 内容扩展；专家 P2 同链加深
```

| 决策点 | 选择 |
| ------ | ---- |
| Agent 内核 | OpenClaw |
| 部署单元 | 单 Pod 多用户（默认约 10 用户） |
| 控制面 | 自研 Console |
| Hermes | 源码级对照 + 进度适配保留，非生产默认运行时 |
| 单用户 Pod | 演进起点，非稳态 |

**一句话：**  
在「企微私聊、标准 Skill 交付、多服务经理、成本可控、不 fork」下，**OpenClaw 多用户单 Pod + Console + 外置工具链** 为稳态；Hermes 在会话/群聊模型上更「天生多人」，但与主入口与已投工程路径不匹配，故不换栈。

---

## 8. 参考路径（Hermes）

| 主题 | 路径 |
| ---- | ---- |
| 会话 key / 多用户 | `gateway/session.py`（`SessionSource`, `build_session_key`, `group_sessions_per_user`） |
| Gateway 生命周期 | `gateway/run.py` |
| 会话库 | `hermes_state.py`（`SessionDB`） |
| 企微 | `plugins/platforms/wecom/adapter.py`, `wecom_crypto.py` |
| Skills | `tools/skills_tool.py`, `agent/skill_utils.py` |
| 多 profile 密钥 | `agent/secret_scope.py` |
| 记忆插件 | `plugins/memory/` |

---

## 9. 相关文档

- `docs/muad-openclaw-总体设计说明书.md` §4（只保留结论）  
- `docs/multi-user-single-pod.md` §10  
- `docs/k8s-architecture-100users.md`  

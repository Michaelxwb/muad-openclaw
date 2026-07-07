# muad-openclaw · K8S 部署方案（100 用户）

> 版本 v2（2026-06-29）｜ 一句话：**一个控制台经 K8S API 管理 100 个「每用户一个」的 worker 容器；LLM 在远端，worker 只跑通道 + 浏览器 + 技能。**

---

## 1. 架构总览

![muad-openclaw K8S 架构与硬件资源](k8s-architecture.png)

- **console（控制平面）**：Go 后端 + 内嵌前端，负责创建/生命周期/监控/审计/LLM 与资源配置。单实例，状态落 PVC（SQLite，内含 AES-GCM 加密的 bot 凭证 / LLM key）。
- **worker（每用户一个 Pod）**：跑各自的企微/微信通道、浏览器、技能与会话状态。**无入站端口**（企微走出站长连接、微信走扫码登录）；状态挂 PVC，技能挂共享只读 PVC。
- **LLM 在远端**（deepseek 等）：容器本身不跑模型——所以 CPU 很轻，**内存是瓶颈**。
- **外部业务系统**（MSS/SOAR/Jira 等）：skill 需要读取或操作业务系统数据时，经 Pod 内 session-manager 获取对应 Cookie；session-manager 负责自动登录、Cookie 刷新与审计。
- **控制方式**：console 用受限 ServiceAccount（RBAC，仅限 `muad` 命名空间）经 K8S API 建/删/伸缩/exec/取日志，**替代单机 docker.sock 的 root 风险**。

---

## 2. 用户旅程

### 2.1 开通与配置

1. 用户在企微管理后台申请机器人，获得 `bot_id` 和 `secret`，发送给 Console 管理员。
2. 管理员在 Console 创建用户容器：填写用户 ID、选择消息通道（企微/微信）、填入 `bot_id` 和 `secret`。
3. Console 后端为该用户创建独立 worker Pod、状态 PVC、K8S Secret（含 bot 凭证、LLM key、gateway token）。Pod 启动后企微通道连接、服务就绪。

### 2.2 用户发起一次需要外部系统数据的 skill

1. 用户在企微/微信里触发 skill，例如”查询 SOAR 工单”。
2. worker Pod 内的业务 skill 调用 session-manager，传入 `platform=soar`。
3. session-manager 检查 PVC session-store 中该平台 Cookie 是否有效 → 有效则直接返回。
4. 若 Cookie 缺失或失效，session-manager 加载 `platforms/soar.mjs` → 传入 `svcAccount`（由 userId 派生）→ 脚本调 token API → cookie API → 获取 Cookie → 写入 session-store → 返回给 skill。
5. skill 带 Cookie 调用业务平台 API。浏览器类 skill 可额外请求 session-manager 将 Cookie 注入 Chromium profile 后再操作页面。
6. session-manager 上报审计事件（`login.success` / `cookie.reused` / `login.failed`），不含 Cookie 或 token 明文。

### 2.3 异常与恢复

| 场景 | 行为 |
|---|---|
| `platforms/{platform}.mjs` 不存在 | session-manager 返回 `not_configured` |
| token API 返回认证失败 | 返回 `auth_failed`，通知管理员检查服务账号 |
| token API 或 cookie API 不可达 | 退避重试，连续失败返回 `network_unreachable`，上报审计 |
| Pod 删除重建 | 新 Pod 复用 PVC session-store；Cookie 有效则复用，无效则重新登录 |
| session-store 文件损坏 | 丢弃损坏文件，重新调登录脚本获取 Cookie |

---

## 3. 硬件资源（100 用户，已含 +30%）

### 实测单容器（真实对话 + 浏览器）
| 指标 | 空闲 / 文本 | 浏览器任务峰值 |
|---|---|---|
| 内存 | ~300 MiB | **~1.8 GiB** |
| CPU | < 0.05 核 | **1.5 核**（瞬时） |

> 结论：内存为王；**决定容量的核心变量 = 同时开浏览器的人数**。

### 集群总量
| 资源 | 数值 |
|---|---|
| vCPU | **≈ 42 核** |
| 内存 | **≈ 128 GiB** |
| 存储 | **≈ 350 GB NVMe SSD** |

### 推荐节点池
> **3 × (16 vCPU / 48 GiB / 200 GB SSD)** = 48 核 / 144 GiB / 600 GB
> ＋ 托管控制平面；console 与系统组件再留 ~2 核 / 4 GiB。

### 单 Pod 资源 & 存储
| 项 | request（预留） | limit（上限） |
|---|---|---|
| CPU | 100m | 1500m |
| 内存 | 512Mi | **3Gi**（防浏览器 OOM） |

- 每用户状态 PVC：**2–5 GiB（SSD）**；共享 skills PVC（RWX，只读）；console DB PVC ~5 GiB。

---

---

*硬件数值基于 2026-06-29 单机实测 + 30% 余量。*

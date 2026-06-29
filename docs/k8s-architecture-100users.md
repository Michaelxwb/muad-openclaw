# muad-openclaw · K8S 部署方案（100 用户）

> 版本 v2（2026-06-29）｜ 一句话：**一个控制台经 K8S API 管理 100 个「每用户一个」的 worker 容器；LLM 在远端，worker 只跑通道 + 浏览器 + 技能。**

---

## 1. 架构总览

![muad-openclaw K8S 架构与硬件资源](k8s-architecture.png)

- **console（控制平面）**：Go 后端 + 内嵌前端，负责创建/生命周期/监控/审计/LLM 与资源配置。单实例，状态落 PVC（SQLite，内含 AES-GCM 加密的 bot 凭证 / LLM key）。
- **worker（每用户一个 Pod）**：跑各自的企微/微信通道、浏览器、技能与会话状态。**无入站端口**（企微走出站长连接、微信走扫码登录）；状态挂 PVC，技能挂共享只读 PVC。
- **LLM 在远端**（deepseek 等）：容器本身不跑模型——所以 CPU 很轻，**内存是瓶颈**。
- **控制方式**：console 用受限 ServiceAccount（RBAC，仅限 `muad` 命名空间）经 K8S API 建/删/伸缩/exec/取日志，**替代单机 docker.sock 的 root 风险**。

---

## 2. 硬件资源（100 用户，已含 +30%）

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

## 3. 关键约束（务必注意）

| 约束 | 影响 |
|---|---|
| **内存是瓶颈** | 浏览器峰值近 2 GiB；内存 limit 设 **3Gi** 防 OOM；并发浏览器越多越吃内存 |
| **企微 bot 单连接** | 同一 bot 只能一个实例连接，多实例会互踢 → 每用户**严格单副本** + 升级用 Recreate（先停后起） |
| **视频 codec 仅 amd64** | 需浏览器播放视频 → worker 节点选 **amd64**（Google Chrome）；arm64 只能截图 |
| **凭证不入镜像** | bot 凭证 / LLM key 经 K8S Secret 运行时注入（NFR-SEC-02） |
| **落地前提** | 当前 K8S 驱动为桩，需先实现 `internal/driver/k8s.go`（client-go）；接口已固定，console 其余无感知 |

---

*硬件数值基于 2026-06-29 单机实测 + 30% 余量。*

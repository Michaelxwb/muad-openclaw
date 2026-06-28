# Tasks: muad 管理监控控制台

- **Source**: .code-flow/tasks/2026-06-27/muad-admin-console.design.md
- **Created**: 2026-06-27
- **Updated**: 2026-06-27 (全部完成: TASK-001~021 done ✅ 镜像端到端验证通过)

## Proposal

把 muad-openclaw 多租户企微 Agent 平台的容器全生命周期运维（开通/删除/改 LLM/排障/监控）从 `provision-user.sh` + `docker` CLI 上移为一个 Web 控制台，管理员零 CLI 操作。后端用 Go 单二进制（内嵌前端），通过 RuntimeDriver 抽象屏蔽 docker/k8s 差异（P0 写实 docker，k8s 留桩），监控数据源已实地核实（gateway `/health` + WS RPC `channels.status` + session 活跃 + docker stats）。LLM 采用全局默认 ⊕ per-user 覆盖；凭证 AES-GCM 加密落盘、运行时经 env 注入容器，不进镜像。

---

## TASK-001: Go 项目骨架 + 配置加载

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: muad-admin-console.design.md#3.1 方案选型, muad-admin-console.design.md#4.1 部署架构

### Description
建立 Go 控制台后端骨架：模块初始化、HTTP server bootstrap（chi/gin）、分层目录（handler/service/driver/repo/collector）、配置加载。配置全部经 env 注入：`CONSOLE_MASTER_KEY`（加密主密钥）、`RUNTIME_DRIVER=docker|k8s`、`DEFAULT_IMAGE_TAG`、`MUAD_NET`（共享网络名）、监听地址、初始管理员凭证。

### Checklist
- [x] `go mod init`（HTTP 用 stdlib `net/http` Go1.22 ServeMux，零外部依赖，免引 chi/gin）
- [x] 分层目录骨架：`cmd/console`、`internal/{config,driver}`（其余包随后续任务增建）
- [x] config 包：从 env 读取并校验必填项（缺 `CONSOLE_MASTER_KEY` 启动即失败）
- [x] HTTP server bootstrap + `/healthz` 自检端点 + 优雅退出（SIGINT/SIGTERM）
- [x] 配置加载单元测试（缺失/非法 env 报错 + 默认值/JWT 回退）

### Log
- [2026-06-27] created (draft)
- [2026-06-27] started (in-progress)
- [2026-06-27] 决策：HTTP 选 stdlib net/http（非 chi/gin）以零依赖、可离线构建
- [2026-06-27] completed (done) — go vet/build/test 全过

---

## TASK-002: SQLite 存储层 + schema 迁移

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: muad-admin-console.design.md#3.3 数据设计

### Description
用 `modernc.org/sqlite`（pure-Go）建存储层与 4 张表：`users`、`llm_global`（单行约束）、`audit_log`、`admins`。建表迁移幂等执行；提供各表的 repository（增删改查），监控运行时数据不落库。

### Checklist
- [x] 集成 `modernc.org/sqlite`（pure-Go v1.53），DB 路径来自 config，WAL + busy_timeout
- [x] 迁移幂等：建 4 表 + 索引（pk_users、idx_audit_ts、idx_audit_actor、llm_global CHECK id=1）
- [x] repository：users / llm_global(upsert) / audit_log(查询过滤) / admins(幂等引导) CRUD
- [x] 迁移幂等 + CRUD/唯一性(ErrUserExists)/审计查询的单元测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 时间戳用 RFC3339 文本确定性存取；go test 全过

---

## TASK-003: 凭证加密（AES-GCM）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: muad-admin-console.design.md#3.5 质量实现方案

### Description
实现敏感字段（secret / api_key / llm_override 内密钥）的 AES-GCM 加解密 helper。主密钥取自 env `CONSOLE_MASTER_KEY`，不落库。提供 encrypt/decrypt 与统一的响应脱敏工具，保证接口与日志不暴露明文（RULE-04 / NFR-SEC-02）。

### Checklist
- [x] AES-256-GCM encrypt/decrypt（随机 nonce，密文 base64(nonce‖ct)）
- [x] 主密钥从 `CONSOLE_MASTER_KEY` 经 SHA-256 派生 32B key
- [x] 响应脱敏 helper `Mask`（保留前缀掩码其余）
- [x] 加解密往返 / 非确定性 / 错误密钥失败 / 脱敏 单元测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — go test 全过

---

## TASK-004: 管理员登录 + 鉴权中间件 + 审计中间件

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003
- **Source**: muad-admin-console.design.md#3.4 接口设计, muad-admin-console.design.md#3.5 质量实现方案

### Description
实现 API-14 登录（bcrypt 校验，签发 JWT/session）、鉴权中间件（挡所有 `/api/v1/*`，login 除外，NFR-SEC-01）、审计中间件（写操作统一落 `audit_log`，payload 脱敏）。对应 FEAT-06 / FEAT-12。

### Checklist
- [x] `POST /api/v1/auth/login`：bcrypt 校验 + 签发 HMAC-SHA256 token（stdlib，免 JWT 库）
- [x] 鉴权中间件：未登录 `/api/v1/*` 返回 401（E-05）
- [x] 审计中间件：仅写操作(POST/PUT/DELETE/PATCH) actor/action/target/状态 入库
- [x] 初始管理员从 env 引导（CreateAdminIfAbsent 幂等）
- [x] 登录成功/失败、未授权拦截 + 二进制端到端冒烟（/healthz、login、/me）

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — token 用 stdlib HMAC 自签；冒烟端到端通过

---

## TASK-005: RuntimeDriver 接口 + 类型 + env 渲染

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: muad-admin-console.design.md#3.5 质量实现方案, muad-admin-console.design.md#3.2 架构设计

### Description
定义 `RuntimeDriver` 接口与 `UserSpec`/`ContainerInfo`/`Stats` 类型（FEAT-07）。实现 env 渲染：将全局 LLM ⊕ per-user override 合并为容器运行所需的环境变量集合（WECOM_BOT_ID/SECRET、LLM_* 等），供各 driver 复用。

### Checklist
- [x] `RuntimeDriver` 接口（Create/Start/Stop/Restart/Remove/List/Stats/Logs/Reap/Revive）
- [x] 类型：UserSpec、ContainerInfo、Stats、LlmConfig、ErrNotImplemented
- [x] env 渲染：全局⊕override 合并 → env map（对齐 inject-env.mjs 契约，空值省略保镜像基线）
- [x] 合并优先级、缺省继承全局、空 LLM 省略的单元测试 + ContainerName/GatewayPort 辅助

### Log
- [2026-06-27] created (draft)
- [2026-06-27] started (in-progress)
- [2026-06-27] completed (done) — 对齐 bin/inject-env.mjs env 名；go test 全过

---

## TASK-006: DockerDriver 实现 + 接入 muad-net

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005
- **Source**: muad-admin-console.design.md#3.5 质量实现方案, muad-admin-console.design.md#3.2 架构设计

### Description
用 `github.com/docker/docker/client` 实现 DockerDriver：create（接入共享 `muad-net`、挂状态卷 + 共享 skill 只读卷、注入 env、不发布端口）、start/stop/restart/remove（keepState）、list、logs。gateway 端口不发布，容器名 `muad-oc-<id>` 供 Console 内网按名访问（§3.2）。

### Checklist
- [x] 经 `docker` CLI(os/exec) 实现（替代 SDK：免重依赖、可离线、CLI 本就在镜像内）
- [x] create：image + `--env-file`(0600,凭证不进 argv) + 状态命名卷 + skill 只读卷 + `muad-net` + 不发布端口 + mem/cpu 限额
- [x] start/stop/restart/remove（keepState 决定是否删卷，RULE-02）、reap=stop / revive=start
- [x] list（`ps --format json` → state 映射）、stats（`--no-stream`）、logs（tail N）
- [x] 纯函数单测（parseStats/parseMemMiB/mapDockerState/factory+k8s桩）；容器级集成测延后

### Log
- [2026-06-27] created (draft)
- [2026-06-27] 决策：DockerDriver 走 docker CLI(os/exec) 而非 docker SDK（简洁/离线/凭证不入 argv）
- [2026-06-27] completed (done) — go build/vet/test 全过；容器级 e2e 留待真机回归
- [2026-06-27] 重构：单测统一迁至 console/test/（package test 黑盒）；为可测性导出 ParseStats/ParseMemMiB/MapDockerState

---

## TASK-007: K8sDriver 桩

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-005
- **Source**: muad-admin-console.design.md#3.5 质量实现方案, muad-admin-console.design.md#5. 风险与依赖

### Description
提供 K8sDriver 桩实现：各方法返回 `ErrNotImplemented`，使接口先定死、`RUNTIME_DRIVER=k8s` 时可注入但显式报未实现（RISK-05 控工期，P1 再写实）。

### Checklist
- [x] K8sDriver 实现 RuntimeDriver 全部方法，返回 ErrNotImplemented
- [x] driver 工厂 `New(kind,net,skillsDir)` 按 `RUNTIME_DRIVER` 选 docker/k8s
- [x] 工厂选择 + 桩返回 ErrNotImplemented 的单元测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done)

---

## TASK-008: 全局 LLM 配置 + per-user 覆盖 + 连通性测试

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003, TASK-004
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-04：读/改全局 LLM（API-05/06）、per-user 覆盖（API-08）、连通性测试（API-07，用待保存的 provider/baseUrl/apiKey/model 打一次 `/v1/models` 或最小请求）。测试失败阻止保存（E-02）；改全局只影响新建（RULE-03）。api_key 加密落盘、响应脱敏。

### Checklist
- [x] `GET/PUT /api/v1/llm`（全局；api_key 加密存，GET 不回传 key 仅 configured 标志）
- [x] `PUT /api/v1/containers/{userId}/llm`（覆盖 json 整体加密存）
- [x] `POST /api/v1/llm/test`：GET baseURL/models 探测，8s 超时
- [x] PUT 前服务端复测（llm.Probe），失败 40002 拒绝写库（E-02）
- [x] Probe 成功/401/空 URL 测试 + 覆盖合并(driver.MergeLLM 既有测试)

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — Probe 走 OpenAI 兼容 /models；冒烟验证 test 失败路径

---

## TASK-009: 创建/删除容器 API + 校验 + 审计

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004, TASK-006, TASK-008
- **Source**: muad-admin-console.design.md#3.4 接口设计, muad-admin-console.design.md#2.5 验收条件

### Description
实现 FEAT-01/03：创建容器（API-01，校验 userId 字符集与唯一性、合并 LLM、渲染 env、driver.Create、写 users 行、异步刷新状态）、删除容器（API-03，二次确认语义、`deleteVolume` 默认 false、driver.Remove + 删行 + 审计）。

### Checklist
- [x] `POST /api/v1/containers`：userID 正则校验(E-03 400)→ 落 creating 行(PK 保唯一 E-01 409)→ Create → 置 running；失败回滚删行
- [x] `DELETE /api/v1/containers/{userId}?deleteVolume=bool`：keepState=!deleteVolume + 删行（审计中间件统一落）
- [x] 创建成功即置 running（docker run -d 同步返回，免异步轮询）
- [x] 生命周期(create→list→logs→delete)/重复 409/非法 400/审计 测试（fake driver）

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 凭证落库前加密(测试断言非明文)；冒烟验证无 token 401

---

## TASK-010: gateway 采集适配器

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006
- **Source**: muad-admin-console.design.md#3.5 质量实现方案

### Description
实现对单个容器 openclaw gateway 的应用层采集（已核实数据源）：HTTP `GET /health`（存活）、WS RPC `channels.status`（WeCom 连接健康）、session 列表取 `updatedAt`/`lastActivityAt`/`lastMessageAt`（最后活跃）。封装为适配器，集中应对 openclaw 版本字段变化（RISK-06）；`/health` 作兜底存活源。

### Checklist
- [x] ~~WS RPC~~ 改为 **docker exec `openclaw status --json`**(复用 openclaw CLI,Go 不实现 WS connect 握手——规避 RISK-06)
- [x] WeCom 在线:`channelSummary` 宽松解析(递归找 wecom + connected/linked/online=true)
- [x] 最后活跃:`sessions.recent[].updatedAt` 取最大 → LastActiveAt
- [x] 适配器 `gateway.ParseStatus`/`Probe` 单点隔离版本字段;exec 失败/解析失败=unhealthy
- [x] ParseStatus 单测(连上/空/present-but-down/坏 json)+ 真机 `openclaw status --json` 实采验证

### Log
- [2026-06-27] created (draft)
- [2026-06-27] 决策(RISK-06):源码实证 WS 握手含版本协商/device-token,放弃 Go 重写;改用容器内 openclaw CLI(docker exec)复用其客户端
- [2026-06-27] completed (done) — 真机 muad-oc-poc 实采到 sessions/活跃;channelSummary 连上态待真机 WeCom 在线回归

---

## TASK-011: Collector 并发轮询 + 内存缓存

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-010
- **Source**: muad-admin-console.design.md#3.5 质量实现方案

### Description
实现 Collector：后台 goroutine 池**并发**对每容器采集 `stats?stream=false`（CPU/MEM）+ gateway 适配器（在线/活跃），周期（15–30s）刷新内存缓存供 API 读取。每容器 3s 超时 + 失败隔离（标 unhealthy，不影响其余行，NFR-REL-01/E-04）。禁常驻 stats 流（RULE-06）。

### Checklist
- [x] goroutine 池(16)并发 probe + 单容器 3s 超时(context)
- [x] CPU/MEM 用 `StatsAll`(一条 `docker stats --no-stream` 取全部,比逐容器更省;RULE-06)
- [x] 失败隔离：单容器 probe 失败标 Healthy=false,不影响整轮(NFR-REL-01);仅 running 才 probe
- [x] 线程安全 monitor.Cache(RWMutex)+ Replace 原子整轮换 + Ticker 周期(首轮立即)
- [x] CollectOnce 填 cache 单测(fake driver)+ 真机 collector 对 muad-oc-poc 实采

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 启动即起后台 collector;CONSOLE_COLLECT_INTERVAL 默认 30s

---

## TASK-012: 容器列表 API + 日志 API

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-011
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-02/05：容器列表（API-02，读 Collector 内存缓存，返回 state/imageTag/cpu/memMiB/wecomConnected/lastActiveAt/reapInEta，不在请求路径现采）、日志查看（API-04，driver.Logs，tail 上限 ≤2000，B-02）。

### Checklist
- [x] `GET /api/v1/containers`：DB 用户 ⊕ driver.List 实时态 ⊕ monitor.Cache 指标(含 reapInSeconds、unhealthy 标记)
- [x] `GET /api/v1/containers/{userId}/logs?tail=N`：上限裁剪(maxLogTail=2000)
- [x] 列表合并缓存指标(S-03)、日志含内容 测试；引入 monitor.Cache 供 TASK-011 填充

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 新增 internal/monitor 缓存(011 填、012 读)；指标不在请求路径现采

---

## TASK-013: 生命周期操作 API

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-004, TASK-006
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-09：`POST /api/v1/containers/{userId}/actions/{action}`，action ∈ {start, stop, restart, reap, revive}。reap=归档保状态、revive=唤醒，复用 driver 对应方法 + 审计。

### Checklist
- [x] `POST .../actions/{action}` 白名单 start/stop/restart/reap/revive，未知 400
- [x] 映射 driver.Start/Stop/Restart/Reap/Revive + 用户不存在 404
- [x] 操作刷新 DB state（审计中间件统一落，target=userId）
- [x] 5 action 状态流转 + 非法 action 400 + 缺用户 404 测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done)

---

## TASK-014: skill 热更 API（扇出 reload）

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-006
- **Source**: muad-admin-console.design.md#3.4 接口设计, muad-admin-console.design.md#5. 风险与依赖

### Description
实现 FEAT-10：`POST /api/v1/skills/reload`，向全队容器**扇出**触发共享 skill reload，不单依赖 inotify watch（RISK-07，应对 macOS/NFS 不可靠）。上传/更新共享 skill 目录文件后调用使各容器生效。

### Checklist
- [x] `POST /api/v1/skills/reload`：遍历运行中容器扇出
- [x] 触发方式=**滚动重启**（实证无 openclaw skills reload 命令；顺序重启避免全量下线，RISK-07 显式 fallback）
- [x] 逐容器结果聚合（reloaded / failed）+ 审计
- [x] 扇出对运行容器各重启一次的测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] 实证：openclaw 无 skills reload 子命令 → 用滚动 restart 作可靠 reload 原语
- [2026-06-27] completed (done)

---

## TASK-015: LLM 批量应用 + 滚动重启

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-008, TASK-006, TASK-013
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-11：`POST /api/v1/llm/apply`，勾选存量容器批量应用当前全局 LLM 并滚动重启。仅在显式应用时动存量（RULE-03，改全局本身不影响存量）。

### Checklist
- [x] `POST /api/v1/llm/apply`：接受 userIds 列表
- [x] 逐容器从 DB 记录重建 spec（解密 secret/override + 当前全局 LLM）→ Remove(keepState) → Create（顺序=滚动）
- [x] 逐容器结果聚合（applied / not found / failed）+ 审计
- [x] 批量应用重建 + 不存在用户 not found 测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — recreateUser/specFromUser 助手与 TASK-017 共用

---

## TASK-016: 审计查询 API + 告警评估

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-002, TASK-011
- **Source**: muad-admin-console.design.md#3.4 接口设计, muad-admin-console.design.md#4.3 监控告警

### Description
实现 FEAT-12/13：审计查询（API-12，按 actor/时间范围过滤）+ 告警评估（基于 Collector 缓存周期评估 down/断连/内存>2048×85%/即将回收，输出列表标记，外发通道后置）。

### Checklist
- [x] `GET /api/v1/audit?actor=&from=&to=&limit=`：RFC3339 时间过滤 + limit(默认200) + 索引命中
- [x] `GET /api/v1/alerts`：从 cache 评估 4 类（down P1 / wecom 断连 P1 / 内存>1740MiB P2 / 即将回收 P3）
- [x] 审计查询命中 + 告警(wecom+mem)评估 测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 告警为标记式(GET /alerts)，外发通道按设计后置

---

## TASK-017: 镜像升级 API（重建保卷）

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-006
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-14：`POST /api/v1/containers/{userId}/upgrade`，按目标 image tag 重建容器并**保留状态卷**（用户记忆/会话不丢），更新 users.image_tag + 审计。

### Checklist
- [x] `POST /api/v1/containers/{userId}/upgrade`：tag 必填(空 400)、用户不存在 404
- [x] recreateUser 用新 tag 重建（Remove keepState=true 保卷、skill 挂载/env 由 Create 重渲染）
- [x] 更新 users.image_tag + 审计
- [x] 升级改 tag + 重建用新 tag + 空 tag 400 测试

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 与 TASK-015 共用 recreateUser(Remove keepState→Create)

---

## TASK-018: React SPA 骨架 + 登录页 + API client

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004
- **Source**: muad-admin-console.design.md#3.1 方案选型, muad-admin-console.design.md#3.4 接口设计

### Description
建立 React + Vite SPA 骨架：路由、登录页（对接 API-14）、带令牌的 API client、未登录重定向、布局框架。产物供 Go 二进制 embed。

### Checklist
- [x] Vite + React + TS 工程；轻量 state 导航(免 router 依赖) + 布局
- [x] 登录页 + localStorage 令牌 + 401 清 token 重登
- [x] API client(`src/api.ts`)：统一 Bearer/错误信封、全相对路径(/api/v1)
- [x] `vite build` → `dist/`(供 TASK-021 Go embed)；dev 代理 /api→:8080

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — npm run build(tsc + vite)通过

---

## TASK-019: 容器列表/监控页 + 创建表单 + 删除确认

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-018, TASK-009, TASK-012, TASK-016
- **Source**: muad-admin-console.design.md#3.4 接口设计, muad-admin-console.design.md#2.5 验收条件

### Description
实现 FEAT-01/02/03/08/13 前端：容器列表/监控页（状态、镜像、CPU/MEM、WeCom 在线、最后活跃、回收倒计时、告警标记）、创建表单（userId/botId/secret + 可选 LLM 覆盖）、删除二次确认（含「是否删卷」勾选，默认不勾，RULE-02）。

### Checklist
- [x] 列表/监控表格(5s 轮询)：状态徽标/CPU/MEM/WeCom/最后活跃/回收倒计时 + 告警条(P1红/P2黄/P3灰)
- [x] 创建表单(userId/botId/secret)+ 提交反馈
- [x] 删除二次确认 + 删卷确认(确定=删卷/取消=保留，默认保留)
- [x] 行内日志 modal + 升级(prompt tag)；"重载 skill(全队)"按钮
- [x] `npm run build` 编译验证(浏览器手测留待联调)

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done)

---

## TASK-020: LLM 配置页 + 日志 + 生命周期按钮 + 审计页

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-018, TASK-008, TASK-012, TASK-013, TASK-016
- **Source**: muad-admin-console.design.md#3.4 接口设计

### Description
实现 FEAT-04/05/09/12 前端：全局 LLM 配置页（含连通性测试按钮、保存前必测）、per-user 覆盖、日志查看面板、生命周期操作按钮（start/stop/restart/reap/revive）、审计查询页。

### Checklist
- [x] LLM 配置页：全局(provider/baseUrl/apiKey/model)+ 连通性测试按钮 + 保存(服务端复测)
- [x] 批量应用(勾选容器)+ 单用户覆盖表单
- [x] 日志面板(Containers 页 modal，tail 300)；行内生命周期按钮(start/stop/restart/reap/revive)
- [x] 审计查询页(actor 过滤 + 表格)

### Log
- [2026-06-27] created (draft)
- [2026-06-27] completed (done) — 生命周期/日志在 Containers 页，LLM/审计独立页

---

## TASK-021: 控制台多阶段 Dockerfile + GHCR tag CI

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001, TASK-018
- **Source**: muad-admin-console.design.md#4.2 控制台镜像构建与发布

### Description
实现 §4.2：多阶段 Dockerfile（① node 阶段 `vite build` 前端 → ② golang 阶段 `go build` 单二进制并 embed 前端 → ③ distroless/alpine runtime 非 root）；单镜像 `ghcr.io/<owner>/muad-console`；GitHub Actions on `push tag v*` 构建推送（沿用 muad-openclaw 现有 `build-image.yml` 同款流水线）。镜像不烤任何凭证。

### Checklist
- [x] 多阶段 Dockerfile：node vite build → golang `go build -tags prod`(embed dist) → alpine runtime
- [x] Go 后端补 `internal/web` embed(build tag:dev 免 dist/prod 内嵌)+ SPA fallback；接入 server.go "/"
- [x] runtime 带 docker-cli(DockerDriver 依赖)；镜像无凭证，全 env 注入
- [x] `.github/workflows/build-console.yml`：`console-v*` tag → GHCR ghcr.io/<owner>/muad-console
- [x] 本地 build + run 冒烟：/healthz、SPA、内置 docker CLI、登录+列表(挂 docker.sock)全通过

### Log
- [2026-06-27] created (draft)
- [2026-06-27] 偏离：runtime 用 alpine+docker-cli 以 root 运行(非 distroless 非 root)——DockerDriver 需 docker.sock(本即 root 等价 RISK-03);k8s 形态可覆盖非 root
- [2026-06-27] completed (done) — 镜像 muad-console:local 端到端构建+运行验证通过
```

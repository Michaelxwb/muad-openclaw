# Backend Retrieval Map

> AI 导航地图：定位后端代码结构和关键模块。可由 `/cf-learn --map` 重生成。

## Purpose

muad 管理/监控控制面后端。以 Pod 为运行时聚合根，管理 Human User、IM Identity、绑定码、业务平台凭证、配置代次调和、Docker/K8s 生命周期、审计和管理员认证。

## Architecture

- **Language**: Go 1.26
- **HTTP**: `net/http` (stdlib)，无第三方框架
- **Database**: SQLite（`modernc.org/sqlite`，纯 Go 实现，无 CGO）
- **Auth**: bcrypt 密码哈希 + JWT session token
- **Config**: YAML 文件 + 环境变量覆盖（env > yaml > defaults），密钥仅从 env 注入
- **Container Runtime**: Docker CLI 或 Kubernetes API（通过 `RuntimeDriver` 抽象）
- **Graceful Shutdown**: signal.NotifyContext + http.Server.Shutdown

## Key Files

| File | Purpose |
|------|---------|
| `cmd/console/main.go` | 应用入口：config → db → crypto → driver → collector → HTTP server |
| `internal/config/config.go` | 配置加载（yaml + env override），env > yaml > defaults |
| `internal/api/server.go` / `routes.go` | HTTP 中间件装配与 Pod/Human User/internal 路由注册 |
| `internal/api/auth.go` | 登录/登出/session API |
| `internal/api/pods.go` / `pod_*.go` | Pod CRUD、容量、通道、资源、服务令牌、配置应用和生命周期 |
| `internal/api/human_users.go` / `identities_api.go` / `binding_codes_api.go` | Human User、IM Identity 和绑定码管理 |
| `internal/api/platforms_api.go` / `platform_credentials_api.go` / `internal_credentials.go` | 平台配置、用户凭证和 Pod 内 Resolver |
| `internal/api/containers.go` | Pod 日志和微信扫码登录入口 |
| `internal/api/llm.go` | 全局、Pod、Human User 模型配置与连通性探测 API |
| `internal/api/audit.go` / `audit_query.go` | 审计日志写入与查询 |
| `internal/api/ops.go` / `pod_operations.go` / `pod_upgrade.go` | 批量调和、Skill reload、Pod 操作和升级回滚 |
| `internal/auth/auth.go` | bcrypt 验证 + JWT 签发/校验 |
| `internal/driver/driver.go` | 容器运行时抽象接口 |
| `internal/driver/docker.go` | Docker 驱动实现 |
| `internal/driver/k8s.go` | Kubernetes 驱动实现 |
| `internal/repo/schema.go` / `pods.go` / `human_users.go` | 全新多用户 schema、Pod 聚合、容量和 Human User 生命周期 Repository |
| `internal/repo/identities.go` / `binding_codes.go` / `platforms.go` | Identity、一次性绑定码、平台配置和加密用户凭证 Repository |
| `internal/crypto/crypto.go` | AES-GCM 加密（DB 内凭证加密存储） |
| `internal/collector/collector.go` | 有界并发采集 Pod 运行状态、容量、资源和 Guard/队列指标 |
| `internal/monitor/cache.go` | Pod 状态原子快照缓存 |
| `internal/logging/daily_writer.go` | stdout + 按日期目录切换的 Console 文件日志输出 |
| `internal/llm/probe.go` | LLM provider 连通性探测 |
| `internal/gateway/probe.go` | 通道状态探测：容器内跑 `openclaw channels status --json`（避开 operator.read scope），解析通道连接 + 最后活跃（兼容 wecom/wechat 不同字段） |
| `internal/runtimeconfig/` | 从 Pod/Human User/Identity/Platform 数据构建确定性 Runtime DTO、provider alias 与 canonical hash |
| `internal/runtimeapply/` | 在 Pod 内校验候选配置、差异化重启，并以 Gateway/Runtime Guard generation 健康检查完成原子应用和回滚 |
| `internal/usercleanup/` | 等待删除代次收敛后，按 Pod 串行清理 Human User 私有运行时状态并重试离线任务 |
| `internal/platformregistry/` | Worker 镜像内已安装业务平台 adapter 的控制面白名单 |
| `tools/session-manager/` | Node.js 24 CLI/核心：从可信 agent 上下文调用 Console Resolver，由平台 adapter 生成隔离 session state，并以 owner/fingerprint 校验和跨进程刷新锁管理缓存 |
| `tools/muad-run-skill/` | OpenClaw 通用脚本 Skill Tool：可信 agent/session/workspace 注入、public/private manifest 解析、受控入口校验与 Pod 级有界并发队列 |
| `tools/muad-runtime-guard/` | 外置 OpenClaw Runtime Guard：确定性 `/bind`、generation/映射/插件健康检查及可信工具策略入口 |
| `internal/web/web.go` | 前端静态资源嵌入（dev: 文件系统, prod: embed.FS） |
| `test/` | fake RuntimeDriver + `httptest` 的 Repository/API/运行时集成测试 |

## Module Map

```
console/backend/
├── cmd/console/main.go    # 唯一入口，装配 wiring
├── internal/
│   ├── api/               # HTTP handler（路由 + 请求校验 + 响应）
│   ├── auth/              # 认证逻辑（bcrypt + JWT）
│   ├── config/            # 配置加载与校验
│   ├── crypto/            # AES-GCM 加解密
│   ├── driver/            # 容器运行时抽象（Docker / K8s）
│   ├── collector/         # 后台采集器
│   ├── monitor/           # 内存缓存
│   ├── logging/           # stdout 与按日目录文件日志
│   ├── repo/              # 数据访问层（SQLite）
│   ├── llm/               # LLM 连通性探测
│   ├── gateway/           # 网关探测
│   ├── runtimeconfig/     # 多用户 Runtime DTO 聚合与规范化
│   ├── runtimeapply/      # Runtime DTO 原子应用、健康检查与失败回滚
│   ├── usercleanup/       # Human User 私有状态延迟清理与重试
│   ├── platformregistry/  # 已安装 session adapter 注册表
│   └── web/               # 前端嵌入（dev/prod 双模式）
├── test/                  # 集成测试
├── data/                  # SQLite 数据库文件（运行时）
├── config.yaml            # 配置文件
├── config.example.yaml    # 配置示例
├── go.mod / go.sum        # Go 模块定义
└── Dockerfile             # 控制台镜像构建
```

`tools/session-manager/src/` 关键模块：`resolver-client.ts` 负责短超时凭证解析，`adapters/` 是已安装平台注册表与登录态交换边界，`session-store.ts` 原子保存用户私有 Cookie/storageState，`refresh-lock.ts` 提供跨进程单飞与超时锁回收。

## Data Flow

```
HTTP Request
  → api.Server (mux + middleware)
    → auth package (JWT validation)
    → api handler (请求解析、参数校验)
      → repo (SQLite CRUD)
      → crypto (凭证加解密)
      → driver (Docker/K8s 容器操作)
    → JSON Response ({ code, message, data })
```

后台采集:
```
collector.Run (ticker)
  → driver.List() / StatsAll() / gateway.Probe()
  → repo.ListPods() / effective resource limits
  → monitor.Cache (atomic update)
```

## Navigation Guide

- 新增 API → `internal/api/` 添加 handler + 在 `routes.go` 注册路由
- 新增数据库操作 → 按聚合放入 `internal/repo/<domain>.go`，schema 放 `schema.go`
- 新增容器运行时 → `internal/driver/` 实现 `RuntimeDriver` 接口 + `factory.go` 注册
- 配置项 → `internal/config/config.go`，添加 yaml field + env override + defaults
- 测试 → `test/` 目录，文件命名 `<package>_test.go`
- 前端嵌入 → dev 模式 `web/embed_dev.go` 读文件系统；prod 模式 `embed_prod.go` 用 `//go:embed`

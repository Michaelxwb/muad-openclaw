# Backend Retrieval Map

> AI 导航地图：定位后端代码结构和关键模块。可由 `/cf-learn --map` 重生成。

## Purpose

muad 管理/监控控制面（control plane）后端。作为多用户 openclaw Agent 平台的管理入口，提供：容器生命周期管理（Docker/K8s）、LLM 连通性探测、用户审计日志、管理员认证。

## Architecture

- **Language**: Go 1.26
- **HTTP**: `net/http` (stdlib)，无第三方框架
- **Database**: SQLite（`modernc.org/sqlite`，纯 Go 实现，无 CGO）
- **Auth**: bcrypt 密码哈希 + JWT session token
- **Config**: YAML 文件 + 环境变量覆盖（env > yaml > defaults），密钥仅从 env 注入
- **Container Runtime**: Docker SDK 或 Kubernetes API（通过 `driver` 抽象）
- **Graceful Shutdown**: signal.NotifyContext + http.Server.Shutdown

## Key Files

| File | Purpose |
|------|---------|
| `cmd/console/main.go` | 应用入口：config → db → crypto → driver → collector → HTTP server |
| `internal/config/config.go` | 配置加载（yaml + env override），env > yaml > defaults |
| `internal/api/server.go` | HTTP 路由注册与中间件装配 |
| `internal/api/auth.go` | 登录/登出/session API |
| `internal/api/containers.go` | 用户容器 CRUD + 日志 + 微信扫码登录（`GET /containers/{id}/qrcode`，触发 `openclaw channels login` 抓二维码） |
| `internal/api/llm.go` | LLM 连通性探测 API |
| `internal/api/audit.go` / `audit_query.go` | 审计日志写入与查询 |
| `internal/api/ops.go` | 运维操作 API |
| `internal/auth/auth.go` | bcrypt 验证 + JWT 签发/校验 |
| `internal/driver/driver.go` | 容器运行时抽象接口 |
| `internal/driver/docker.go` | Docker 驱动实现 |
| `internal/driver/k8s.go` | Kubernetes 驱动实现 |
| `internal/repo/repo.go` | SQLite 数据访问层（用户、会话、审计），含 `channel` 列（wecom/wechat，附加迁移 ALTER ADD COLUMN）；ListUsers/QueryAudit 支持分页（COUNT + LIMIT/OFFSET） |
| `internal/crypto/crypto.go` | AES-GCM 加密（DB 内凭证加密存储） |
| `internal/collector/collector.go` | 后台容器状态采集 |
| `internal/monitor/cache.go` | 容器状态内存缓存 |
| `internal/llm/probe.go` | LLM provider 连通性探测 |
| `internal/gateway/probe.go` | 通道状态探测：容器内跑 `openclaw channels status --json`（避开 operator.read scope），解析通道连接 + 最后活跃（兼容 wecom/wechat 不同字段） |
| `internal/web/web.go` | 前端静态资源嵌入（dev: 文件系统, prod: embed.FS） |
| `test/` | 集成测试（10 个 `*_test.go` 文件） |

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
│   ├── repo/              # 数据访问层（SQLite）
│   ├── llm/               # LLM 连通性探测
│   ├── gateway/           # 网关探测
│   └── web/               # 前端嵌入（dev/prod 双模式）
├── test/                  # 集成测试
├── data/                  # SQLite 数据库文件（运行时）
├── config.yaml            # 配置文件
├── config.example.yaml    # 配置示例
├── go.mod / go.sum        # Go 模块定义
└── Dockerfile             # 控制台镜像构建
```

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
  → driver.List() / driver.Inspect()
  → monitor.Cache (atomic update)
  → repo (审计写入)
```

## Navigation Guide

- 新增 API → `internal/api/` 添加 handler + 在 `server.go` 注册路由
- 新增数据库操作 → `internal/repo/repo.go` 添加方法
- 新增容器运行时 → `internal/driver/` 实现 `Driver` 接口 + `factory.go` 注册
- 配置项 → `internal/config/config.go`，添加 yaml field + env override + defaults
- 测试 → `test/` 目录，文件命名 `<package>_test.go`
- 前端嵌入 → dev 模式 `web/embed_dev.go` 读文件系统；prod 模式 `embed_prod.go` 用 `//go:embed`

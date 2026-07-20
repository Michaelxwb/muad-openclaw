# Backend Retrieval Map

> Console 控制面后端导航地图。路径均相对仓库根。

## Purpose

`console/backend` 是 muad-openclaw 管理控制面：Pod/用户/身份/模型/Skill/审计 API，编排 Docker/K8s RuntimeDriver，并向 Worker 下发 runtime config。

## Architecture

- Language: Go 1.26
- Layout: `cmd/console` 入口 + `internal/*` 业务包
- Storage: SQLite via `internal/repo`（modernc.org/sqlite）
- Runtime: `internal/driver` 抽象 Docker / Kubernetes
- Apply path: `runtimeconfig` 构建 DTO → `runtimeapply` 事务应用
- Frontend: 生产构建由 `internal/web` 嵌入

## Key Files

| File | Purpose |
|------|---------|
| `console/backend/cmd/console/main.go` | 进程入口、依赖装配、信号退出 |
| `console/backend/internal/api/` | HTTP 路由、handler、错误码 |
| `console/backend/internal/repo/` | 持久化、schema、查询 |
| `console/backend/internal/driver/` | RuntimeDriver（docker/k8s） |
| `console/backend/internal/runtimeconfig/` | 多用户 runtime 配置构建 |
| `console/backend/internal/runtimeapply/` | 配置事务 apply + 健康/回滚 |
| `console/backend/internal/auth/` / `crypto/` | 鉴权与敏感字段编解码 |
| `console/backend/internal/audit/` / `collector/` | 操作审计与采集 |
| `console/backend/internal/config/` | 服务配置加载 |
| `console/backend/test/` | 集成/API 测试 |

## Module Map

```
console/backend/
├── cmd/console/          # main
├── internal/
│   ├── api/              # HTTP surface
│   ├── repo/             # SQLite + domain models
│   ├── driver/           # Docker/K8s runtime
│   ├── runtimeconfig/    # desired config builder
│   ├── runtimeapply/     # atomic apply pipeline
│   ├── auth/ crypto/ llm/ gateway/ monitor/
│   └── web/              # embed SPA
├── test/
└── config.example.yaml
```

## Related Domains

- 管理台 UI：`frontend`
- Worker 脚本/插件/Skill：`runtime`

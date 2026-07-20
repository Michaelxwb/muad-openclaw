---
id: backend-directory-structure
description: 新建/移动 Console 后端文件时适用：Go 包边界与目录约束
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-backend-directory-001
    type: manual
    config:
      checklist: Confirm Go code lives under console/backend with cmd/internal separation and no cross-layer imports.
      owner: project-owner
---

# Backend Directory Structure

## Examples

✅ API 调 repo/driver，不直接拼 SQL 字符串散落

```go
// internal/api/pods.go → s.store.ListPods(...)
// internal/repo/pods.go → 查询实现
```

❌ handler 内嵌大段 SQL / 直接调 docker SDK

```go
func (s *Server) handlePods(w http.ResponseWriter, r *http.Request) {
    db.Query(`SELECT * FROM pods`) // 越层
}
```

## Rules
- [RULE-backend-directory-001] Console backend code must live under `console/backend/` with `cmd/` entrypoints and `internal/` packages; handlers must not own persistence or runtime-driver details.

## Guidance
- 入口只放 `cmd/console`；业务实现进 `internal/<pkg>`
- `api`：HTTP 编解码、鉴权中间件、调用下层
- `repo`：schema、CRUD、迁移；是唯一持久化边界
- `driver`：容器/K8s 操作唯一出口
- `runtimeconfig` / `runtimeapply`：配置构建与事务应用，不混进 handler
- 测试：包内 `*_test.go` + `console/backend/test` 集成测
- 禁止在仓库根再开平行 Go module 承载 console 控制面逻辑

## Patterns
- 新资源：`api` 路由 + `repo` 模型 +（如需）`driver`/`runtimeconfig` 扩展
- 共享 DTO 放靠近使用方的 package，避免循环依赖
- 资源配额、generation、apply 状态机逻辑集中，不复制到多个 handler

## Avoid
- 禁止 api → 跳过 repo 直连 sqlite
- 禁止在 api 包 import docker/k8s client（应经 driver）
- 禁止把 Worker 镜像内脚本逻辑复制进 backend 而不抽边界

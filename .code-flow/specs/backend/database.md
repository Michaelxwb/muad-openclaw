---
id: backend-database
description: Console 后端 SQLite/schema/迁移与数据访问约束
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-backend-database-001
    type: manual
    config:
      checklist: Confirm parameterized queries, explicit columns, repo-only access, and reversible/idempotent schema changes.
      owner: project-owner
  - rule: RULE-backend-no-select-star-001
    type: regex
    config:
      pattern: "SELECT\\s+\\*"
      files:
        - console/backend/**
      message: "禁止 SELECT *，查询须显式列名"
---

# Backend Database

## Examples

✅ 参数化 + 显式列 + repo 边界

```go
// internal/repo/pods.go
row := db.QueryRow(`SELECT id, name FROM pods WHERE id = ?`, id)
```

❌ 字符串拼接 / SELECT *

```go
db.Query("SELECT * FROM pods WHERE id = '" + id + "'")
```

## Rules
- [RULE-backend-database-001] All SQL must be parameterized and confined to `internal/repo` (or explicit migration helpers); schema changes must be idempotent or versioned and must not destroy user data silently.
- [RULE-backend-no-select-star-001] Queries must list explicit columns; do not use `SELECT *` in production SQL.

## Guidance
- 持久化只经 `internal/repo`；schema 变更集中在 schema/migration 文件
- SQLite 下注意并发与长事务；apply/generation 更新要原子
- 列表接口分页/过滤条件在 repo 实现，禁止无界扫大表到 handler
- 删除 Human User / Pod 必须考虑级联清理与残留工作区策略（见 usercleanup）
- 测试覆盖 schema 升级与关键查询（`console/backend/test/schema_test.go` 等）

## Patterns
- 模型字段与 API DTO 分离，避免把存储列直接当外部契约
- 迁移可重复执行（IF NOT EXISTS / 版本号）
- 共享列清单用 const SQL 片段（如 `humanUserColumns`）避免漂移

## Avoid
- 禁止 SQL 字符串拼接用户输入
- 禁止在 handler 内开裸 `sql.DB` 旁路 repo
- 禁止破坏性迁移不备份/不说明
- 禁止 `SELECT *`

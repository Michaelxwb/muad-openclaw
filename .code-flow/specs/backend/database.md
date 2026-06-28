---
description: 涉及数据库/ORM/迁移/查询时适用：schema 与数据访问约束
---

# Backend Database

## Examples

✅ 参数化查询，明确列出字段

```python
cur.execute("SELECT id, name FROM users WHERE email = %s", (email,))
```

❌ 字符串拼接用户输入（SQL 注入）+ `SELECT *`

```python
cur.execute(f"SELECT * FROM users WHERE email = '{email}'")
```

## Rules
- 所有 SQL 必须参数化，禁止字符串拼接 / 模板插值用户输入
- 迁移脚本必须可回滚，或写成幂等脚本（`IF NOT EXISTS` / `ON CONFLICT`）
- 事务边界明确：跨表写入必须在同一事务内，禁止"半提交"状态
- 涉及索引/锁的 schema 变更必须评估线上影响，大表慎用 `ALTER TABLE` 阻塞操作
- 每个 model 必须有对应 CRUD 抽象层（`crud/<model>.py` 或 `repositories/<Model>Repo`），业务代码只调 CRUD，禁止在 service / handler 直接写 ORM 查询或裸 SQL

## Patterns
- 读写分离场景显式标注读库/写库，强一致读走主库
- N+1 查询用预加载（`joinedload` / `include` / `Preload`）解决
- 大批量写入分批 + commit，避免单事务过大
- 缓存与数据库一致性：先写库再失效缓存（`cache-aside`）
- CRUD 基类统一实现 `get / list / create / update / delete / bulk_*`，子类只扩展模型特有查询

## Anti-Patterns
- 禁止在事务内发起外部 HTTP / RPC 调用，超时会导致连接池耗尽
- 禁止在循环中执行单条 `INSERT` / `UPDATE`，必须批量化
- 禁止在 ORM 之外手写 SQL 时绕过参数绑定
- 禁止用 `SELECT *` 上线，明确列出字段控制传输与索引

## Project-Specific Notes

- **[go.mod]** SQLite 驱动：`modernc.org/sqlite`（纯 Go，无 CGO，跨平台编译友好）
- **[internal/repo/repo.go]** 无 ORM，使用 `database/sql` 标准库 + 手写 SQL；所有查询参数化
- **[config.yaml / config.go]** DB 路径通过 `dbPath` 配置（yaml + `CONSOLE_DB` env override），默认 `/var/lib/muad-console/console.db`
- **[internal/repo/repo.go:94-130]** 数据库迁移使用内联 `CREATE TABLE IF NOT EXISTS` DDL（幂等），写在 Go 源码中而非独立 `.sql` 文件；策略：只增不删，无 `DROP`/`ALTER`，新增字段用 `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- **[internal/repo/repo.go:68-89]** SQLite 连接配置：`busy_timeout(5000)` + `journal_mode(WAL)` + `foreign_keys(1)` pragma；`SetMaxOpenConns(1)` 避免并发写冲突

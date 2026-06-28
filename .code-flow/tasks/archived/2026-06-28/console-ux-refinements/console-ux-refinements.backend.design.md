# 控制台交互优化 后端模块需求与设计简报

> **文档编号**: MOD-CONSOLE-PAGINATION-v1
> **文档版本**: v1.0
> **创建日期**: 2026-06-28
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（技术设计）→ 通过后锁定设计基线

**ID 体系**: US（来自 PRD）、FEAT（功能）、API（接口）、NFR（非功能指标）
场景编号：S-（正常）、E-（异常）、B-（边界，按需）

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 需求分析](#2-需求分析)
  - [2.1 需求概述](#21-需求概述-必填)
  - [2.2 功能方案](#22-功能方案-必填)
  - [2.3 范围与边界](#23-范围与边界-必填)
  - [2.4 验收条件](#24-验收条件-必填)
- [3. 技术设计](#3-技术设计)
  - [3.1 技术选型](#31-技术选型-必填)
  - [3.2 接口设计](#32-接口设计-必填)
  - [3.3 性能与容量考量](#33-性能与容量考量-按需)
- [4. 风险与依赖](#4-风险与依赖)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 | — | 技术方案、代码实现 |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-06-28 | Claude | 初始草稿，PRD 派生 |

---

## 2. 需求分析

> 以下内容继承自 PRD: `console-ux-refinements.prd.md`

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | 控制台后端分页 API（console/backend） |
| **需求类型** | 功能开发（API 改造） |
| **业务背景** | 前端交互优化需要后端列表 API 支持分页，替代当前全量返回。容器数量增长后全量加载变慢。 |
| **核心目标** | 为容器列表和审计日志两个 API 增加 offset/limit/total 分页能力 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-03 | 容器列表后端分页 | `/api/v1/containers` 增加 `offset`/`limit` 查询参数，响应增加 `total` | P0 | US-03 |
| FEAT-06 | 审计日志后端分页 | `/api/v1/audit` 增加 `offset`/`limit`/`from`/`to` 查询参数，响应增加 `total` | P1 | US-06 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | ① `GET /api/v1/containers` 加 offset/limit/total ② `GET /api/v1/audit` 加 offset/limit/from/to/total ③ repo 层对应方法改造 ④ 测试更新 |
| **非范围（Out of Scope）** | ① 不新增 API endpoint ② 不改动数据库 schema ③ 不加排序参数 ④ 不加缓存层 |
| **有意妥协 / 技术债** | COUNT(*) 和 SELECT 不在同一事务（SQLite 单写连接下可接受） |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 操作步骤 | 预期结果 |
|--------|--------|--------|---------|---------|
| S-01 | FEAT-03 | P0 | `GET /api/v1/containers?offset=0&limit=20` | 返回 `{ items: [...], total: N }`，items 最多 20 条 |
| S-02 | FEAT-03 | P0 | `GET /api/v1/containers?offset=20&limit=20` | 返回第 21-40 条，total 不变 |
| S-03 | FEAT-06 | P1 | `GET /api/v1/audit?offset=0&limit=20` | 返回 `{ items: [...], total: N }` |
| S-04 | FEAT-06 | P1 | `GET /api/v1/audit?actor=admin&from=2026-01-01&to=2026-12-31&offset=0&limit=20` | 返回筛选后的分页结果 |

**异常场景**

| 场景ID | 功能ID | 触发条件 | 预期行为 |
|--------|--------|---------|---------|
| E-01 | FEAT-03 | `offset` 非数字或负数 | 忽略或默认为 0 |
| E-02 | FEAT-03 | `limit` 非数字 或 >100 | 截断为 100 |
| E-03 | FEAT-03 | 无参数（兼容旧调用） | 默认 offset=0, limit=20 |
| E-04 | FEAT-06 | `from`/`to` 非 RFC3339 格式 | 忽略该参数（无过滤） |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 分页查询响应 | < 200ms | Go test benchmark 或 curl 计时 |
| NFR-SEC-01 | limit 上限校验 | ≤100 | 代码审查 |

---

## 3. 技术设计

### 3.1 技术选型

| 类别 | 选型 | 说明 |
|------|------|------|
| 语言 | Go 1.26 | 现有 |
| HTTP | `net/http` (stdlib) | 现有，Go 1.22+ ServeMux |
| 数据库 | SQLite via `modernc.org/sqlite` | 现有 |
| 分页策略 | LIMIT/OFFSET | SQL 原生支持，实现简单；数据量 < 1000 时性能足够 |

> 放弃游标分页（keyset pagination）：当前无排序需求，LIMIT/OFFSET 更简单，SQLite 下 COUNT + OFFSET 在千级数据量下 < 10ms。

### 3.2 接口设计

#### API-01: `GET /api/v1/containers`（改造）

**请求**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `offset` | int | 否 | 0 | 跳过条数 |
| `limit` | int | 否 | 20 | 返回条数（上限 100） |

**响应** `200 OK`

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "userId": "alice",
        "state": "running",
        "imageTag": "muad-openclaw:local",
        "cpuPercent": 1.5,
        "memMiB": 200,
        "wecomConnected": true,
        "lastActiveAt": "2026-06-28T10:00:00Z",
        "reapInSeconds": 864000
      }
    ],
    "total": 42
  }
}
```

> `items` 元素字段与当前 `containerView` 一致，仅外层包裹 `{ items, total }`。

**错误码**

| code | 说明 |
|------|------|
| 50001 | 数据库查询失败 |

**实现要点**

- `handleListContainers` 解析 `r.URL.Query().Get("offset")` / `Get("limit")`
- `limit` 校验：`if limit <= 0 || limit > 100 { limit = 20 }`
- `offset` 校验：`if offset < 0 { offset = 0 }`
- 调用 `s.store.ListUsers(offset, limit)` 返回 `([]User, int, error)`

---

#### API-02: `GET /api/v1/audit`（改造）

**请求**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `actor` | string | 否 | `""` | 操作人筛选（已有） |
| `from` | RFC3339 | 否 | `""` | 起始时间（新增） |
| `to` | RFC3339 | 否 | `""` | 结束时间（新增） |
| `offset` | int | 否 | 0 | 跳过条数（新增） |
| `limit` | int | 否 | 20 | 返回条数（新增，上限 100） |

**响应** `200 OK`

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "ID": 1,
        "Actor": "root",
        "Action": "create_container",
        "Target": "alice",
        "Payload": "",
        "TS": "2026-06-28T10:00:00Z"
      }
    ],
    "total": 156
  }
}
```

> `items` 元素字段与当前 `AuditEntry` 一致，仅外层包裹。

**实现要点**

- `handleAuditQuery` 解析新增 query 参数
- 调用 `s.store.QueryAudit(actor, from, to, offset, limit)` 返回 `([]AuditEntry, int, error)`

---

#### 内部函数接口变更

**`repo.Store`**

```go
// 改造前
ListUsers() ([]User, error)
QueryAudit(actor string, from, to time.Time, limit int) ([]AuditEntry, error)

// 改造后
ListUsers(offset, limit int) ([]User, int, error)
QueryAudit(actor string, from, to time.Time, offset, limit int) ([]AuditEntry, int, error)
```

**实现模式**（`ListUsers` 为例）：

```go
func (s *Store) ListUsers(offset, limit int) ([]User, int, error) {
    // 1. COUNT
    var total int
    if err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&total); err != nil {
        return nil, 0, err
    }
    // 2. SELECT with LIMIT/OFFSET
    rows, err := s.db.Query(
        `SELECT user_id, bot_id, ... FROM users ORDER BY user_id LIMIT ? OFFSET ?`,
        limit, offset,
    )
    // ... scan rows as before
    return users, total, nil
}
```

`QueryAudit` 同理，COUNT 时复用 actor/from/to 条件，SELECT 时追加 `ORDER BY id DESC LIMIT ? OFFSET ?`。

### 3.3 性能与容量考量

| 维度 | 分析 |
|------|------|
| **数据规模** | 容器记录 < 1000 条；审计日志可增长至数万条 |
| **热点路径** | 容器列表每 5s 轮询一次；审计日志手动查询 |
| **COUNT 性能** | SQLite `SELECT COUNT(*) FROM users` 在千级记录下 < 1ms；审计 `audit_log` 有 `idx_audit_ts` 索引，按时间范围 COUNT 可利用索引 |
| **LIMIT/OFFSET** | 大 OFFSET（如 1000+）在 SQLite 下性能下降，但当前数据量可忽略 |
| **Selected 方案** | 单查询 COUNT + SELECT，放弃"先 SELECT 全部再切片"（全量查询 O(n) vs 分页 O(limit)）；放弃缓存 COUNT（数据实时性要求 + 写入频率低） |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 |
|--------|------|------|---------|
| RISK-01 | `ListUsers`/`QueryAudit` 签名变更导致编译错误 | 调用方和测试需同步更新 | 全局搜索调用点，批量更新 |
| RISK-02 | 审计日志 COUNT 在大时间范围下可能慢 | 查询超时 | `audit_log` 已有 `idx_audit_ts` 索引；必要时加 `EXPLAIN QUERY PLAN` 验证 |

---

*文档结束*

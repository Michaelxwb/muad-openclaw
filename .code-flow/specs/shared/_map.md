# Shared Specs Navigation Map

> 跨域共享模板（PRD/Design）。约束规范在 frontend / backend / runtime。

## Purpose

供 `cf-task:prd` 与 `cf-task:align` 显式读取的文档模板；**不会**按路径自动注入为编码约束。

## Templates

### PRD

| 文件 | 用途 |
|------|------|
| `prd-template.md` | 产品需求文档 |

### Design

| 文件 | 用途 |
|------|------|
| `design/design-lite.md` | 轻量设计（小功能/修复） |
| `design/design-full.md` | 完整设计（架构/跨系统） |
| `design/design-frontend.md` | 前端模块设计 |

## Domains In This Project

| Domain | Root paths | Specs |
|--------|------------|-------|
| frontend | `console/frontend/**` | UI、Semi、api.ts |
| backend | `console/backend/**` | Go 控制面、repo、driver、apply |
| runtime | `bin/**` `tools/**` `skills/**` `k8s/**` 镜像入口 | Worker、隔离、Skill、配置事务 |

## Workflow

```
需求 → cf-task:prd → .prd.md
     → cf-task:align → .design.md
     → cf-task:plan  → tasks + Acceptance
     → cf-task:start → active Context
```

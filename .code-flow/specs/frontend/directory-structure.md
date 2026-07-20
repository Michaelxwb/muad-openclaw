---
id: frontend-directory-structure
description: 新建/移动 Console 前端文件时适用：目录、页面、组件与 API 分层
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-frontend-directory-001
    type: manual
    config:
      checklist: Confirm frontend files live under console/frontend and keep api/types/hooks/pages separation.
      owner: project-owner
  - rule: RULE-frontend-api-types-001
    type: manual
    config:
      checklist: Confirm types live in types/api.ts, re-exported from api.ts, no drifting DTOs or hard-coded paths outside api.ts.
      owner: project-owner
---

# Frontend Directory Structure

## Examples

✅ 类型在 types/api.ts，请求在 api.ts，页面只消费 api

```ts
// console/frontend/src/types/api.ts — 契约类型
// console/frontend/src/api.ts — request + export type * + api 命名空间
import { api } from "../../api";
const { items } = await api.listPods();
```

❌ 组件内裸 fetch 或复制 REST 路径字符串

```tsx
const res = await fetch("/api/v1/pods").then((r) => r.json());
```

## Rules
- [RULE-frontend-directory-001] Console frontend source must live under `console/frontend/`; HTTP access must go through `src/api.ts` (or thin wrappers over it), not ad-hoc `fetch` in pages/components.
- [RULE-frontend-api-types-001] Shared request/response types live in `src/types/api.ts` and are re-exported from `api.ts`; pages/components must not redefine drifting DTOs or hard-code API path strings outside `api.ts`.

## Guidance
- 源码根固定为 `console/frontend/src/`，禁止在仓库根或 `console/` 旁再开平行前端树
- 页面放 `pages/`，可按业务分子目录（`pages/audit/`、`pages/containers/`）
- 跨页复用 UI 放 `components/`；仅单页复用的子组件可留在该 page 目录
- 复用异步/状态逻辑提取为 `hooks/useXxx.ts` 或 page 内 `useXxx.ts`
- 新增接口：先改 `types/api.ts` + `api.ts`，再改调用方
- 样式：全局 token/重置进 `styles.css`；组件/页面样式用 `*.module.css`

## Patterns
- 页面 = 容器（拉数 + 编排）+ 展示组件（props 驱动）
- 列表页常见拆分：`model.ts` / `useXxxList.ts` / `XxxTable.tsx` / `XxxToolbar.tsx`
- 对话框与主表解耦，避免单文件超过 ~300 行

## Avoid
- 禁止在展示组件内直接 `fetch` / 硬编码 host 或 `/api/v1/...` 路径
- 禁止把业务 API 类型只写在组件文件内且与 `types/api.ts` 漂移
- 禁止新增与 `console/frontend` 无关路径却期望命中 frontend specs

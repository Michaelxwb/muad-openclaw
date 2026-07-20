# Frontend Retrieval Map

> Console 管理台前端导航地图。路径均相对仓库根。

## Purpose

`console/frontend` 是 muad-openclaw 管理控制台 SPA：管理 Pod、Human User、IM 身份、模型池、Skill、审计与平台设置。

## Architecture

- Framework: React 18 + TypeScript + Vite
- UI: Semi Design (`@douyinfe/semi-ui`)
- State: 页面/组件局部状态 + hooks；API 经 `src/api.ts` 收口
- Routing: 页面组件挂在 `App.tsx`（无独立 router 包）
- Styling: 全局 `styles.css` + 组件/页面 CSS Modules
- Build: Vite；生产构建由 backend `internal/web` 嵌入

## Key Files

| File | Purpose |
|------|---------|
| `console/frontend/src/main.tsx` | 入口，Semi ConfigProvider + StrictMode |
| `console/frontend/src/App.tsx` | 根布局、页面切换、鉴权壳 |
| `console/frontend/src/api.ts` | 全部后端 HTTP 客户端（相对路径） |
| `console/frontend/src/types/api.ts` | 与后端契约对齐的 TS 类型 |
| `console/frontend/src/channels.ts` | IM 通道枚举与展示 |
| `console/frontend/src/components/` | 通用 UI / 人用户 / 平台设置组件 |
| `console/frontend/src/pages/` | 页面：Containers、Users、Skills、LLM、Audit… |
| `console/frontend/src/hooks/` | 复用 hooks（如 `useMountedRef`） |
| `console/frontend/test/` | vitest 测试 |

## Module Map

```
console/frontend/
├── src/
│   ├── main.tsx / App.tsx / api.ts / types/
│   ├── components/          # 通用 + human-users + platforms
│   ├── pages/               # 业务页面与子目录 hooks/model
│   ├── hooks/
│   └── styles.css
├── test/
└── package.json
```

## Related Domains

- 后端 API / 嵌入：`backend`（`console/backend`）
- Worker 运行时、镜像、Skill 执行：`runtime`

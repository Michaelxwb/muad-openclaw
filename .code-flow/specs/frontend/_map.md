# Frontend Retrieval Map

> AI 导航地图：定位前端代码结构和关键模块。可由 `/cf-learn --map` 重生成。

## Purpose

muad 管理控制台前端 SPA。管理员通过浏览器登录后管理用户容器、探测 LLM 连通性、查看审计日志。

## Architecture

- **Framework**: React 18（函数组件 + hooks）
- **Language**: TypeScript 5.5（`strict: true`）
- **Build**: Vite 5 + `@vitejs/plugin-react`
- **Routing**: 无路由库，通过条件渲染切换页面（当前为单页管理后台）
- **Layout**: 左侧固定 Sidebar（200px）导航 + 右侧主内容区；未登录时不渲染 Sidebar
- **State**: 局部 `useState`，无全局状态管理库
- **Styling**: CSS Modules（组件级样式隔离，`*.module.css`）+ 全局设计 tokens（`:root` 变量，`styles.css`）——赛博朋克青紫霓虹主题
- **Lint/Format**: ESLint 10（flat config）+ Prettier 3
- **Test**: vitest 4 + @testing-library/react + jsdom
- **API 调用**: `src/api.ts` 统一封装 `fetch`（含 `me()`/`login()`/`listContainers()`/`alerts()`/`audit()` 等，支持分页参数 offset/limit），dev 模式下 `/api` proxy 到 Go 后端 `:8080`
- **Pagination**: 容器列表客户端分页（全量加载→前端切片）；审计日志后端分页（offset/limit/total）
- **生产部署**: Vite build → `dist/` → Go 后端 `embed.FS` 嵌入服务

## Key Files

| File | Purpose |
|------|---------|
| `src/main.tsx` | 应用入口，`createRoot` 挂载到 `#root` |
| `src/App.tsx` | 根组件：登录态判断、页面路由（条件渲染）、组装 Sidebar + 页面 |
| `src/App.module.css` | App flex 布局（Sidebar + main） |
| `src/api.ts` | HTTP 请求封装（base URL、auth header、JSON 解析、401 自动登出）；含分页、qrcode 等方法 |
| `src/channels.ts` | 消息通道元数据（`CHANNELS` 列表 + `channelMeta`）：标签/图标，前端渲染与过滤的单一登记处 |
| `src/styles.css` | 全局设计 tokens（16 个 `:root` 变量）+ reset + keyframes 动画 |
| `src/vite-env.d.ts` | CSS Modules 类型声明 |
| `src/components/Sidebar.tsx` | 左侧固定侧边栏：Brand + Nav Menu + NotificationBell + UserInfo + 退出 |
| `src/components/NotificationBell.tsx` | 告警铃铛容器：30s 轮询 + 红色数量徽章 + 下拉面板 |
| `src/components/CreateModal.tsx` | 创建容器模态框容器：表单校验 + busy 状态 + Esc 关闭 |
| `src/components/ActionDropdown.tsx` | hover 下拉操作菜单（"更多操作"聚合 5 项容器操作） |
| `src/components/Pagination.tsx` | 共享分页控件（Containers + Audit 复用）：上一页/下一页 + 页码信息 + 每页数量 Select |
| `src/components/Select.tsx` | 自定义下拉组件（替代原生 `<select>`，全主题化 option 列表） |
| `src/components/Modal.tsx` | 通用对话框壳（替代原生 confirm/prompt）：固定头/底 + body 单一滚动 + `wide` 变体 + 遮罩/Esc 关闭；创建/升级/删除/重载/日志/扫码弹窗均基于它 |
| `src/pages/Login.tsx` | 登录页面（霓虹发光卡片 + 扫描线背景） |
| `src/pages/Containers.tsx` | 容器管理页面：Toolbar + Grid + ActionDropdown + Pagination + CreateModal |
| `src/pages/LLM.tsx` | LLM 配置页面：三块卡片（全局配置 / 连通性测试 / 批量应用与覆盖） |
| `src/pages/Audit.tsx` | 审计日志页面：Toolbar + 骨架屏 + 表格 + Pagination |
| `eslint.config.js` | ESLint flat config（TypeScript recommended） |
| `.prettierrc` | Prettier 格式化配置 |
| `vitest.config.ts` | vitest 测试配置（jsdom environment） |
| `vite.config.ts` | Vite 配置（React 插件 + dev proxy） |
| `tsconfig.json` | TypeScript 配置（strict、ES2020、react-jsx） |

## Module Map

```
console/frontend/
├── src/
│   ├── main.tsx              # 入口
│   ├── App.tsx               # 根组件（Sidebar + 页面路由）
│   ├── App.module.css        # Sidebar + main flex 布局
│   ├── api.ts                # API 封装层（分页、qrcode 等）
│   ├── channels.ts           # 消息通道元数据（标签/图标）
│   ├── styles.css            # 全局 tokens + reset + keyframes
│   ├── vite-env.d.ts         # TypeScript 类型声明
│   ├── components/           # 通用组件（容器/展示分离）
│   │   ├── Sidebar.tsx
│   │   ├── Sidebar.module.css
│   │   ├── NotificationBell.tsx
│   │   ├── NotificationBell.module.css
│   │   ├── CreateModal.tsx
│   │   ├── CreateModal.module.css
│   │   ├── ActionDropdown.tsx
│   │   ├── ActionDropdown.module.css
│   │   ├── Pagination.tsx
│   │   ├── Pagination.module.css
│   │   ├── Select.tsx
│   │   ├── Select.module.css
│   │   ├── Modal.tsx
│   │   └── Modal.module.css
│   └── pages/                # 页面级组件（含各自 .module.css）
│       ├── Login.tsx
│       ├── Login.module.css
│       ├── Containers.tsx
│       ├── Containers.module.css
│       ├── LLM.tsx
│       ├── LLM.module.css
│       ├── Audit.tsx
│       └── Audit.module.css
├── index.html                # HTML 模板
├── package.json              # 依赖与脚本（check/lint/format/test）
├── tsconfig.json             # TypeScript 配置
├── vite.config.ts            # Vite 构建配置
├── vitest.config.ts          # vitest 测试配置
├── eslint.config.js          # ESLint flat config
├── .prettierrc               # Prettier 格式化配置
└── dist/                     # 构建产物（vite build）
```

## Data Flow

```
User Action (click / form submit)
  → Event Handler (page component)
    → api.ts (fetch with auth header)
      → Go Backend (:8080 /api/*)
    → setState (update UI)
  → Re-render

Auth Flow:
  Login → api.post('/api/v1/auth/login') → JWT token stored in localStorage
  → all subsequent API calls include Authorization: Bearer <token>
  → 401 response auto-clears token, redirects to login

User Info:
  App mount → Sidebar mount → useEffect → api.me() → GET /api/v1/me
  → display username in sidebar bottom; failure → "未知用户"

Alerts:
  NotificationBell (inside Sidebar) → setInterval 30s → api.alerts() → GET /api/v1/alerts
  → red badge count on bell icon; click → dropdown panel

Pagination (Containers):
  listContainers(0, 1000) → full load → client-side filter → slice(page, pageSize)
  → Pagination component at table bottom

Pagination (Audit):
  audit(actor, offset, limit) → backend pagination → {items, total}
  → Pagination component at table bottom
```

## Navigation Guide

- 新增页面 → `src/pages/` 添加组件 + `*.module.css` + `App.tsx` 添加条件渲染分支
- 新增通用组件 → `src/components/` 添加组件 + `*.module.css`；容器组件负责数据/状态，展示组件纯 props
- 新增 API 调用 → `src/api.ts` 添加封装方法；分页接口需支持 offset/limit 参数
- 样式变更 → 全局 tokens 改 `styles.css` `:root`；组件样式改对应 `*.module.css`
- 共享组件 → Pagination 已被 Containers 和 Audit 复用；新增列表页优先复用 Pagination + Toolbar 模式
- 类型定义 → 当前散落在组件/api 文件中；如需共享类型，创建 `src/types/`
- Dev 代理 → API `/api/*` 自动 proxy 到 `localhost:8080`（vite.config.ts）

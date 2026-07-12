# Frontend Retrieval Map

> AI 导航地图：定位前端代码结构和关键模块。可由 `/cf-learn --map` 重生成。

## Purpose

muad 管理控制台前端 SPA。管理员通过浏览器登录后管理 Pod、Human User、IM Identity、业务平台凭证、LLM 配置和审计日志。

## Architecture

- **Framework**: React 18（函数组件 + hooks）
- **Language**: TypeScript 5.5（`strict: true`）
- **Build**: Vite 5 + `@vitejs/plugin-react`
- **Routing**: 无路由库，通过条件渲染切换页面（当前为单页管理后台）
- **Layout**: 左侧固定 Sidebar（200px）导航 + 右侧主内容区；未登录时不渲染 Sidebar
- **State**: 局部 `useState`，无全局状态管理库
- **Styling**: CSS Modules（组件级样式隔离，`*.module.css`）+ 全局设计 tokens（`:root` 变量，`styles.css`）——赛博朋克青紫霓虹主题
- **Lint/Format**: ESLint 10（flat config）+ Prettier 3
- **Test**: vitest 4 + @testing-library/react + jsdom；单测放 `test/` 目录（与 `src/` 平级），按组件名命名 `ComponentName.test.tsx`
- **API 调用**: `src/api.ts` 统一封装 `fetch`、auth header、严格 envelope 解析和 401 处理；Pod、Human User、Identity、Binding Code、Platform 等 DTO 位于 `src/types/api.ts`
- **Pagination**: Pod 和 Human User 使用 page/pageSize 服务端分页；审计日志使用 offset/limit 服务端分页
- **生产部署**: Vite build → `dist/` → Go 后端 `embed.FS` 嵌入服务

## Key Files

| File | Purpose |
|------|---------|
| `src/main.tsx` | 应用入口，`createRoot` 挂载到 `#root` |
| `src/App.tsx` | 根组件：登录态判断、页面路由（条件渲染）、组装 Sidebar + 页面 |
| `src/components/AppShell.tsx` | 已登录控制台壳：Pod 语义导航、用户信息、主题、通知与页面切换 |
| `src/App.module.css` | App flex 布局（Sidebar + main） |
| `src/api.ts` | HTTP 请求封装（base URL、auth header、JSON 解析、401 自动登出）；含分页、qrcode 等方法 |
| `src/types/api.ts` | Console API 的分页、状态、Pod、Human User、Identity、绑定码、平台、脱敏凭证和错误契约 |
| `src/channels.ts` | 消息通道元数据（`CHANNELS` 列表 + `channelMeta`）：标签/图标，前端渲染与过滤的单一登记处 |
| `src/styles.css` | 全局设计 tokens（16 个 `:root` 变量）+ reset + keyframes 动画 |
| `src/vite-env.d.ts` | CSS Modules 类型声明 |
| `src/components/Sidebar.tsx` | 左侧固定侧边栏：Brand + Nav Menu + NotificationBell + UserInfo + 退出 |
| `src/components/NotificationBell.tsx` | 告警铃铛容器：30s 轮询 + 红色数量徽章 + 下拉面板 |
| `src/components/CreateModal.tsx` | 创建容器模态框容器：表单校验 + busy 状态 + Esc 关闭 |
| `src/components/ActionDropdown.tsx` | hover 下拉操作菜单（"更多操作"聚合 5 项容器操作） |
| `src/components/Pagination.tsx` | 共享分页控件（Containers + Audit 复用）：上一页/下一页 + 页码信息 + 每页数量 Select |
| `src/components/human-users/HumanUsersPanel.tsx` | Pod 内 Human User 管理入口：列表刷新、创建、详情与一次性激活码对话框编排 |
| `src/components/human-users/HumanUserDetailDialog.tsx` | Human User 详情容器，组合基本信息、模型覆写、Identity/绑定码和删除操作 |
| `src/components/human-users/IdentityManager.tsx` | scoped IM Identity 列表、新增、启停与删除操作，保留原始 external ID |
| `src/components/human-users/BindingCodeManager.tsx` | 新增 IM 绑定码列表、生成、一次性明文展示、状态与吊销操作 |
| `src/components/human-users/PlatformCredentialManager.tsx` | Human User 多业务平台 API key 新增、覆盖、删除和脱敏状态展示 |
| `src/components/platforms/PlatformSettings.tsx` | 业务平台列表、最小配置、新增、编辑和启停管理 |
| `src/hooks/useMountedRef.ts` | 异步轮询和详情请求的卸载状态保护 |
| `src/components/Select.tsx` | 自定义下拉组件（替代原生 `<select>`，全主题化 option 列表） |
| `src/components/Modal.tsx` | 通用对话框壳（替代原生 confirm/prompt）：固定头/底 + body 单一滚动 + `wide` 变体 + 遮罩/Esc 关闭；创建/升级/删除/重载/日志/扫码弹窗均基于它 |
| `src/pages/Login.tsx` | 登录页面（霓虹发光卡片 + 扫描线背景） |
| `src/pages/Containers.tsx` | Pod 管理入口，编排列表、批量操作、创建与详情切换；子组件位于 `src/pages/containers/` |
| `src/pages/PodDetail.tsx` | Pod 子视图入口；详情请求、运维操作与 Tab 位于 `src/pages/pod-detail/` |
| `src/components/llm/` | 全局 LLM 与 Pod 覆写表单、异步状态和 key fingerprint 展示 |
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
│   ├── types/
│   │   └── api.ts            # 前后端共享语义的严格 API DTO
│   ├── channels.ts           # 消息通道元数据（标签/图标）
│   ├── styles.css            # 全局 tokens + reset + keyframes
│   ├── vite-env.d.ts         # TypeScript 类型声明
│   ├── components/           # 通用组件（容器/展示分离）
│   │   ├── human-users/      # Human User 创建、列表、详情及模型配置
│   │   ├── platforms/        # 业务平台配置
│   │   ├── llm/              # 全局与 Pod 模型配置
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
│   ├── hooks/
│   │   └── useMountedRef.ts  # 异步请求卸载保护
│   └── pages/                # 页面级组件（含各自 .module.css）
│       ├── Login.tsx
│       ├── Login.module.css
│       ├── Containers.tsx
│       ├── Containers.module.css
│       ├── containers/       # Pod 列表、创建、资源和升级组件
│       ├── PodDetail.tsx
│       ├── PodDetail.module.css
│       ├── pod-detail/       # Pod 详情请求、操作、对话框与 Tab
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

Pagination (Pods):
  listPods({page, pageSize, q, state}) → backend pagination → {items, total, page, pageSize}
  → Pagination component at table bottom

Pagination (Audit):
  audit(actor, offset, limit) → backend pagination → {items, total}
  → Pagination component at table bottom
```

## Navigation Guide

- 新增页面 → `src/pages/` 添加组件 + `*.module.css` + `App.tsx` 添加条件渲染分支
- 新增通用组件 → `src/components/` 添加组件 + `*.module.css`；容器组件负责数据/状态，展示组件纯 props
- 新增 API 调用 → `src/types/api.ts` 定义请求/响应 DTO，再在 `src/api.ts` 添加集中封装；页面禁止裸 `fetch`
- 样式变更 → 全局 tokens 改 `styles.css` `:root`；组件样式改对应 `*.module.css`
- 共享组件 → Pagination 已被 Containers 和 Audit 复用；新增列表页优先复用 Pagination + Toolbar 模式
- 类型定义 → API 共享类型统一放在 `src/types/api.ts`，组件局部 props 可留在组件文件
- Dev 代理 → API `/api/*` 自动 proxy 到 `localhost:8080`（vite.config.ts）

# Tasks: 控制台交互优化（侧边栏 + 分页 + 操作聚合 + 排版重构）

- **Source**: console-ux-refinements.frontend.design.md, console-ux-refinements.backend.design.md
- **Created**: 2026-06-28
- **Updated**: 2026-06-28 (all tasks done)

## Proposal

优化控制台交互体验：纯侧边栏导航（替换 topbar）、容器操作按钮 hover 下拉聚合、容器/审计后端分页、LLM 页面三块卡片分区、审计页面对齐容器列表风格。前后端联动：后端 2 个 API 加 offset/limit/total，前端 4 个新组件 + 4 页面重构。

---

## TASK-001: 后端 — repo + API 分页改造

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: console-ux-refinements.backend.design.md#3.2 接口设计

### Description

repo.ListUsers 和 repo.QueryAudit 增加 COUNT + LIMIT/OFFSET；API handler 解析 offset/limit/from/to 参数；更新测试。

### Checklist
- [x] `repo.ListUsers(offset, limit int) ([]User, int, error)` — COUNT subquery + SELECT LIMIT/OFFSET
- [x] `repo.QueryAudit(actor, from, to, offset, limit) ([]AuditEntry, int, error)` — 加 from/to 时间过滤 + COUNT + LIMIT/OFFSET
- [x] `handleListContainers` 解析 offset/limit query 参数（默认 0/20），响应包裹 `{items, total}`
- [x] `handleAuditQuery` 解析 offset/limit/from/to，响应包裹 `{items, total}`
- [x] limit 上限校验（≤100），非法值用默认值；offset 负数按 0
- [x] 更新 `test/api_test.go` — fakeDriver 适配新签名 + 分页场景测试
- [x] 更新 `test/repo_test.go` — 分页 offset/limit/total 测试
- [x] `cd console/backend && go test ./...` 全部通过

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-002: 前端 — api.ts 分页签名更新

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: console-ux-refinements.frontend.design.md#3.5 状态与数据流

### Description

api.listContainers 和 api.audit 方法签名增加 offset/limit 参数，响应类型增加 total 字段。

### Checklist
- [x] `api.listContainers(offset?: number, limit?: number)` — 默认 offset=0, limit=1000（全量加载前端切片）
- [x] `api.audit(actor: string, offset?: number, limit?: number, from?: string, to?: string)` — 传 query params
- [x] TypeScript 响应类型：`{ items: Container[]; total: number }` 和 `{ items: AuditEntry[]; total: number }`
- [x] Token/401 处理逻辑不变

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-003: 前端 — Sidebar 组件

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.4 组件接口契约

### Description

新建 Sidebar 容器组件（固定 200px 左侧），包含 Brand/Menu/UserSection + NotificationBell。替换 Topbar。

### Checklist
- [x] `src/components/Menu.tsx` — 3 项导航，当前页紫色左边框（`border-left: 3px solid var(--color-neon-purple)`）+ 背景高亮
- [x] `src/components/Menu.module.css` — hover 青色 glow 过渡
- [x] `src/components/UserSection.tsx` — 👤 + 用户名 + 铃铛 + 退出按钮，底部对齐
- [x] `src/components/UserSection.module.css` — flex column、用户行样式
- [x] `src/components/Sidebar.tsx` — 容器：useEffect 调 api.me()，组合 Brand/Menu/NotificationBell/UserSection
- [x] `src/components/Sidebar.module.css` — 固定 200px、`background: var(--bg-panel)`、`border-right`、`display: flex; flex-direction: column`
- [x] NotificationBell 组件不变，仅渲染位置从 Topbar 移到 Sidebar

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-004: 前端 — Pagination 共享组件

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.4 组件接口契约

### Description

新建 Pagination 展示组件，Containers 和 Audit 共享。显示上一页/下一页 + 页码信息。

### Checklist
- [x] `src/components/Pagination.tsx` — Props: `page: number; pageSize: number; total: number; onPageChange: (p: number) => void`
- [x] `src/components/Pagination.module.css` — 右对齐、flex、按钮间距、数字 monospace
- [x] 按钮文案：`<上一页` / `下一页>`；中间：`第 {page}/{totalPages} 页 共 {total} 条`
- [x] 首页时"上一页" disabled；末页时"下一页" disabled
- [x] `total === 0` 时返回 `null`（隐藏分页控件）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-005: 前端 — ActionDropdown 组件

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.4 组件接口契约

### Description

新建"更多操作"hover 下拉菜单组件。hover 展开 5 项操作，移出 150ms 后关闭。

### Checklist
- [x] `src/components/ActionDropdown.tsx` — Props: `items: {key, label}[]; onSelect: (key) => void`
- [x] `src/components/ActionDropdown.module.css` — 相对定位容器 + 绝对定位下拉面板、`z-index: 10`
- [x] hover 逻辑：onMouseEnter → `setOpen(true)`；onMouseLeave → `setTimeout(150ms)` → `setOpen(false)`
- [x] 菜单项 hover：青色 glow 过渡
- [x] 下拉超出视口底部时 `bottom: 100%; top: auto` 向上弹出

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-006: 前端 — App.tsx 侧边栏布局

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-003
- **Source**: console-ux-refinements.frontend.design.md#3.2 页面与路由结构, #3.5 状态与数据流

### Description

App.tsx 布局从 Topbar + content 改为 Sidebar + main。移除 Topbar import。未登录时不渲染 Sidebar。

### Checklist
- [x] App.tsx 移除 `import { Topbar }` 和 `<Topbar .../>` 渲染
- [x] App.tsx 渲染：`authed ? <div className={styles.layout}><Sidebar .../><main>...页面</main></div> : <Login />`
- [x] `src/App.module.css` — `.layout { display: flex }`；`.main { flex: 1; padding: 24px }`
- [x] 删除 `src/components/Topbar.tsx`
- [x] 删除 `src/components/Topbar.module.css`
- [x] 全局搜索确认无 Topbar 残留引用

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-007: 前端 — Containers 页面接入 ActionDropdown + Pagination

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004, TASK-005
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.5 状态与数据流

### Description

Containers.tsx 操作按钮替换为 ActionDropdown + 保留日志/升级/删除；表格底部接入 Pagination。

### Checklist
- [x] 操作区：`<ActionDropdown items={ACTIONS} onSelect={...} />` + 日志 + 升级 + 删除按钮
- [x] 分页 state：`const [page, setPage] = useState(1); const pageSize = 20`
- [x] `filtered` useMemo 保持客户端过滤（search + statusFilter）
- [x] 渲染：`filtered.slice((page-1)*pageSize, page*pageSize).map(...)`
- [x] `<Pagination>` 在表格底部右侧
- [x] 删除当前页最后一项 → `if (filtered.length <= 1 && page > 1) setPage(page-1)`
- [x] search 或 statusFilter 变化时 `setPage(1)`
- [x] 状态下拉 `<select>` 样式更新（匹配主题 — FEAT-04）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-008: 前端 — LLM 页面三块卡片

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.6 UI 状态

### Description

LLM.tsx 重构为三块卡片分区：①全局配置 + 保存 ②连通性测试 + 终端 ③批量应用 + 单用户覆盖。

### Checklist
- [x] `src/pages/LLM.module.css` — `.card` 样式：`background: var(--bg-panel); border: 1px solid rgba(0,229,255,0.1); border-radius: 6px; padding: 20px; margin-bottom: 16px`
- [x] `.cardTitle` 样式：`font-family: var(--font-mono); color: var(--color-neon-cyan); font-size: 14px; margin-bottom: 12px`
- [x] 卡片① LLMConfigCard：标题"全局配置" + form-grid + 保存按钮
- [x] 卡片② LLMTestCard：标题"连通性测试" + 测试按钮 + 终端输出区（有输出/loading/error 时才显示）
- [x] 卡片③ LLMApplyCard：标题"批量应用与覆盖" + 容器勾选 + 应用 + 单用户覆盖表单

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-009: 前端 — Audit 页面 Pagination + 工具栏对齐

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-002, TASK-004
- **Source**: console-ux-refinements.frontend.design.md#3.3 组件设计, #3.5 状态与数据流

### Description

Audit.tsx 工具栏与容器列表对齐（左筛选/右空）；表格底部接入 Pagination。

### Checklist
- [x] `src/pages/Audit.module.css` — `.toolbar { display: flex; justify-content: space-between; margin-bottom: 16px }`
- [x] 工具栏：左侧 actor input + 查询按钮；右侧留空
- [x] 分页 state：`const [page, setPage] = useState(1); const pageSize = 20; const [total, setTotal] = useState(0)`
- [x] `load()` 调用 `api.audit(actor, (page-1)*pageSize, pageSize)`，从响应设置 `total`
- [x] `<Pagination>` 在表格底部右侧
- [x] actor 筛选变化时 `setPage(1)`

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-010: 前端 — 全局走查 + 旧代码清理

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-007, TASK-008, TASK-009
- **Source**: console-ux-refinements.frontend.design.md#3.7 样式方案

### Description

最终集成验证：全量检查通过；确认 Topbar 已删除；4 页面走查。

### Checklist
- [x] `npm run check` 全部通过（tsc + eslint + prettier）
- [x] `npm run build` 成功
- [x] 全局搜索 `Topbar` 确认无残留引用
- [x] Login 页面：无侧边栏，居中卡片正常
- [x] Containers 页面：侧边栏 + Toolbar + 分页 + 下拉菜单正常
- [x] LLM 页面：侧边栏 + 三块卡片分区正常
- [x] Audit 页面：侧边栏 + 工具栏 + 分页正常
- [x] 验收：全部 8 个 S- 场景 + 4 个 E- 场景通过

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

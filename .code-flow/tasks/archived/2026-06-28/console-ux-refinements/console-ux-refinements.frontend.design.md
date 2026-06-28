# 控制台交互优化 前端模块需求与设计简报

> **文档编号**: FE-CONSOLE-UX-v1
> **文档版本**: v1.0
> **创建日期**: 2026-06-28
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: US（来自 PRD）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
场景编号：S-（正常）、E-（异常）、B-（边界，按需）

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 需求分析](#2-需求分析)
  - [2.1 需求概述](#21-需求概述-必填)
  - [2.2 功能方案](#22-功能方案-必填)
  - [2.3 范围与边界](#23-范围与边界-必填)
  - [2.4 验收条件](#24-验收条件-必填)
- [3. 前端技术设计](#3-前端技术设计)
  - [3.1 技术选型](#31-技术选型-必填)
  - [3.2 页面与路由结构](#32-页面与路由结构-必填)
  - [3.3 组件设计](#33-组件设计-必填)
  - [3.4 组件接口契约](#34-组件接口契约-必填)
  - [3.5 状态与数据流](#35-状态与数据流-必填)
  - [3.6 UI 状态](#36-ui-状态-必填)
  - [3.7 样式方案](#37-样式方案-必填)
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
| **模块名称** | 控制台前端交互优化（console/frontend） |
| **需求类型** | 重构 + 新组件（侧边栏、下拉菜单、分页） |
| **业务背景** | 赛博朋克第一版上线后，交互细节需要打磨：导航改为侧边栏、操作聚合、分页、LLM 排版重构 |
| **核心目标** | 侧边栏导航 + 操作下拉聚合 + 分页 + LLM 分区 + 审计对齐 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-01 | 纯侧边栏导航 | 去掉 Topbar，改为左侧固定 Sidebar（品牌/菜单/用户/铃铛） | P0 | US-01 |
| FEAT-02 | 操作按钮下拉聚合 | 5 个操作按钮聚合成"更多操作" hover 下拉菜单 | P0 | US-02 |
| FEAT-03 | 容器列表分页 | 前端分页控件 + API 传 offset/limit；后端分页（见 backend design） | P0 | US-03 |
| FEAT-04 | 状态筛选样式统一 | `<select>` 样式匹配赛博朋克主题 | P1 | US-04 |
| FEAT-05 | LLM 页面三块分区 | 全局配置/连通性测试/批量应用 三块卡片分区 | P0 | US-05 |
| FEAT-06 | 审计日志分页 + 列表对齐 | 工具栏+表格+分页与容器列表一致 | P1 | US-06 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | ① Sidebar 组件（替换 Topbar）② ActionDropdown 组件 ③ Pagination 共享组件 ④ Containers/LLM/Audit 页面重构 ⑤ api.ts 分页方法更新 ⑥ App.tsx 布局改为 sidebar + main |
| **非范围（Out of Scope）** | ① 不引入路由库 ② 不做侧边栏折叠 ③ 不做移动端 ④ 不做排序 ⑤ 不做虚拟滚动 |
| **有意妥协 / 技术债** | ① Sidebar 菜单项为静态列表，不做动态注册机制 ② 分页控件不做"跳转到第 N 页"输入框，保持简洁 |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|
| S-01 | FEAT-01 | P0 | 登录后查看页面 | 左侧固定 Sidebar：品牌名/菜单/用户/铃铛；主内容区右侧；无 topbar |
| S-02 | FEAT-01 | P0 | 点击 Sidebar 菜单项 | 主内容区切换到对应页面，菜单项高亮（紫色左边框） |
| S-03 | FEAT-02 | P0 | hover "更多操作"按钮 | 下拉菜单弹出 5 项操作；移出后关闭 |
| S-04 | FEAT-03 | P0 | 容器列表加载完毕 | 表格底部右侧显示"第 1/N 页 共 M 条" + 上一页/下一页 |
| S-05 | FEAT-03 | P0 | 点击"下一页" | 请求 `?offset=20&limit=20`，列表刷新，页码更新 |
| S-06 | FEAT-05 | P0 | 查看 LLM 页面 | 三块卡片：①全局配置 ②连通性测试 ③批量应用+覆盖 |
| S-07 | FEAT-06 | P1 | 查看审计日志 | 工具栏：actor 筛选左 + 查询按钮；表格 + 底部分页控件 |
| S-08 | FEAT-04 | P1 | 查看状态下拉 | select 样式与赛博朋克主题一致（暗底、霓虹边框、focus 发光） |

**异常场景**

| 场景ID | 功能ID | 触发条件 | UI 表现 |
|--------|--------|---------|---------|
| E-01 | FEAT-03 | 分页请求失败 | 表格保持当前页数据，"上一页/下一页" disabled + 错误提示 |
| E-02 | FEAT-03 | 删除当前页最后一项导致当前页无数据 | 自动回退到 page-1 |
| E-03 | FEAT-05 | LLM 测试连接失败 | 终端卡片显示红字错误 |
| E-04 | FEAT-02 | "更多操作"下拉超出视口底部 | 自动向上弹出 |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 分页切换响应 | < 500ms（含 API 请求） | Chrome DevTools |
| NFR-COMPAT-01 | 最小宽度 | 侧边栏 200px + 内容区 ≥1080px | 手动验证 |

---

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 说明 |
|------|------|------|
| 框架 | React 18 | 现有 |
| 状态管理 | useState（局部） | 现有；分页 state 在页面组件内 |
| 路由 | 无路由库 | 现有条件渲染 |
| 样式方案 | CSS Modules | 现有；Sidebar/ActionDropdown/Pagination 各配 `.module.css` |
| 数据请求 | fetch（`api.ts`） | 现有；`listContainers(offset, limit)` 和 `audit(actor, offset, limit, from?, to?)` 更新签名 |
| 动画 | CSS transition | 现有；侧边栏菜单 hover、下拉菜单进出 |

### 3.2 页面与路由结构

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| Login | `!authed` 条件 | 居中卡片 | 无侧边栏（未登录） |
| Containers | `page==="containers"` | Sidebar + Toolbar + Table + Pagination | FEAT-01/02/03/04 |
| LLM | `page==="llm"` | Sidebar + 三块卡片 | FEAT-05 |
| Audit | `page==="audit"` | Sidebar + Filter + Table + Pagination | FEAT-06 |

> App.tsx 根布局：`authed` 时渲染 `<Sidebar />` + `<main>{page}</main>`；未登录时渲染 `<Login />`（无侧边栏）。

### 3.3 组件设计

**组件树**（★ 新增，↻ 修改）

```
App (容器) ↻
├─ Login (页面)            # 不变，仅无侧边栏时显示
├─ Sidebar (容器) ★        # 替换 Topbar：品牌 + 菜单 + 用户 + 铃铛
│  ├─ Brand (展示)         # 复用自 Topbar 内联
│  ├─ Menu (展示) ★        # 3 项导航，当前页高亮
│  ├─ NotificationBell     # 复用现有
│  └─ UserSection (展示) ★ # 用户信息 + 退出
├─ Containers (页面) ↻
│  ├─ Toolbar ↻            # 左侧操作 / 右侧搜索+筛选
│  ├─ ContainerGrid ↻      # 表格 + ActionDropdown
│  │  └─ ActionDropdown ★  # hover 下拉菜单
│  └─ Pagination ★         # 共享分页控件
├─ LLM (页面) ↻
│  ├─ LLMConfigCard ★      # 卡片①：全局配置
│  ├─ LLMTestCard ★        # 卡片②：连通性测试 + 终端
│  └─ LLMApplyCard ★       # 卡片③：批量应用 + 单用户覆盖
└─ Audit (页面) ↻
   ├─ Toolbar ↻            # 左侧筛选 / 右侧（空）
   ├─ AuditTable            # 复用现有
   └─ Pagination ★          # 共享分页控件
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | Sidebar | 容器 | 新建（替换 Topbar） | 获取用户信息 + 告警；渲染品牌/菜单/用户区 |
| CMP-02 | Menu | 展示 | 新建 | 3 项导航按钮，当前页紫色左边框高亮 |
| CMP-03 | UserSection | 展示 | 新建 | 用户信息（👤 + 用户名）+ 退出按钮 + 铃铛 |
| CMP-04 | ActionDropdown | 展示 | 新建 | "更多操作"按钮 + hover 下拉 5 项操作 |
| CMP-05 | Pagination | 展示 | 新建（Containers + Audit 共享） | 上一页/下一页 + 页码信息 |
| CMP-06 | LLMConfigCard | 展示 | 新建 | 卡片①：form-grid + 保存按钮 |
| CMP-07 | LLMTestCard | 展示 | 新建 | 卡片②：测试按钮 + 终端输出 |
| CMP-08 | LLMApplyCard | 展示 | 新建 | 卡片③：容器勾选 + 应用 + 单用户覆盖 |

> Topbar 组件（Brand/Nav/UserMenu）移除；NotificationBell 移入 Sidebar。

### 3.4 组件接口契约

**CMP-01 `<Sidebar>`**

| Props | 类型 | 必填 | 说明 |
|-------|------|------|------|
| `page` | `Page` | 是 | 当前页 |
| `onNavigate` | `(p: Page) => void` | 是 | 导航回调 |
| `onLogout` | `() => void` | 是 | 退出回调 |

**CMP-04 `<ActionDropdown>`**

| Props | 类型 | 必填 | 说明 |
|-------|------|------|------|
| `items` | `{ key: string; label: string }[]` | 是 | 菜单项 |
| `onSelect` | `(key: string) => void` | 是 | 选中回调 |

**CMP-05 `<Pagination>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `page` | `number` | 是 | — | 当前页码（1-based） |
| `pageSize` | `number` | 是 | — | 每页条数 |
| `total` | `number` | 是 | — | 总条数 |
| `onPageChange` | `(page: number) => void` | 是 | — | 页码变化回调 |

### 3.5 状态与数据流

**状态变更**

| 状态 | 作用域 | 变更 |
|------|--------|------|
| `authed` / `page` | App local | **不变** |
| `user` / `userErr` | Sidebar local | 从 Topbar 迁入 |
| `alerts` / `bellOpen` | NotificationBell local | **不变**（仍在 Sidebar 内） |
| `containers` | Containers local | **不变** |
| `page` / `pageSize` / `total` | Containers local | **新增** — 分页状态 |
| `search` / `statusFilter` | Containers local | **变更** — 搜索改为触发 API 请求（非客户端过滤） |
| `page` / `pageSize` / `total` | Audit local | **新增** — 分页状态 |
| `modalOpen` / `logView` | Containers local | **不变** |

**搜索行为变更**：原 Containers 搜索为客户端过滤（`useMemo` 过滤 all items）。改后端分页后，搜索改为调用 API `listContainers(0, limit)` 时传搜索参数。但 PRD 未要求后端搜索，且当前 API 不支持搜索参数 → **搜索保持客户端行为**，分页独立。

> 实际策略：前端先拉全量数据做客户端过滤和搜索，再对过滤结果做前端切片分页。后端分页 API 就绪后，仍先全量加载一次（容器数 < 100 合理），分页在前端 slice。审计日志量大，走后端分页。

**数据流**

```
App mount → authed → Sidebar mount
  → useEffect: api.me() → setUser
  → NotificationBell: setInterval 30s api.alerts()

Containers mount:
  → useEffect: api.listContainers(0, 1000) → setItems → 前端 slice 分页
  → setInterval 5s: 同上
  → 分页切换: setPage(n) → items.slice((n-1)*20, n*20)

Audit mount:
  → useEffect: api.audit(actor, offset, limit, from, to) → setRows + setTotal
  → 分页/筛选切换: 重新请求 API
```

### 3.6 UI 状态

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| Sidebar 用户信息 | "加载中…" | — | "未知用户" | 显示用户名 |
| 容器列表分页 | 分页按钮 disabled | 0 条 → 隐藏分页 | 分页按钮 disabled + error | 正常分页 |
| 容器删除后回退 | 加载中 | 自动回退 page-1 | — | 正常显示 |
| 操作下拉菜单 | — | — | — | hover 展开/移出关闭 |
| LLM 测试终端 | 闪烁光标 "Testing…" | — | 红字错误 | 青字结果 |

### 3.7 样式方案

**文件变更**

| 文件 | 操作 |
|------|------|
| `src/components/Sidebar.module.css` | ★ 新建 — 固定 200px 宽、暗底、品牌 glow、菜单高亮 |
| `src/components/ActionDropdown.module.css` | ★ 新建 — 绝对定位下拉、z-index、hover 过渡 |
| `src/components/Pagination.module.css` | ★ 新建 — 右对齐、页码按钮 |
| `src/components/Sidebar.tsx` | ★ 新建 |
| `src/components/ActionDropdown.tsx` | ★ 新建 |
| `src/components/Pagination.tsx` | ★ 新建 |
| `src/App.tsx` | ↻ 改为 Sidebar + main 布局 |
| `src/App.module.css` | ↻ 侧边栏布局 |
| `src/pages/Containers.tsx` | ↻ 接入 ActionDropdown + Pagination |
| `src/pages/Containers.module.css` | ↻ 工具栏/分页区样式 |
| `src/pages/LLM.tsx` | ↻ 三块卡片 |
| `src/pages/LLM.module.css` | ↻ 卡片样式 |
| `src/pages/Audit.tsx` | ↻ 接入 Pagination |
| `src/pages/Audit.module.css` | ↻ 分页区样式 |
| `src/api.ts` | ↻ listContainers/audit 签名更新 |
| `src/components/Topbar.tsx` + `.module.css` | ✕ 删除 |

**Sidebar 布局 tokens**

| Token | 值 | 用途 |
|-------|-----|------|
| `--sidebar-width` | `200px` | 侧边栏固定宽度 |
| `--sidebar-bg` | `var(--bg-panel)` | 侧边栏背景 |
| `--sidebar-border` | `1px solid rgba(0,229,255,0.1)` | 右侧分隔线 |
| `--menu-active-border` | `3px solid var(--color-neon-purple)` | 当前页左边框 |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 |
|--------|------|------|---------|
| RISK-01 | 后端分页 API 改造与前端并行开发，接口契约需对齐 | 联调失败 | 先在前端 mock 分页数据（全量加载→前端切片），后端就绪后切换 |
| RISK-02 | 删除 Topbar 组件需确保所有引用已清理 | 编译错误 | 全局搜索 Topbar import，批量替换 |
| RISK-03 | ActionDropdown hover 模式在快速移动鼠标时可能闪烁 | 体验不佳 | 加 150ms `setTimeout` 延迟关闭 |

---

*文档结束*

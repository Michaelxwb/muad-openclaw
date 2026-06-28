# Tasks: 前端赛博朋克风重构

- **Source**: frontend-cyberpunk-redesign.frontend.design.md
- **Created**: 2026-06-28
- **Updated**: 2026-06-28 (all tasks done)

## Proposal

将 muad 管理控制台前端重构为青紫霓虹赛博朋克风格，同时优化关键交互：容器创建改为模态框、用户信息+退出整合到 topbar、告警迁移至铃铛通知、列表工具栏左右分区。纯前端改动，不新增后端 API，CSS Modules 方案 + 12 个组件拆分。

---

## TASK-001: 赛博朋克设计 tokens + 全局样式

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.7 样式方案

### Description

建立 CSS 变量体系（16 tokens）、全局 reset、背景网格纹、霓虹发光/扫描线 keyframes 动画。所有后续组件的基础。

### Checklist
- [x] `styles.css` 重写：`:root` 定义全部 16 个设计 tokens
- [x] 全局 reset：`box-sizing`、`body` 背景色 `--bg-primary`、字体 `--font-ui`
- [x] 背景网格纹 `background-image`（CSS 渐变模拟）
- [x] `@keyframes scanline` 扫描线动画
- [x] `@keyframes glow-pulse` 霓虹脉冲动画
- [x] `button`/`input`/`table` 等基础元素重置样式
- [x] 构建验证：`npm run build` 通过

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-002: Topbar 组件组（Brand + Nav + UserMenu + me() API）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.5 状态与数据流

### Description

新建 Topbar 容器组件 + Brand/Nav/UserMenu 展示组件；`api.ts` 新增 `me()` 方法；替换 App.tsx 中原有 topbar 内联代码。

### Checklist
- [x] `src/api.ts` 新增 `api.me()` 方法（`GET /api/v1/me`）
- [x] `src/components/Topbar.tsx` — 容器组件，useEffect 调 `api.me()`，组合子组件
- [x] `src/components/Topbar.module.css` — 霓虹底边发光、flex 布局
- [x] Brand 子组件：显示"muad 控制台"，monospace 字体 + 青色霓虹 text-shadow
- [x] Nav 子组件：3 个导航按钮，当前页高亮（`--color-neon-purple` border-bottom）
- [x] UserMenu 子组件：用户名 + "退出"按钮，hover 发光
- [x] E-01 处理：`api.me()` 失败时降级显示"未知用户"
- [x] 验收：S-03（topbar 显示用户名+退出）、E-01（/me 失败降级）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-003: NotificationBell + AlertDropdown 告警铃铛

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.5 状态与数据流

### Description

新建告警铃铛容器组件 + 下拉面板展示组件。每 30s 轮询 `/api/v1/alerts`，有告警时显示红色数字徽章，点击弹出下拉面板。

### Checklist
- [x] `src/components/NotificationBell.tsx` — 容器，useEffect + setInterval(30s) 轮询
- [x] `src/components/NotificationBell.module.css` — 铃铛图标、徽章定位、下拉面板样式
- [x] AlertDropdown 子组件：告警列表（级别色标 P1 红/P2 黄/P3 灰）
- [x] 面板开闭：点击铃铛 toggle、点击外部关闭（useRef + useEffect）
- [x] 空态："暂无告警"
- [x] E-02 处理：轮询失败静默保持上次数据
- [x] 验收：S-04（铃铛徽章+下拉面板）、E-02（轮询失败降级）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-004: Login 页面赛博朋克化（LoginCard）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.6 UI 状态

### Description

重构 Login 页面，提取 LoginCard 展示组件，应用霓虹发光边框 + 扫描线背景动画 + 终端风标题。

### Checklist
- [x] `src/pages/Login.module.css` — 居中 flex 布局、卡片霓虹边框（`box-shadow: var(--border-glow)`）
- [x] 背景扫描线动画（`animation: scanline 8s linear infinite`）
- [x] 标题"muad 控制台"使用 `--font-mono` + 青色霓虹
- [x] 输入框 focus 时 `border-color: var(--color-neon-cyan)` + glow
- [x] 按钮 hover 发光过渡
- [x] 错误状态红色霓虹
- [x] 验收：S-08（登录卡片霓虹+扫描线+终端标题）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-005: Containers 工具栏 + 表格重构（Toolbar + ContainerGrid + ContainerRow）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.5 状态与数据流, #3.6 UI 状态

### Description

新建 Toolbar（左操作/右筛选）、ContainerGrid（表格）、ContainerRow（单行）展示组件。客户端过滤，告警不再占用列表顶部区域。

### Checklist
- [x] `src/pages/Containers.module.css` — 页面样式
- [x] Toolbar：`justify-content: space-between`；左侧"创建容器""重载 Skill"按钮，右侧搜索 input + 状态下拉 select
- [x] ContainerGrid：`<table>` 行 hover 发光（`box-shadow` transition）
- [x] ContainerRow：状态徽章（running/stopped/error 色标）、CPU/内存/企微状态、操作按钮组
- [x] 客户端过滤：`useMemo` 根据 search（userId includes）+ statusFilter 过滤 items
- [x] 空态：过滤无结果时"无匹配容器"+ 清除过滤按钮；无容器时"暂无容器，点击创建容器开始"
- [x] 移除页面顶部 alerts 渲染（已迁移到 NotificationBell）
- [x] 验收：S-05（工具栏左右分区）、S-06（搜索过滤）、S-07（状态筛选）、E-05（无匹配空态）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-006: CreateModal 创建容器模态框

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.6 UI 状态

### Description

新建模态框容器组件，表单 userId/botId/secret + 校验 + busy 状态。Esc/遮罩关闭。

### Checklist
- [x] `src/components/CreateModal.tsx` — 容器，管理 form/busy/err 状态
- [x] `src/components/CreateModal.module.css` — 遮罩层、模态框面板（霓虹边框发光）
- [x] 表单字段：userId（校验 `^[A-Za-z0-9][A-Za-z0-9._-]*$`）、botId（必填）、secret（必填）
- [x] 字段校验失败：红色提示文字在对应字段下方
- [x] 提交：POST /api/v1/containers；busy 时按钮 disabled + "创建中…"
- [x] 成功：调用 `onCreated()` 关闭模态框
- [x] 失败：错误信息显示在表单内
- [x] Esc 键关闭、点击遮罩关闭
- [x] 验收：S-02（创建成功关闭+刷新）、E-03（提交失败留框）、E-04（校验失败提示）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-007: LLM 配置页面赛博朋克化（LLMTerminal）

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.4 组件接口契约, #3.6 UI 状态

### Description

重构 LLM 页面，表单统一霓虹风格；新增 LLMTerminal 展示组件显示测试结果（黑底青字 monospace 终端风）。

### Checklist
- [x] `src/pages/LLM.module.css` — 页面样式，表单元素霓虹风格
- [x] LLMTerminal：`<pre>` 黑底青字（`--bg-primary` + `--color-neon-cyan`）
- [x] loading 状态：显示"Testing…" + CSS 闪烁光标动画
- [x] error 状态：终端红字错误信息
- [x] success 状态：终端青字 JSON 结果
- [x] 验收：S-09（终端风测试结果）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-008: Audit 审计日志页面赛博朋克化

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.6 UI 状态

### Description

重构 Audit 页面，表格行 hover 发光过渡，时间戳 monospace 字体，筛选框霓虹风格。

### Checklist
- [x] `src/pages/Audit.module.css` — 页面样式
- [x] 表格行 `tr:hover` 发光效果（`box-shadow` + `transition`）
- [x] 时间戳列使用 `--font-mono`
- [x] 筛选输入框 focus 霓虹边框
- [x] loading 骨架屏（CSS shimmer animation）
- [x] 空态："暂无审计记录"
- [x] 验收：S-10（行 hover 发光 + monospace 时间戳）

### Log
- [2026-06-28] created (draft)
- [2026-06-28] completed (done)

---

## TASK-009: App.tsx 集成 + 旧代码清理 + 最终走查

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008
- **Source**: frontend-cyberpunk-redesign.frontend.design.md#3.3 组件设计, #3.5 状态与数据流

### Description

App.tsx 接入所有新组件；Containers 页面完成组件拼装；移除旧内联代码；全页面走查样式一致性和交互验收。

### Checklist
- [x] App.tsx：用 `<Topbar>` 替换原 `<header className="topbar">` 内联代码
- [x] App.tsx：传入 `page`/`onNavigate`/`onLogout` props
- [x] Containers.tsx：接入 Toolbar（替代原 create 表单 + row-between）
- [x] Containers.tsx：接入 CreateModal（替代原内联 create 表单）
- [x] Containers.tsx：接入 ContainerGrid + ContainerRow（替代原内联 table）
- [x] Containers.tsx：移除原 alerts 渲染代码
- [x] `src/App.module.css` — 布局样式
- [x] 全页面走查：Login/Containers/LLM/Audit 4 页面 style 一致
- [x] `npm run check` 全部通过（tsc + eslint + prettier + vitest）
- [x] 验收：全部 10 个 S- 场景 + 5 个 E- 场景通过

### Log
- [2026-06-28] created (draft)

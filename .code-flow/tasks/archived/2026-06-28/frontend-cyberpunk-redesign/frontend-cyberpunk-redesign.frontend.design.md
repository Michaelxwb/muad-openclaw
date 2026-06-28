# muad 控制台 前端赛博朋克风重构 设计简报

> **文档编号**: FE-CONSOLE-REDESIGN-v1
> **文档版本**: v1.0
> **创建日期**: 2026-06-28
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: US（来自 PRD）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
场景编号：S-（正常）、E-（异常）、B-（边界，按需）

**填写约定**: 框架为 React 18 + TypeScript。表内数值/阈值均已替换为实际目标。

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
  - [3.8 可访问性与兼容性](#38-可访问性与兼容性-按需)
- [4. 风险与依赖](#4-风险与依赖)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 | — | 技术方案、代码实现 |
| 设计/交互 | — | 视觉与交互稿（纯 CSS 实现） |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-06-28 | Claude | 初始草稿，PRD 派生 |

---

## 2. 需求分析

> 以下内容继承自 PRD: `frontend-cyberpunk-redesign.prd.md`

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | muad 控制台前端（console/frontend） |
| **需求类型** | 重构（视觉主题 + 交互优化） |
| **业务背景** | 控制台功能已稳定，需在视觉和交互上匹配产品技术感定位；当前界面功能优先但视觉单调、操作入口散落 |
| **核心目标** | 将控制台重构为青紫霓虹赛博朋克风格，同时优化创建容器、告警查看、工具栏布局等关键交互 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-01 | 全局赛博朋克视觉主题 | 重写 CSS 设计系统：青紫霓虹色板、发光边框、暗底网格背景、终端风字体、过渡动效 | P0 | US-01 |
| FEAT-02 | 容器创建模态框 | 工具栏"创建容器"按钮 → 弹出模态框填写 userId/botId/secret → 提交后关闭并刷新列表 | P0 | US-02 |
| FEAT-03 | 用户信息+退出整合 | topbar 右侧显示当前用户名（调 `/api/v1/me`）+ 退出按钮，分组展示 | P0 | US-03 |
| FEAT-04 | 通知铃铛告警 | topbar 右侧告警铃铛图标 + 未读数量徽章，点击弹出下拉面板展示告警列表 | P1 | US-04 |
| FEAT-05 | 列表工具栏重构 | 容器列表上方工具栏：左侧放操作按钮，右侧放搜索/状态筛选 | P0 | US-05 |
| FEAT-06 | Login 页面赛博朋克化 | 登录卡片：霓虹发光边框、扫描线动画背景、终端风标题 | P0 | US-01 |
| FEAT-07 | LLM 配置页面赛博朋克化 | 表单元素统一霓虹风格，测试结果展示终端风输出 | P1 | US-01 |
| FEAT-08 | 审计日志页面赛博朋克化 | 表格行 hover 发光效果、时间戳终端格式 | P1 | US-01 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | ① 全局 CSS 设计系统重写（CSS Modules + 设计 tokens）② 容器创建模态框 ③ topbar 用户信息展示 ④ 告警通知铃铛 ⑤ 列表工具栏左右分区 ⑥ Login/LLM/Audit 页面风格统一 ⑦ 组件细粒度拆分（CMP-01 ~ CMP-12） |
| **非范围（Out of Scope）** | ① 不新增后端 API ② 不做移动端/平板适配 ③ 不引入第三方 UI 组件库 ④ 不改动后端业务逻辑 ⑤ 不做国际化 ⑥ 不做暗/亮主题切换 ⑦ 不引入动画库（Framer Motion） |
| **有意妥协 / 技术债** | ① 不迁移现有 CSS 类名到 CSS Modules（只新组件用 Modules，现有全局类名如 `.grid`/`.badge` 保留但重写值）② 不拆分 `api.ts`（当前 ~100 行可维护）③ 无 e2e 测试覆盖，依赖手动验收 |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|
| S-01 | FEAT-01 | P0 | 打开任意页面 | 暗底+青紫霓虹色板、组件 hover 有发光过渡、背景有网格纹 |
| S-02 | FEAT-02 | P0 | 点击"创建容器"→ 填写表单 → 提交 | 模态框弹出（霓虹边框）；提交成功后模态框关闭、列表刷新、显示"创建成功" |
| S-03 | FEAT-03 | P0 | 登录后查看 topbar 右侧 | 显示用户名（如"admin"）+ 退出按钮，视觉上为一组 |
| S-04 | FEAT-04 | P1 | 有告警时查看 topbar | 铃铛图标显示红色数字徽章；点击弹出告警面板；点击外部关闭 |
| S-05 | FEAT-05 | P0 | 打开容器列表页 | 工具栏左侧"创建容器""重载 Skill"按钮；右侧搜索框+状态下拉 |
| S-06 | FEAT-05 | P0 | 在搜索框输入 userId | 表格实时过滤，只显示匹配行 |
| S-07 | FEAT-05 | P0 | 选择状态筛选"运行中" | 表格只显示 state=running 的行 |
| S-08 | FEAT-06 | P0 | 未登录时查看登录页 | 登录卡片霓虹发光边框、背景扫描线动画、"muad 控制台"标题终端风 |
| S-09 | FEAT-07 | P1 | LLM 配置页点击"测试连接" | 测试结果以终端风（黑底青字 monospace）展示 |
| S-10 | FEAT-08 | P1 | 审计日志页 hover 表格行 | 行背景发光过渡，时间戳 monospace 字体 |

**异常场景**

| 场景ID | 功能ID | 触发条件 | UI 表现 |
|--------|--------|---------|---------|
| E-01 | FEAT-03 | `/api/v1/me` 请求失败 | topbar 显示"未知用户"，页面功能不受影响 |
| E-02 | FEAT-04 | `/api/v1/alerts` 轮询失败 | 保持上次告警数据，铃铛不消失，静默重试 |
| E-03 | FEAT-02 | 创建容器表单提交失败 | 模态框保持打开，错误信息显示在表单内 |
| E-04 | FEAT-02 | 创建容器表单校验失败（空字段） | 对应字段下方红色提示，不提交 |
| E-05 | FEAT-05 | 搜索/筛选无匹配结果 | 表格显示"无匹配容器"，过滤条件保留可修改 |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 首屏渲染 | < 2s（含 `/api/v1/me`） | Chrome DevTools Performance |
| NFR-PERF-02 | CSS 文件总大小 | < 50KB（gzip 后） | 构建产物分析 |
| NFR-COMPAT-01 | 浏览器兼容 | Chrome/Edge/Firefox 最近 2 主版本 | 手动验证 |
| NFR-SEC-01 | 安全 | token 存储/传输不变，不引入新安全边界 | 代码审查 |
| NFR-REL-01 | 可靠性 | 用户信息/告警加载失败不阻塞 UI | 手动模拟网络错误 |

---

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React | 18.3 | 现有，不升级 |
| 语言 | TypeScript | 5.5 | 现有，`strict: true` |
| 状态管理 | useState（局部） | — | 现有模式，无全局 store 需求；用户信息和告警通过 props 下传 |
| 路由 | 无路由库 | — | 维持条件渲染（`page` state），不引入 react-router |
| 样式方案 | CSS Modules | Vite 内置 | 细粒度组件拆分的配套方案；避免全局命名冲突；Vite 零配置支持 `*.module.css` |
| 数据请求 | fetch 封装（`api.ts`） | — | 现有，维持不变；新增 `api.me()` 和 `api.alerts()` 已存在 |
| 构建 | Vite | 5.4 | 现有，不升级 |
| 动画 | CSS transition/animation | — | 纯 CSS 实现发光/扫描线/fadeIn；不引入 Framer Motion |
| 图标 | Unicode / CSS 绘制 | — | 铃铛 🔔、用户 👤 等用 emoji 或 CSS border 模拟；不引入图标库 |

### 3.2 页面与路由结构

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| Login | 条件渲染（`!authed`） | 居中卡片 | FEAT-06：霓虹发光边框、扫描线动画背景 |
| Containers | 条件渲染（`page==="containers"`） | topbar + Toolbar + Grid | FEAT-02/05：Modal + 工具栏分区 |
| LLM | 条件渲染（`page==="llm"`） | topbar + Form + Terminal Result | FEAT-07：终端风输出 |
| Audit | 条件渲染（`page==="audit"`） | topbar + Filter + Table | FEAT-08：发光行 hover |

> 维持现有条件渲染模式，不引入路由库。路由结构无变更。

### 3.3 组件设计

**组件树**（容器/展示分离，新增组件标 ★）

```
App (容器)                          # 现有，改：调 /api/v1/me，管理 auth/user/page 状态
├─ Topbar (容器) ★                  # 新增：获取用户信息 + 告警数据
│  ├─ Brand (展示) ★                # 新增：品牌名 + 赛博朋克 logo 区
│  ├─ Nav (展示) ★                  # 新增：导航按钮组（从 App 上移）
│  ├─ NotificationBell (容器) ★     # 新增：轮询告警 + 未读数
│  │  └─ AlertDropdown (展示) ★     # 新增：告警下拉面板
│  └─ UserMenu (展示) ★            # 新增：用户名 + 退出按钮
├─ Login (页面容器)                 # 现有，改：赛博朋克样式
│  └─ LoginCard (展示) ★            # 新增：登录卡片组件
├─ Containers (页面容器)            # 现有，重构
│  ├─ Toolbar (展示) ★              # 新增：工具栏
│  │  ├─ ActionButtons (展示) ★     # 新增：创建容器/重载 Skill 按钮
│  │  ├─ SearchInput (展示) ★       # 新增：userId 搜索
│  │  └─ StatusFilter (展示) ★      # 新增：状态下拉
│  ├─ ContainerGrid (展示) ★        # 新增：容器表格
│  │  └─ ContainerRow (展示) ★      # 新增：单行（操作按钮）
│  └─ CreateModal (容器) ★          # 新增：创建容器模态框
├─ LLM (页面容器)                   # 现有，改：赛博朋克样式
│  ├─ LLMForm (展示) ★              # 新增：LLM 表单
│  └─ LLMTerminal (展示) ★          # 新增：测试结果终端风
└─ Audit (页面容器)                 # 现有，改：赛博朋克样式
   ├─ AuditFilter (展示) ★          # 新增：审计筛选
   └─ AuditTable (展示) ★           # 新增：审计表格
      └─ AuditRow (展示) ★          # 新增：单行
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | Topbar | 容器 | 新建 | 获取 `/api/v1/me` + 告警轮询；组合 Brand/Nav/Bell/UserMenu |
| CMP-02 | Brand | 展示 | 新建 | 显示"muad 控制台"品牌名 + 霓虹效果 |
| CMP-03 | Nav | 展示 | 新建 | 导航按钮组（容器/模型配置/审计日志），高亮当前页 |
| CMP-04 | NotificationBell | 容器 | 新建 | 每 30s 轮询 `/api/v1/alerts`；管理未读数 + 面板开闭 |
| CMP-05 | AlertDropdown | 展示 | 新建 | 告警下拉面板：级别色标 + 用户 + 消息列表 |
| CMP-06 | UserMenu | 展示 | 新建 | 用户名显示 + "退出"按钮 |
| CMP-07 | LoginCard | 展示 | 新建 | 登录表单卡片：霓虹边框、背景动画、输入框发光 focus |
| CMP-08 | Toolbar | 展示 | 新建 | 工具栏：`justify-content: space-between`；左 ActionButtons，右 SearchInput+StatusFilter |
| CMP-09 | ContainerGrid | 展示 | 新建 | 容器表格：columns 同现有，行 hover 发光 |
| CMP-10 | ContainerRow | 展示 | 新建 | 单行：状态徽章、指标、操作按钮组（启停/重启/日志/升级/删除） |
| CMP-11 | CreateModal | 容器 | 新建 | 创建容器模态框：表单状态管理 + 提交 + 校验 |
| CMP-12 | LLMTerminal | 展示 | 新建 | 终端风输出区：黑底青字 monospace `<pre>` |

> 现有 4 个页面组件（Login/Containers/LLM/Audit）保留但重构为容器组件，子 UI 提取为展示组件。

### 3.4 组件接口契约

**CMP-01 `<Topbar>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `page` | `Page` | 是 | — | 当前页面，传给 Nav 高亮 |
| `onNavigate` | `(p: Page) => void` | 是 | — | 导航回调 |
| `onLogout` | `() => void` | 是 | — | 退出回调 |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onNavigate` | `Page` | Nav 按钮点击 |
| `onLogout` | — | 退出按钮点击 |

**CMP-04 `<NotificationBell>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| —（无 props，自行轮询） | | | | |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| —（无回调，独立消费数据） | | | |

**内部状态**: `alerts: Alert[]`、`open: boolean`，30s `setInterval` 轮询。

**CMP-07 `<LoginCard>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `onLogin` | `() => void` | 是 | — | 登录成功后回调 |

**CMP-08 `<Toolbar>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `search` | `string` | 是 | — | 搜索文本 |
| `statusFilter` | `string` | 是 | `"all"` | 状态筛选值 |
| `onSearchChange` | `(v: string) => void` | 是 | — | 搜索变化 |
| `onStatusChange` | `(v: string) => void` | 是 | — | 筛选变化 |
| `onCreateClick` | `() => void` | 是 | — | 打开创建模态框 |
| `onReloadSkills` | `() => void` | 是 | — | 重载 Skill |

**CMP-09 `<ContainerGrid>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `items` | `Container[]` | 是 | — | 容器列表 |
| `alerts` | `Alert[]` | 是 | — | 告警列表（行内标注用） |
| `onAction` | `(id: string, action: string) => void` | 是 | — | 操作回调 |
| `onLogs` | `(id: string) => void` | 是 | — | 查看日志 |
| `onUpgrade` | `(c: Container) => void` | 是 | — | 升级 |
| `onDelete` | `(id: string) => void` | 是 | — | 删除 |

**CMP-11 `<CreateModal>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `open` | `boolean` | 是 | — | 是否可见 |
| `onClose` | `() => void` | 是 | — | 关闭回调 |
| `onCreated` | `() => void` | 是 | — | 创建成功后回调 |

**内部状态**: `form: {userId, botId, secret}`、`busy: boolean`、`err: string`。

**CMP-12 `<LLMTerminal>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `output` | `string` | 否 | `""` | 终端输出文本 |
| `loading` | `boolean` | 否 | `false` | 测试进行中 |
| `error` | `string` | 否 | `""` | 错误信息 |

### 3.5 状态与数据流

**状态划分**

| 状态 | 作用域 | 形状 | 读写方 |
|------|--------|------|--------|
| `authed` | App local | `boolean` | App（读/写） |
| `page` | App local | `Page` | App（写）, Topbar/Nav（读） |
| `user` | Topbar local | `{ name: string } \| null` | Topbar 内 useEffect → `/api/v1/me` |
| `alerts` | NotificationBell local | `Alert[]` | NotificationBell 内 setInterval → `/api/v1/alerts` |
| `bellOpen` | NotificationBell local | `boolean` | NotificationBell（读/写） |
| `containers` | Containers page local | `Container[]` | Containers useEffect + refresh |
| `search` | Containers page local | `string` | Toolbar（读/写），Containers 计算 derived filtered list |
| `statusFilter` | Containers page local | `string` | Toolbar（读/写），Containers 计算 derived filtered list |
| `modalOpen` | Containers page local | `boolean` | Containers（写）, CreateModal（读） |
| `logView` | Containers page local | `{id, text} \| null` | Containers（读/写），日志模态框 |

**数据流**

```
App mount
  → token.get() 决定 authed
  → authed 时 Topbar mount
      → useEffect: GET /api/v1/me → setUser({name})
      → NotificationBell mount
          → setInterval 30s: GET /api/v1/alerts → setAlerts

Containers mount
  → useEffect: GET /api/v1/containers + GET /api/v1/alerts → setContainers + setAlerts
  → setInterval 5s: 同上

创建容器:
  Toolbar "创建容器" onClick → setModalOpen(true)
  → CreateModal 填写 → POST /api/v1/containers
  → 成功: setModalOpen(false) + refresh()

列表过滤（客户端，不请求后端）:
  containers → filter by search (userId includes) + statusFilter → filteredItems → ContainerGrid
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `api.me()` ★ | `GET /api/v1/me` | Topbar useEffect |
| `api.alerts()` | `GET /api/v1/alerts` | NotificationBell + Containers |
| `api.listContainers()` | `GET /api/v1/containers` | Containers useEffect |
| `api.createContainer()` | `POST /api/v1/containers` | CreateModal submit |
| `api.login()` | `POST /api/v1/auth/login` | LoginCard submit |

> ★ `api.me()` 为新增方法（~5 行）；其余均已有。

### 3.6 UI 状态

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| Topbar 用户信息 | "加载中…"文字 | — | "未知用户" | 显示用户名 |
| 告警铃铛 | 铃铛无徽章 + 脉冲动画 | "暂无告警"（面板内） | 静默保持上次数据 | 显示徽章数量 |
| 容器列表 | — | "暂无容器，点击创建容器开始"（空态引导） | 错误信息 + "重试"按钮 | 正常表格 |
| 容器列表过滤后 | — | "无匹配容器" + 清除过滤按钮 | — | 过滤后表格 |
| 创建容器模态框 | 提交按钮 "创建中…" + disabled | — | 表单内错误信息 | 关闭模态框 + "创建成功"提示 |
| 容器操作按钮 | 按钮文字变 "…中" + disabled | — | 错误 toast | 操作成功提示 |
| LLM 测试连接 | 终端显示 "Testing…" + 闪烁光标 | — | 终端红字错误 | 终端青字结果 |
| 审计日志 | 表格 skeleton | "暂无审计记录" | 错误信息 + "重试" | 正常表格 |
| Login 登录 | 按钮 "登录中…" + disabled | — | 红色错误提示 | 跳转主页面 |

### 3.7 样式方案

| 维度 | 约定 |
|------|------|
| **样式与逻辑分离** | 每个组件配 `*.module.css`，展示组件不发起请求；全局变量保留在 `styles.css`（`:root` tokens） |
| **设计 tokens** | 见下方 tokens 表；组件内引用 `var(--color-neon-cyan)` 等，不写硬编码色值 |
| **响应式断点** | 仅桌面端（≥1280px），不做移动端适配；工具栏在 <1024px 时右侧筛选换行 |

**设计 tokens** (`:root` 变量，定义在 `styles.css`，全项目共享)

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg-primary` | `#08080f` | 主背景 |
| `--bg-panel` | `#0f0f1a` | 面板/卡片背景 |
| `--bg-elevated` | `#151525` | 模态框/下拉面板背景 |
| `--color-neon-cyan` | `#00e5ff` | 主霓虹色（边框发光、链接、强调） |
| `--color-neon-purple` | `#b347ea` | 辅助霓虹（hover、渐变参与） |
| `--color-neon-pink` | `#ff2d95` | 强调霓虹（危险操作、徽章） |
| `--color-success` | `#00ff88` | 成功/运行中 |
| `--color-danger` | `#ff4466` | 危险/错误/停止 |
| `--color-warning` | `#ffaa00` | 警告 |
| `--color-text-primary` | `#c8d6e5` | 主文字 |
| `--color-text-muted` | `#5a6a80` | 次级文字 |
| `--border-glow` | `0 0 8px var(--color-neon-cyan)` | 霓虹发光（box-shadow） |
| `--border-glow-strong` | `0 0 16px var(--color-neon-cyan)` | 强发光（hover） |
| `--font-mono` | `"JetBrains Mono", "Fira Code", ui-monospace, monospace` | 终端/代码字体 |
| `--font-ui` | `system-ui, -apple-system, sans-serif` | UI 字体 |
| `--transition-fast` | `0.15s ease` | 过渡时间 |

**CSS Modules 文件规划**

| 文件 | 覆盖组件 |
|------|---------|
| `src/styles.css` | `:root` tokens + 全局 reset + body + 动画 keyframes（扫描线/glow-pulse） |
| `src/components/Topbar.module.css` | CMP-01/02/03/06 |
| `src/components/NotificationBell.module.css` | CMP-04/05 |
| `src/pages/Login.module.css` | Login + CMP-07 LoginCard |
| `src/pages/Containers.module.css` | Containers + CMP-08/09/10 |
| `src/components/CreateModal.module.css` | CMP-11 |
| `src/pages/LLM.module.css` | LLM + CMP-12 |
| `src/pages/Audit.module.css` | Audit + AuditFilter/AuditTable/AuditRow |

**文件结构变更**

```
src/
├── components/           ★ 新建
│   ├── Topbar.tsx
│   ├── Topbar.module.css
│   ├── NotificationBell.tsx
│   ├── NotificationBell.module.css
│   ├── CreateModal.tsx
│   └── CreateModal.module.css
├── pages/
│   ├── Login.tsx         (重构)
│   ├── Login.module.css  ★
│   ├── Containers.tsx    (重构)
│   ├── Containers.module.css ★
│   ├── LLM.tsx           (重构)
│   ├── LLM.module.css    ★
│   ├── Audit.tsx         (重构)
│   └── Audit.module.css  ★
├── App.tsx               (重构)
├── App.module.css        ★
├── api.ts                (+ me())
├── main.tsx              (不变)
└── styles.css            (重写: tokens + reset + keyframes)
```

### 3.8 可访问性与兼容性

| 维度 | 要求 |
|------|------|
| 可访问性 | 输入框配 `<label>`；模态框打开时焦点锁定在模态框内，Esc 关闭；按钮有明确文字标签（不依赖纯 icon）；错误信息用 `role="alert"` |
| 浏览器/设备兼容 | Chrome 120+、Edge 120+、Firefox 128+；仅桌面 ≥1280px；不使用 `backdrop-filter`（降级为纯色不透明） |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 |
|--------|------|------|---------|
| RISK-01 | 无设计稿，赛博朋克效果依赖纯 CSS 实现 | 视觉效果可能不够精致 | 参考成熟赛博朋克 CSS 色板；分页迭代；先做 tokens + 核心组件，后微调 |
| RISK-02 | CSS Modules 与现有全局 CSS 共存可能产生优先级冲突 | 组件样式异常 | 全局 CSS 只保留 `:root` + reset + keyframes；组件样式全走 Modules |
| RISK-03 | 组件细粒度拆分后 props drilling 加深（App → Topbar → Nav） | 中间组件 props 膨胀 | 当前层级 ≤3 层（App → Topbar → Nav），在可接受范围；暂不引入 Context |
| RISK-04 | `npm audit` 报告 2 个漏洞（1 moderate, 1 high） | 不影响 UI 改动 | 后续单独 `npm audit fix` |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| US / FEAT / NFR | 用户故事 / 功能项 / 非功能需求 |
| CMP | Component，组件 |
| 容器组件 | 负责数据获取与状态的组件 |
| 展示组件 | 纯 UI、props 驱动、事件上抛的组件 |
| CSS Modules | 组件级样式隔离方案（`*.module.css`），Vite 零配置支持 |
| tokens | 设计令牌：CSS 变量集中定义的色板、间距、字体等 |

---

*文档结束*

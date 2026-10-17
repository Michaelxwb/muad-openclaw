# Skill 执行链路审计与限额终止 前端模块需求与设计简报

> **文档编号**: FE-SEC-001
> **文档版本**: v0.1
> **创建日期**: 2026-10-17
> **文档状态**: 设计评审中

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）
- **设计评审**: 第 3 章（前端技术设计）

**ID 体系**: US（来自需求讨论）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
场景编号：S-（正常）、E-（异常）、B-（边界）

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 | 待定 | 技术方案、代码实现 |
| 设计/交互 | 待定 | 视觉与交互稿（如有） |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-10-17 | 需求对齐讨论 | 初始草稿 |

---

## 2. 需求分析

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | Skill 执行链路审计与限额终止（控制台界面） |
| **需求类型** | 页面功能扩展 |
| **业务背景** | 执行日志目前只有 who-when-what；系统设置只有资源配额；告警无外发配置入口。 |
| **核心目标** | 让管理员在 Console 内配置上限与告警、回放执行过程、定位问题 Skill。 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-06 | 系统设置：请求上限 | 资源设置区新增"单 Skill 单接口请求上限"数字字段（0=不限制，默认 1000） | P0 | US-03 |
| FEAT-07 | 系统设置：企微告警 | 新增"告警推送"区块：启用开关、webhook 输入（打码回显）、测试按钮、保存 | P0 | US-03 |
| FEAT-09 | Skill 健康视图 | 审计页新增页签，按时间窗口展示 Skill 级执行/异常聚合（含用户维度，私有 Skill 同名不合并），可钻取 | P0 | US-02 |
| FEAT-10 | 执行时间线 | 执行日志行展开抽屉：汇总头部（请求数/错误数/超限标记/截断提示）+ 事件时间线 | P0 | US-01 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | 系统设置页两处表单；审计页执行时间线抽屉；审计页 Skill 健康页签；对应的类型、API 封装、i18n 与测试。 |
| **非范围（Out of Scope）** | 告警通道多类型管理页；按 Skill 覆盖阈值；历史数据清理入口；trace 导出。 |
| **有意妥协 / 技术债** | 时间线明细最多展示 2000 条（后端上限）；健康视图先给固定标记规则，不提供阈值配置。 |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 测试层级 | 关键真实边界 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|---------|-------------|
| S-21 | FEAT-10 | P0 | E2E | API → 状态 → 抽屉渲染 | 打开审计页，展开一次执行 | 抽屉显示汇总（请求数、错误数、耗时、Top 接口）与按时间排序的事件；http 事件显示 method/host/path/status/耗时 |
| S-22 | FEAT-10 | P0 | integration | 状态 → UI | 被终止的执行 | 顶部显示"已因请求超限终止"徽标与接口/次数；abort 事件在时间线中高亮 |
| S-23 | FEAT-06/07 | P0 | E2E | 表单 → api.ts → 后端 → 回显 | 修改上限并保存；填写 webhook 并测试 | 保存成功提示；刷新后回显新值；webhook 回显为打码地址；测试结果就地展示成功/失败原因 |
| S-24 | FEAT-09 | P0 | E2E | API → 列表 → 钻取 | 打开 Skill 健康页签，选择 7 天窗口 | 列表按异常程度排序，显示用户/Skill/执行数/超限数/最大请求数/错误率；同名私有 Skill 分不同用户两行；点击行后跳转/过滤到该用户的执行日志 |
| S-25 | FEAT-10 | P0 | integration | API 返回 truncated | 打开明细被截断的执行 | 时间线顶部显示"明细已截断，共 N 次请求"，不隐藏该提示 |

**异常场景**

| 场景ID | 功能ID | 测试层级 | 关键真实边界 | 触发条件 | UI 表现 |
|--------|--------|---------|-------------|---------|---------|
| E-21 | FEAT-10/09 | integration | 请求失败 → 错误态 | 接口 4xx/5xx/网络失败 | 区块内 Banner 展示 `ApiError.message`，`ErrorDetail` 折叠技术细节，提供重试 |
| E-22 | FEAT-06 | integration | 表单校验 | 上限为负数或非整数 | 字段级错误提示，保存按钮不发起请求 |
| E-23 | FEAT-07 | integration | 测试接口返回 errcode≠0 | webhook key 失效/限频 | 就地展示后端返回的失败原因，保留已填内容，不清空表单 |
| E-24 | FEAT-09 | integration | 空数据 | 窗口内无执行 | 空态文案与引导，不显示假数据 |
| E-25 | FEAT-10 | integration | 权限/404 | 执行已被清理或不存在 | 抽屉显示"执行不存在"，不白屏 |

**边界场景**

| 场景ID | 测试层级 | 关键真实边界 | 字段/条件 | 边界值 | 预期行为 |
|--------|---------|-------------|----------|--------|---------|
| B-21 | unit | 表单映射 | 上限 0 | 0 | 显示"不限制"说明，保存成功 |
| B-22 | unit | 时间线渲染 | 事件数量上限 | 2000 条 | 虚拟列表/分页首屏可用，不卡顿（目标：首屏 ≤1s） |
| B-23 | integration | 健康列表分组 | 两个用户同名私有 Skill | 各 1 行 | 展示两行并分别显示用户名；钻取筛选带 humanUserId |
| B-24 | integration | 旧 Skill 时间线 | 仅有 exec 事件 | 1 条 exec | 正常渲染 exec 时间线并提示"未使用统一客户端"，不显示空错误 |

---

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React 18 + TypeScript strict | 现有 | 项目约定 |
| 组件库 | `@douyinfe/semi-ui` | 现有 | 全局 `ConfigProvider` 已在 `main.tsx` 挂载，禁止页面重复包裹 |
| 状态管理 | 页面局部 state + page hook | 现有 | 无跨页共享需求 |
| 路由 | `App.tsx` 页面切换 + 页内 Tabs | 现有 | 审计页已有页签模式 |
| 样式 | CSS Modules + Semi token | 现有 | 禁止散落魔法色值 |
| 数据请求 | `src/api.ts` | 现有 | 统一 `code===0` 解包、`ApiError`、401 处理 |

### 3.2 页面与路由结构

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| 系统设置 | `Settings`（现有页） | 现有 `PageSection` 纵向区块 | 资源区新增字段；新增「告警推送」区块 |
| 审计日志 | `Audit`（现有页） | 现有 Tabs | 新增「Skill 健康」页签；执行日志表格行支持展开抽屉 |

### 3.3 组件设计

**组件树**

```
<Settings>                          # 容器：useGlobalResources + useNotifySettings
├─ <ResourceForm>                   # 展示：追加 skillRequestLimit 字段
└─ <NotifySettings>               # 容器：告警通道读取/保存/测试
   └─ <NotifySettingsForm>        # 展示：开关、webhook、测试按钮

<Audit>                             # 容器：页签切换
├─ <SkillExecutionLogTab>           # 现有容器：列表 + 筛选
│  └─ <ExecutionTraceDrawer>        # 容器：按 executionId 拉 trace
│     ├─ <TraceSummaryHeader>       # 展示：汇总 + 超限/截断徽标
│     └─ <TraceTimeline>            # 展示：事件列表
└─ <SkillHealthTab>                 # 容器：stats 拉数 + 窗口切换
   └─ <SkillHealthTable>            # 展示：聚合行 + 点击钻取
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | `NotifySettings` | 容器 | 新建 `components/settings/NotifySettings.tsx` | 读写告警配置、测试、三态 |
| CMP-02 | `NotifySettingsForm` | 展示 | 新建 | 开关/输入/测试按钮，事件上抛 |
| CMP-03 | `ExecutionTraceDrawer` | 容器 | 新建 `pages/audit/ExecutionTraceDrawer.tsx` | 拉取 trace、错误/加载态 |
| CMP-04 | `TraceSummaryHeader` | 展示 | 新建 | 汇总、aborted/truncated 徽标 |
| CMP-05 | `TraceTimeline` | 展示 | 新建 | 事件时间线，稳定 key=`eventId` |
| CMP-06 | `SkillHealthTab` | 容器 | 新建 `pages/audit/SkillHealthTab.tsx` | 窗口切换、stats 拉数 |
| CMP-07 | `SkillHealthTable` | 展示 | 新建 | 聚合表格（用户/Skill/异常指标）、行点击钻取 |
| CMP-08 | `ResourceForm` | 展示 | 复用并扩展 `Settings.tsx` 内组件 | 追加请求上限字段 |

### 3.4 组件接口契约

**CMP-03 `<ExecutionTraceDrawer>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| executionId | string | 是 | — | 选中执行 id |
| visible | boolean | 是 | — | 抽屉显隐 |
| onClose | () => void | 是 | — | 关闭回调 |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onClose` | void | 关闭抽屉/遮罩 |

**CMP-06 `<SkillHealthTab>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| active | boolean | 是 | — | 页签是否激活，用于懒加载 |
| onOpenSkill | (skillName: string) => void | 是 | — | 钻取到执行日志并带入筛选 |

**CMP-02 `<NotifySettingsForm>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| value | NotifySettingsValue | 是 | — | `{enabled, webhook}` |
| busy | boolean | 是 | — | 保存/测试中 |
| onChange | (next: NotifySettingsValue) => void | 是 | — | 表单变化上抛 |

### 3.5 状态与数据流

**状态划分**

| 状态 | 作用域 | 形状 | 读写方 |
|------|--------|------|--------|
| resources.form | Settings 页 local hook | `ResourceConfig`（含 skillRequestLimit） | ResourceForm / useGlobalResources |
| notify.value/busy/error | Settings 页 local hook | `{enabled, webhook, masked, errcode}` | NotifySettings |
| trace.data/loading/error | Drawer local | `ExecutionTrace` | ExecutionTraceDrawer |
| health.window/items/loading/error | HealthTab local | `SkillHealthItem[]` | SkillHealthTab |

**数据流**

```
用户操作 → 事件处理 → api.ts 方法 → ApiError/数据 → 页面状态 → 重渲染
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `getSkillExecutionTrace(executionId)` | `GET /api/v1/skill-executions/{id}/trace` | `useExecutionTrace` |
| `listSkillHealth(params)` | `GET /api/v1/skill-executions/stats` | `useSkillHealth` |
| `getNotifySettings()` / `updateNotifySettings(body)` | `GET/PUT /api/v1/settings/notify` | `useNotifySettings` |
| `testNotifySettings()` | `POST /api/v1/settings/notify/test` | `useNotifySettings` |
| `getGlobalResources()` / `updateGlobalResources(body)`（扩展字段） | `GET/PUT /api/v1/settings/resources` | `useGlobalResources` |

类型统一放 `src/types/api.ts`：`SkillExecutionTrace`、`SkillTraceEvent`、`SkillExecutionMetrics`、`SkillHealthItem`（含 `humanUserId`/`humanUserName`）、`NotifySettings`；由 `api.ts` re-export，页面/组件不得自定义漂移 DTO 或硬编码路径。

### 3.6 UI 状态

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 执行时间线抽屉 | 抽屉内骨架/转圈 | "该执行暂无明细事件" | Banner + ErrorDetail + 重试 | 汇总头 + 时间线 |
| 执行时间线（旧 Skill 仅有 exec 事件） | 同抽屉 | 空接口事件区 | —（不是错误） | 显示 exec 时间线 + 提示"该 Skill 未使用统一客户端，暂无接口明细" |
| Skill 健康列表 | 表格 loading（仅首载；窗口切换走 background 刷新不闪） | 空态文案 | Banner + 重试 | 聚合表格 |
| 告警配置 | 区块 loading | 未配置时占位说明 | 字段/区块错误 | 打码地址 + 启用状态 |
| 请求上限字段 | 随资源区 loading | — | 字段级错误 | 保存成功提示 |

### 3.7 样式方案

| 维度 | 约定 |
|------|------|
| 样式与逻辑分离 | 时间线与汇总用 `Audit.module.css` 新增类；设置区块复用 `Settings.module.css` 表单网格 |
| 设计 tokens | 颜色/间距引用 Semi token；aborted 使用 danger 语义色，truncated 使用 warning 语义色 |
| 响应式断点 | 抽屉最小宽度 480px，窄屏全宽；时间线字段在窄屏换行展示 |

### 3.8 可访问性与兼容性

| 维度 | 要求 |
|------|------|
| 可访问性 | 抽屉可用 Esc 关闭；表格行可键盘触发；徽标有可读文本而非仅颜色 |
| 浏览器/设备兼容 | 与现有 Console 一致（现代 Chromium） |

### 3.9 文案与 i18n

- 新增用户可见文案全部走 `useTranslation()`，新增 key 同步补 `src/i18n/locales/zh.ts` 与 `en.ts`。
- key 前缀：`settings.skillRequestLimit*`、`settings.notify*`、`audit.trace*`、`audit.health*`。
- 时间线与健康视图的列配置在组件内 `useMemo(..., [t])` 生成，避免模块级数组冻结旧文案。
- 错误提示统一经 `errorMessage(error, fallbackKey)`，技术细节只放 `ErrorDetail`。

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 | 验证场景 |
|--------|------|------|------|---------|
| RISK-FE-01 | 长时间线渲染卡顿 | 体验差 | 首屏限制 + 分页/虚拟化 | B-22 |
| RISK-FE-02 | 告警 webhook 回显泄露 | 安全 | 后端打码 + 输入框不回填完整 key（留空表示不修改） | S-23、S-11 |
| RISK-FE-03 | 窗口切换触发全表 loading 闪烁 | 体验差 | 后台刷新不置 loading（项目约定） | S-24 |

---

## Spec Compliance Matrix

| Spec/Rule | enforcement | 设计影响 | 设计落点 | 验证场景 | 状态/N/A 理由 |
|-----------|-------------|---------|---------|---------|----------------|
| `frontend-component-specs#RULE-frontend-component-001` | required | 容器/展示拆分，props 类型化，稳定 key | §3.3、§3.4 | S-21、E-21 | applied |
| `frontend-component-specs#RULE-frontend-semi-shell-001` | required | 复用 Semi 与全局 ConfigProvider，不重复挂 theme | §3.1 | S-23 | applied |
| `frontend-directory-structure#RULE-frontend-directory-001` | required | 新组件放 pages/audit、components/settings；HTTP 经 api.ts | §3.3、§3.5 | S-21 | applied |
| `frontend-directory-structure#RULE-frontend-api-types-001` | required | 类型集中 types/api.ts，api.ts 统一路径 | §3.5 | S-23 | applied |
| `frontend-quality-standards#RULE-frontend-quality-001` | required | strict TS、三态处理、vitest | §3.6、§4 | E-21、B-22 | applied |
| `frontend-quality-standards#RULE-frontend-api-client-001` | required | 全部请求经 api.ts | §3.5 | 正则 verifier | applied |
| `frontend-quality-standards#RULE-frontend-i18n-001` | required | 新增 key 同步 zh/en | §3.9 | S-23、S-24 | applied |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| trace | 一次 Skill 执行的事件时间线与汇总指标 |
| Skill 健康 | 按窗口聚合的 Skill 执行质量视图 |
| 钻取 | 从健康列表跳转到该 Skill 的执行日志并带入筛选 |

---

*文档结束*

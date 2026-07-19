# Skill 执行日志前端设计

> **文档编号**: FE-SKILL-AUDIT-001  
> **文档版本**: v0.1  
> **创建日期**: 2026-07-14  
> **文档状态**: 设计评审中

## 1. 文档控制

### 1.1 修订历史

| 版本 | 日期 | 变更描述 |
|------|------|---------|
| v0.1 | 2026-07-14 | 审计日志双 Tab、Skill 执行列表和详情设计 |

## 2. 需求分析

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | 审计日志页面 |
| **需求类型** | 页面功能完善、信息架构调整 |
| **业务背景** | 当前页面只展示管理员、Pod 和平台运行时操作；Skill 成功、失败、拒绝等执行结果没有独立视角 |
| **核心目标** | 在同一个“审计日志”一级菜单中，用两个 Tab 分开展示平台操作审计与 Skill 执行日志，并提供可定位问题的执行详情 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-FE-01 | 审计双 Tab | 页面增加“操作审计”和“Skill 执行日志”两个 Tab，现有操作列表行为保持不变 | P0 | 需求描述 |
| FEAT-FE-02 | Skill 执行列表 | 展示时间、用户、Pod、Skill、来源、状态、耗时、工具和错误摘要 | P0 | 需求描述 |
| FEAT-FE-03 | 筛选与分页 | 使用单个搜索框对 Skill、Pod、用户和 Agent 统一模糊搜索，并支持状态、范围、模式和时间筛选；分页页量为 10/20/50/100，默认 10 | P0 | 需求描述 |
| FEAT-FE-04 | 执行详情 | 通过详情弹窗展示生命周期、进度、脱敏输入/输出、错误码和终态原因 | P0 | 需求描述 |
| FEAT-FE-05 | 运行中刷新 | 当前页存在 running 记录时定时刷新；离开 Tab 或无运行记录时停止 | P1 | 需求描述 |
| FEAT-FE-06 | 四态反馈 | 完整处理 loading、empty、error、success，不因空字段或非法 progress JSON 黑屏 | P0 | 需求描述 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | `Audit` 页面 Tab 化、操作审计现有逻辑拆分、Skill 执行表格、筛选、分页、详情弹窗、API 类型和组件测试 |
| **非范围（Out of Scope）** | 在审计页面重试或重新执行 Skill；展示完整敏感输入和输出；提供执行记录删除功能；修改左侧一级菜单结构 |
| **有意妥协** | 第一版详情以文本进度时间线为主，不做分布式 Trace 瀑布图 |

### 2.4 验收条件

| 场景ID | 功能ID | 类型 | 操作 | 预期 UI 结果 | 测试层级与真实边界 |
|--------|--------|------|------|-------------|------------------|
| S-101 | FEAT-FE-01 | 正常 | 进入审计日志，切换两个 Tab | 两个 Tab 内容互不混合；切换后保留各自筛选和分页状态 | Component + E2E：真实路由和 API |
| S-102 | FEAT-FE-02、03 | 正常 | 在统一搜索框输入 Skill、Pod、用户或 Agent 关键字并选择失败状态 | 请求使用单个 `q`，表格仅显示匹配记录，总数和分页正确 | Component：mock API；E2E：真实列表 API |
| S-103 | FEAT-FE-04 | 正常 | 点击任一执行的“详情” | 弹窗展示基本信息、进度、脱敏摘要和错误信息，关闭后列表状态不变 | Component |
| S-104 | FEAT-FE-03 | 边界 | 切换每页 10、20、50、100 | 页量选择位于分页左侧，切换后回到第 1 页并重新查询 | Component |
| S-105 | FEAT-FE-05 | 正常 | 当前页包含 running 记录 | 仅当前 Tab 激活时轮询；记录进入终态后停止轮询 | Unit + Component |
| E-101 | FEAT-FE-06 | 异常 | 列表 API 失败 | PageSection 内显示标准错误反馈，可重新查询，页面不白屏 | Component |
| E-102 | FEAT-FE-04、06 | 异常 | 详情 API 失败或 `progress` 为空/非法 | 弹窗显示错误或空进度，不访问 null 的 `.length` | Unit + Component |
| B-101 | FEAT-FE-02、04 | 边界 | 摘要、Skill 名、错误信息超长 | 表格省略并提供 tooltip；详情可换行查看，不撑破弹窗 | Component + screenshot |

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 说明 |
|------|------|------|
| 框架 | React + TypeScript strict | 延续现有 Console 技术栈 |
| UI | Semi Design | 使用 `Tabs`、`Table`、`Form/Select/Input`、`Modal`、`Tag`、`Skeleton`、`Empty` |
| 状态 | 页面局部 hook | 两个 Tab 数据独立，不引入全局状态库 |
| API | `src/api.ts` 统一封装 | 页面和组件禁止裸 `fetch` |
| 样式 | 现有 Console Page 组件 + CSS Modules/全局 token | 与其他列表页保持一致 |

### 3.2 页面与路由结构

继续使用现有审计日志路由，不新增一级菜单。Tab 通过查询参数持久化：

| 页面状态 | URL 示例 | 默认值 |
|---------|---------|--------|
| 操作审计 | `/audit?tab=operations` | 默认 |
| Skill 执行日志 | `/audit?tab=skill-executions` | 非默认 |

刷新页面后按 `tab` 恢复当前视图；非法值回退到 `operations`，不能跳回 Pod 管理页。

### 3.3 组件设计

```text
AuditPage
├─ PageHeader
├─ Tabs
│  ├─ OperationAuditTab
│  │  ├─ OperationAuditToolbar
│  │  └─ OperationAuditTable
│  └─ SkillExecutionLogTab
│     ├─ SkillExecutionToolbar
│     ├─ SkillExecutionTable
│     └─ SkillExecutionDetailModal
└─ FeedbackBanner
```

| 组件ID | 组件名 | 类型 | 职责 |
|--------|--------|------|------|
| CMP-01 | `AuditPage` | 容器 | 管理 Tab 与 URL 同步，不承载具体列表查询 |
| CMP-02 | `OperationAuditTab` | 容器 | 承接现有 `Audit.tsx` 的操作审计加载、筛选和分页 |
| CMP-03 | `SkillExecutionLogTab` | 容器 | 管理执行日志查询、轮询、分页和详情选择 |
| CMP-04 | `SkillExecutionToolbar` | 展示 | 统一右上角筛选和搜索，事件上抛 |
| CMP-05 | `SkillExecutionTable` | 展示 | Semi Table、状态标签、摘要省略和统一分页 |
| CMP-06 | `SkillExecutionDetailModal` | 展示/轻容器 | 按 executionId 加载详情并展示进度和错误 |

### 3.4 组件接口契约

#### CMP-04 `SkillExecutionToolbar`

| Props | 类型 | 必填 | 说明 |
|-------|------|------|------|
| `value` | `SkillExecutionFilters` | 是 | 当前筛选输入 |
| `pods` | `PodOption[]` | 是 | Pod 选择项 |
| `busy` | `boolean` | 是 | 查询中状态 |
| `onChange` | `(value) => void` | 是 | 更新输入，不直接请求 |
| `onSearch` | `() => void` | 是 | 提交筛选并回到第 1 页 |
| `onReset` | `() => void` | 是 | 清空筛选 |

#### CMP-05 `SkillExecutionTable`

| Props | 类型 | 必填 | 说明 |
|-------|------|------|------|
| `rows` | `SkillExecution[]` | 是 | 当前页数据 |
| `loading` | `boolean` | 是 | 表格 loading |
| `pagination` | `TablePaginationState` | 是 | page/pageSize/total 及回调 |
| `onView` | `(executionId: string) => void` | 是 | 打开详情 |

#### CMP-06 `SkillExecutionDetailModal`

| Props | 类型 | 必填 | 说明 |
|-------|------|------|------|
| `executionId` | `string | null` | 是 | null 时关闭 |
| `onClose` | `() => void` | 是 | 关闭并清理详情状态 |

### 3.5 状态与数据流

#### 状态划分

| 状态 | 作用域 | 读写方 |
|------|--------|--------|
| `activeTab` | URL + AuditPage | Tab 切换和刷新恢复 |
| 操作审计 filters/page/pageSize | `useOperationAuditRecords` | OperationAuditTab |
| 执行日志 draftFilters/appliedFilters/page/pageSize | `useSkillExecutionRecords` | SkillExecutionLogTab |
| `selectedExecutionId` | SkillExecutionLogTab | 表格和详情弹窗 |
| 详情 loading/error/data | `useSkillExecutionDetail` | DetailModal |

#### 数据流

```text
切换 Skill 执行 Tab
  → useSkillExecutionRecords
  → api.listSkillExecutions(query)
  → rows/total
  → Semi Table

点击详情
  → selectedExecutionId
  → api.getSkillExecution(executionId)
  → Detail Modal
```

#### API 封装

| Service 方法 | 后端接口 | 调用方 |
|-------------|---------|--------|
| `api.audit(query)` | `GET /api/v1/audit` | OperationAuditTab |
| `api.listSkillExecutions(query)` | `GET /api/v1/skill-executions` | SkillExecutionLogTab |
| `api.getSkillExecution(id)` | `GET /api/v1/skill-executions/{id}` | SkillExecutionDetailModal |

`SkillExecutionStatus` 增加 `rejected`；`SkillExecution` 类型增加 `entryType`、`activationMode`、`lastToolName`、`terminalReason`。

### 3.6 表格与详情设计

#### 列表列

| 列 | 展示规则 |
|----|---------|
| 时间 | `startedAt` 本地时间，默认倒序 |
| 用户 / Agent | 用户显示名或 ID + `agentId` 次级文本 |
| Pod | `podId`，可跳转 Pod 详情 |
| Skill | `skillName` + scope Tag；名称过长省略 |
| 模式 | managed / 传统脚本 / 传统工具 |
| 状态 | 运行中、成功、失败、已取消、已拒绝，使用语义色 Tag |
| 耗时 | 小于 1 秒显示 ms，其余按秒格式化 |
| 最近工具 | `lastToolName`，无则 `-` |
| 结果 | 成功显示输出摘要，失败/拒绝显示错误摘要，单行省略 |
| 操作 | “详情”按钮 |

#### 详情弹窗

- 顶部信息区：executionId、用户、Agent、Pod、Skill、scope、entryType、状态、开始/结束时间、耗时。
- 生命周期区：按时间展示激活、工具进度和终态；`progress` 为 null、空数组或解析失败时显示“暂无进度明细”。
- 结果区：输入摘要、输出摘要、错误码、错误信息和终态原因。
- 不提供删除、重试或编辑按钮；右上角关闭即可。

### 3.7 UI 四态

| 视图 | loading | empty | error | success |
|------|---------|-------|-------|---------|
| 操作审计 | 表格 Skeleton | “暂无操作审计” | FeedbackBanner + 查询保留 | 操作审计表格 |
| 执行日志 | 表格 Skeleton | “暂无 Skill 执行记录” | FeedbackBanner + 重试 | 执行日志表格 |
| 执行详情 | Modal Spin/Skeleton | “暂无进度明细” | Modal 内错误 + 重试 | 详情内容 |

### 3.8 样式与交互约定

- PageHeader 下直接使用 Semi `Tabs`，Tab 内容为同一个 `PageSection`，不嵌套卡片。
- 列表操作位于表头左上角；搜索和筛选位于右上角。执行日志只读，因此左上角可为空，不保留无意义占位。
- 使用项目统一 `renderTablePagination`，页量选择位于翻页控件左侧，默认 10，可选 10/20/50/100。
- Modal 使用平台统一顶部间距和最大高度，内容区滚动，底部不增加“关闭”按钮。
- 长文本通过 Typography ellipsis + Tooltip 处理，不能扩大表格行高或撑破容器。
- 深色和浅色主题均使用 Semi token，不写固定背景色。

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 | 验证场景 |
|--------|------|------|------|---------|
| RISK-FE-01 | 执行进度历史数据为 null 或非法 JSON | 详情黑屏 | API 类型允许空值，解析失败回退空数组，Error Boundary 兜底 | E-102 |
| RISK-FE-02 | running 记录轮询导致重复或页面抖动 | 体验和性能下降 | 仅当前 Tab 且存在 running 时轮询；复用 requestId 防止旧响应覆盖 | S-105 |
| RISK-FE-03 | 两个 Tab 共享状态导致筛选串线 | 查询结果错误 | 拆成两个独立 hook，Tab 只负责组合 | S-101 |
| RISK-FE-04 | 大量摘要导致列表难扫描 | 页面拥挤 | 列表只展示单行摘要，完整脱敏内容进入详情 | B-101 |

## 5. 需求追溯矩阵

| 功能ID | 组件 | 后端接口 | 测试场景 |
|--------|------|---------|---------|
| FEAT-FE-01 | CMP-01、CMP-02、CMP-03 | `/api/v1/audit`、`/api/v1/skill-executions` | S-101 |
| FEAT-FE-02 | CMP-03、CMP-05 | `GET /api/v1/skill-executions` | S-102、B-101 |
| FEAT-FE-03 | CMP-04、CMP-05 | `GET /api/v1/skill-executions` | S-102、S-104 |
| FEAT-FE-04 | CMP-06 | `GET /api/v1/skill-executions/{id}` | S-103、E-102 |
| FEAT-FE-05 | CMP-03 | `GET /api/v1/skill-executions` | S-105 |
| FEAT-FE-06 | CMP-02、CMP-03、CMP-06 | 全部查询接口 | E-101、E-102 |

追溯自检：所有 FEAT 均有组件、接口和验收场景；异常与边界场景包含可自动化的真实 UI 结果。

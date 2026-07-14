# Skill 管理前端模块需求与设计简报

> **文档编号**: FE-SKILL-MGMT-v0.1  
> **文档版本**: v0.1  
> **创建日期**: 2026-07-13  
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章定义页面、交互和验收。
- **设计评审**: 第 3 章定义 React/Semi 组件、API 类型、状态流和样式约束。

**ID 体系**: US（用户故事）、FEAT（功能）、CMP（组件）、NFR（非功能指标）

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 |  | 前端页面、组件、API 类型和测试 |
| 设计/交互 |  | Skill 管理页面与用户详情 Tab 交互 |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-07-13 | Codex | 根据已对齐内容生成初始设计 |

---

## 2. 需求分析

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | Skill 管理 |
| **需求类型** | 新页面 + Human User 详情增强 |
| **业务背景** | 当前 Console 已有 Pod、用户、模型、平台和审计管理，但 Skill 只在 Runtime 层存在，管理员缺少全局资产视图和单用户最终生效视图。 |
| **核心目标** | 新增全局 Skill 管理页面，并在 Human User 详情中新增 Skills Tab，帮助管理员管理 Skill、排查冲突、检查凭证依赖和查看执行记录。 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-01 | 全局 Skill 资产列表 | 一级菜单进入，展示 system/public/private skill，支持搜索、scope/status 过滤和分页。 | P0 | US-01 |
| FEAT-01A | Public Skill 上传 | 在全局 Skill 管理页上传 `.tar.gz` 或 `.zip` public skill bundle，上传后刷新资产列表。 | P0 | US-01 |
| FEAT-02 | Skill 详情抽屉 | 展示 manifest 摘要、版本、来源、依赖平台、是否需要浏览器、是否支持进度。 | P0 | US-01 |
| FEAT-03 | Human User Skills Tab | 在用户详情中展示该用户最终生效 skill，包含来源、版本、冲突、凭证状态、最近执行。 | P0 | US-02 |
| FEAT-04 | 冲突/覆盖提示 | private 与 public/system 重名时在列表和详情中明确展示原因和处理动作。 | P0 | US-03 |
| FEAT-05 | 凭证依赖提示 | skill 依赖平台但用户未配置 key 或平台禁用时标红。 | P0 | US-04 |
| FEAT-06 | Private Skill 管理 | 上传、禁用、删除某用户 private skill；上传使用 Modal，不提供在线代码编辑。 | P1 | US-05 |
| FEAT-07 | 执行记录视图 | 全局或用户维度查看最近 skill 执行状态、耗时、进度阶段和失败原因。 | P1 | US-06 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | 新增一级菜单 Skill 管理；全局 Skill 表格；Public Skill 上传入口；Skill 详情抽屉；用户详情 Skills Tab；private skill 上传/删除/禁用入口；冲突、凭证、执行记录状态展示。 |
| **非范围（Out of Scope）** | 在线编辑脚本；公共 skill Git 发布流水线；复杂审批流页面；跨业务线 RBAC；Marketplace。 |
| **有意妥协 / 技术债** | 首版只支持用户维度 private skill 和 allow_override/disable 策略；Pod/业务线级策略后续扩展。 |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|
| S-01 | FEAT-01 | P0 | 管理员点击左侧“Skill 管理” | 页面展示 Skill 表格、左上角操作、右上角搜索/过滤、底部分页 |
| S-01A | FEAT-01A | P0 | 管理员上传合法 public skill bundle | Modal 关闭，Toast 成功，全局 Skill 列表刷新并出现 public skill |
| S-02 | FEAT-02 | P0 | 在 Skill 表格点击“详情” | 抽屉展示名称、scope、版本、依赖平台、progress/browser 标记 |
| S-03 | FEAT-03 | P0 | 打开 Human User 详情并切到 Skills Tab | 展示该用户最终生效 Skill 列表和 private/public 合并结果 |
| S-04 | FEAT-04 | P0 | 用户存在同名 private/public skill | Skills Tab 标记 conflict，并说明默认 public 生效或覆盖审批状态 |
| S-05 | FEAT-05 | P0 | skill 依赖 XDR 但用户未配置 XDR key | 该平台凭证状态显示缺失，行状态为 warning |
| S-06 | FEAT-06 | P1 | 上传合法 private skill bundle | Modal 关闭，列表刷新，Toast 成功，用户 skill 视图出现新 skill |
| S-07 | FEAT-07 | P1 | 查看某 skill 最近执行 | 显示状态、耗时、阶段数、失败摘要 |

**异常场景**

| 场景ID | 功能ID | 触发条件 | UI 表现 |
|--------|--------|---------|---------|
| E-01 | FEAT-01 | `/skills` 接口失败 | 页面显示错误提示和重试按钮，不出现空白表格 |
| E-02 | FEAT-06 | 上传包非法或重名冲突 | Modal 内显示后端错误，不关闭弹窗 |
| E-03 | FEAT-06 | 删除 private skill 失败 | Toast 错误，列表保持原状态 |
| E-04 | FEAT-03 | 用户 skill 视图为空 | 显示空态，说明该用户没有可用 Skill 或等待扫描 |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 表格交互响应 | 待定；不做前端本地大列表过滤，使用服务端分页 | 组件测试 + 实测 |
| NFR-A11Y-01 | 关键按钮可访问性 | icon-only 按钮有 `aria-label` | RTL 测试 |

---

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React | 18 | 沿用现有 Console |
| 状态管理 | 局部 state + 自定义 hook | 当前项目约定 | 页面状态不需要全局 store |
| 路由 | AppShell 条件渲染 | 现有结构 | 当前无路由库，新增 `skills` page key |
| 样式方案 | CSS Modules + Semi Design | 当前项目约定 | 与已重构的列表/弹窗风格一致 |
| 数据请求 | `src/api.ts` 封装 | 当前项目约定 | 禁止页面裸 fetch，统一 auth/envelope 处理 |

### 3.2 页面与路由结构

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| Skill 管理 | AppShell page key: `skills` | `PageHeader` + `PageSection` + Semi Table | 一级菜单，位于“用户管理”和“模型配置”之间或之后 |
| Human User 详情 - Skills Tab | 复用详情 Modal | Tab 内容 | 用户维度最终生效 skill 视图 |
| Skill 详情抽屉 | 页面内 Drawer/Modal | 右侧详情 | 展示 manifest 摘要、冲突、依赖、执行摘要 |
| Public Skill 上传弹窗 | Modal | Upload | 全局 Skill 管理页入口，skill 名称由 bundle 内 manifest 或目录名提取 |
| Private Skill 上传弹窗 | Modal | 表单 + Upload | 仅 Human User 维度入口 |

AppShell 调整：

```ts
type Page = "pods" | "users" | "skills" | "llm" | "settings" | "audit";
```

`normalizePage`、`NAV_ITEMS`、`PageContent` 同步新增 `skills`。

### 3.3 组件设计

**组件树**

```text
<SkillsPage>                         # 容器：列表查询、过滤、详情状态
├─ <PageHeader>
├─ <PageSection>
│  ├─ <ListToolbar>                  # actions 左、filters 右
│  │  ├─ <Button>扫描 Skill
│  │  └─ <Input/Search + Select filters>
│  └─ <SkillAssetTable>              # 展示组件，Semi Table
└─ <SkillDetailDrawer>               # 详情抽屉

<HumanUserDetailDialog>
└─ <HumanUserSkillsTab>              # 容器：查询用户 effective skills
   ├─ <ListToolbar>
   ├─ <EffectiveSkillTable>
   ├─ <PrivateSkillUploadDialog>
   └─ <SkillExecutionDrawer>
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | `Skills` | 容器 | 新增 `src/pages/Skills.tsx` | 全局 Skill 管理页面 |
| CMP-02 | `useSkillAssets` | hook | 新增 `src/pages/skills/` | 列表查询、过滤、分页、刷新 |
| CMP-03 | `SkillAssetTable` | 展示 | 新增 | 渲染全局 Skill 表格 |
| CMP-04 | `SkillDetailDrawer` | 展示/轻容器 | 新增 | 展示详情和最近执行摘要 |
| CMP-05 | `HumanUserSkillsTab` | 容器 | 新增 `components/human-users/` | 用户最终生效 Skill 视图 |
| CMP-06 | `EffectiveSkillTable` | 展示 | 新增 | 展示 source/conflict/credential/lastExecution |
| CMP-07 | `PrivateSkillUploadDialog` | 容器 | 新增 | 上传 private skill bundle |
| CMP-08 | `SkillExecutionTable` | 展示 | 新增 | 执行记录列表，可在全局/用户视图复用 |

### 3.4 组件接口契约

**CMP-03 `SkillAssetTable`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `items` | `SkillAsset[]` | 是 |  | 表格数据 |
| `loading` | `boolean` | 是 |  | Semi Table loading |
| `pagination` | `TablePaginationProps` | 是 |  | 来自 `tablePagination` |
| `onDetail` | `(skill: SkillAsset) => void` | 是 |  | 打开详情 |
| `onDisable` | `(skill: SkillAsset) => void` | 否 |  | 禁用入口 |

**CMP-05 `HumanUserSkillsTab`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `humanUser` | `HumanUser` | 是 |  | 当前用户 |
| `onChanged` | `() => void` | 否 |  | 安装/删除后刷新外层详情 |

**CMP-07 `PrivateSkillUploadDialog`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| `humanUserId` | `string` | 是 |  | 上传目标 |
| `open` | `boolean` | 是 |  | 显示状态 |
| `onClose` | `() => void` | 是 |  | 关闭 |
| `onUploaded` | `() => void` | 是 |  | 成功后刷新 |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onUploaded` | none | API 成功且 Toast 成功后 |
| `onClose` | none | 关闭按钮或取消 |

组件内禁止直接修改传入对象，更新通过回调上抛。

### 3.5 状态与数据流

**状态划分**

| 状态 | 作用域 | 形状 | 读写方 |
|------|--------|------|--------|
| Skill 列表查询 | `Skills` local | `{page,pageSize,q,scope,status}` | ListToolbar、Pagination |
| Skill 列表数据 | `useSkillAssets` local | `PageResult<SkillAsset>` | Table |
| Skill 详情 | `Skills` local | `SkillAsset | null` | DetailDrawer |
| 用户生效 Skill | `HumanUserSkillsTab` local | `ListResult<EffectiveSkill>` | EffectiveSkillTable |
| 上传弹窗 | `HumanUserSkillsTab` local | `open/busy/error/file` | UploadDialog |
| 执行记录 | `SkillExecutionTable` local | `PageResult<SkillExecution>` | Drawer/Table |

**数据流**

```text
用户操作 → 事件处理 → api.ts 方法 → Go API → setState → Semi Table/Modal 重渲染
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `api.listSkills(query)` | `GET /api/v1/skills` | `useSkillAssets` |
| `api.getSkill(skillId)` | `GET /api/v1/skills/{skillId}` | `SkillDetailDrawer` |
| `api.scanSkills(input)` | `POST /api/v1/skills/scan` | `Skills` |
| `api.updateSkill(skillId,input)` | `PATCH /api/v1/skills/{skillId}` | `Skills/SkillDetailDrawer` |
| `api.listHumanUserSkills(humanUserId, query)` | `GET /api/v1/human-users/{id}/skills` | `HumanUserSkillsTab` |
| `api.uploadPrivateSkill(humanUserId, formData)` | `POST /api/v1/human-users/{id}/skills/private` | `PrivateSkillUploadDialog` |
| `api.deletePrivateSkill(humanUserId, skillId)` | `DELETE /api/v1/human-users/{id}/skills/private/{skillId}` | `HumanUserSkillsTab` |
| `api.listSkillExecutions(query)` | `GET /api/v1/skill-executions` | `SkillExecutionTable` |

`uploadPrivateSkill` 是唯一 multipart 请求。实现时仍放在 `api.ts`，但不能强制 `Content-Type: application/json`，需要为 multipart 增加专用 request helper。

### 3.6 UI 状态

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 全局 Skill 列表 | Semi Table loading | Empty：暂无 Skill，提示扫描 | FeedbackBanner/Toast + 重试 | 表格 + 分页 |
| Skill 详情 | Drawer skeleton | 不适用 | Drawer 内错误提示 | manifest/依赖/执行摘要 |
| Human User Skills Tab | Table loading | Empty：该用户暂无可用 Skill | Tab 内错误 + 重试 | 生效列表 |
| 上传 private skill | Button loading | 不适用 | Modal 内字段错误 | Toast 成功 + 刷新 |
| 删除 private skill | Button loading | 不适用 | Toast 错误 | Toast 成功 + 刷新 |
| 执行记录 | Table loading | Empty：暂无执行记录 | 错误提示 + 重试 | 表格 |

### 3.7 样式方案

| 维度 | 约定 |
|------|------|
| **样式与逻辑分离** | 页面样式走 `Skills.module.css`；通用表格尽量使用 Semi Table 属性和现有 `ConsolePage` 封装 |
| **设计 tokens** | 使用现有 CSS variables 和 Semi 主题，不新增单页面魔法色 |
| **列表工具栏** | 全局列表和用户 Tab 均使用 `ListToolbar`：左侧操作，右侧搜索/过滤 |
| **分页** | 服务端分页表格统一使用 `tablePagination` + `renderTablePagination`，默认 10，选项 10/20/50/100 |
| **弹窗** | 上传/删除确认使用现有 Modal/Semi Modal 模式，禁止原生 confirm/alert |

### 3.8 可访问性与兼容性

| 维度 | 要求 |
|------|------|
| 可访问性 | icon-only 按钮必须有 `aria-label`；冲突和缺凭证不能只靠颜色表达，需要 Tag 文案 |
| 键盘操作 | Drawer/Modal 支持 Esc 关闭，上传按钮可聚焦 |
| 浏览器/设备兼容 | 以现有 Vite/React 支持范围为准；窄屏表格允许横向滚动 |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 |
|--------|------|------|------|
| RISK-01 | Skill 管理页面与用户详情 Tab 信息重复 | 用户困惑 | 全局页回答“平台有什么”，用户 Tab 回答“该用户能用什么” |
| RISK-02 | upload multipart helper 破坏现有 JSON request | API 回归 | 新增专用 helper，不修改现有 `request<T>` 行为 |
| RISK-03 | 表格列过多 | 可读性下降 | 默认显示核心列，详情放 Drawer，执行记录单独区域 |
| RISK-04 | 后端执行记录还未上报 | 页面空态 | Execution 区域 P1，可空态展示，不阻塞 P0 |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| Skill Asset | 平台记录的 skill 元数据 |
| Effective Skill | 某个 Human User 最终可见/可执行的 skill |
| Scope | system/public/private |
| Conflict | private 与 public/system 重名但平台规则不允许覆盖 |
| Credential Status | skill 依赖平台在该用户侧的凭证状态 |

---

*文档结束*

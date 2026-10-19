# 前台会话终止（Console 前端）需求与设计简报

> **文档编号**: FE-SESSION-CANCEL-001
> **文档版本**: v0.1
> **创建日期**: 2026-10-17
> **文档状态**: 设计评审中

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: US（来自需求描述）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
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
| v0.1 | 2026-10-17 | Claude | 初始草稿 |

---

## 2. 需求分析

### 2.1 需求概述

| 项目 | 内容 |
|------|------|
| **模块名称** | 前台会话终止（Console 前端） |
| **需求类型** | 交互新增（既有用户详情页扩展） |
| **业务背景** | 用户在企微里被长流程任务卡住时，管理员需要能在 Console 里先看清"将中止什么、将杀掉什么"，再二次确认执行 |
| **核心目标** | 在用户详情的 identity 行提供"终止任务"操作；弹窗展示实时预览（活跃 run + 进程清单），确认后逐项展示终止结果 |

### 2.2 功能方案

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-01 | Identity 行操作 | 每个 identity 行增加"终止任务"按钮；点击打开预览弹窗 | P0 | US-01 |
| FEAT-02 | 预览弹窗 | 展示 sessionKey、活跃 run 状态、候选进程表（PID/PGID/组长/运行时长/命令）；无任务时为空态并禁用确认 | P0 | US-02 |
| FEAT-03 | 二次确认 | 确认按钮为危险样式，文案明确"将中止 run 并结束 N 个进程"；确认后调用 cancel 并携带指纹 | P0 | US-02 |
| FEAT-04 | 结果展示 | 逐进程显示 `terminated`/`killed`/`skipped` 及原因；汇总 `killed`/`remaining`；成功后 Toast | P0 | US-02 |
| FEAT-05 | 异常与降级 | 41007 不支持、41008 不存在、41009 列表已变化、41010 失败分别有明确文案与重试/重新预览动作 | P1 | US-03 |
| FEAT-06 | i18n 与可访问性 | 所有文案走 i18n（zh/en）；弹窗键盘可达、焦点管理、按钮 aria-label | P1 | US-04 |

### 2.3 范围与边界

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | `IdentityManager` 行操作；`SessionCancelDialog` 容器与展示组件；`api.ts` 方法；`types/api.ts` 类型；i18n；vitest |
| **非范围（Out of Scope）** | 批量终止多个 identity；运行中会话的全局列表页；进程详情实时刷新（可手动重新预览）；企微插件补丁；长任务页面（已存在） |
| **有意妥协 / 技术债** | 弹窗打开时只拉一次预览，不做自动轮询；确认时若列表变化，返回 41009 后由用户手动重新预览；暂不展示进程完整命令行（截断 200 字符） |

### 2.4 验收条件

**正常场景**

| 场景ID | 功能ID | 优先级 | 测试层级 | 关键真实边界 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|---------|-------------|
| S-07 | FEAT-01/02 | P0 | E2E | 用户详情 → API → 真实 Worker | 打开用户详情 → identity 行点"终止任务" | 弹窗打开，显示 sessionKey、活跃 run 与进程表；确认按钮可用 |
| S-08 | FEAT-03/04 | P0 | E2E | 弹窗 → API → Worker 信号 → UI | 点击确认 | 显示逐进程结果与汇总；Toast"已终止"；弹窗可关闭 |
| S-09 | FEAT-02 | P0 | integration | API mock → UI | 预览返回空集合 | 显示空态"没有正在运行的任务或后台进程"，确认禁用 |
| S-10 | FEAT-04 | P1 | integration | API mock → UI | 部分进程 skipped | 结果表标出 skipped 及原因；汇总 remaining > 0，不显示全成功 |

**异常场景**

| 场景ID | 功能ID | 测试层级 | 关键真实边界 | 触发条件 | UI 表现 |
|--------|--------|---------|-------------|---------|---------|
| E-07 | FEAT-05 | integration | API mock | 41007 能力不支持 | 弹窗内错误提示"当前 Worker 不支持会话终止"，确认禁用 |
| E-08 | FEAT-05 | integration | API mock | 41009 列表已变化 | 提示"进程列表已变化，请重新预览"，提供"重新预览"按钮 |
| E-09 | FEAT-05 | integration | API mock | 41008/41010 | 错误 Banner + 关闭/重试；不显示成功状态 |
| E-10 | FEAT-03 | integration | UI | 确认按钮连点 | 按钮 loading，禁止重复提交 |
| E-11 | FEAT-01 | integration | API mock | 预览请求失败 | 弹窗显示错误与重试，不显示空态为"无任务" |

**边界场景**

| 场景ID | 测试层级 | 关键真实边界 | 字段/条件 | 边界值 | 预期行为 |
|--------|---------|-------------|----------|--------|---------|
| B-06 | unit | 展示组件 | cmdline 超长 | >200 字符 | 截断 + Tooltip 显示截断值（不展开原文） |
| B-07 | unit | 展示组件 | 进程数为 0、run 为 active | — | 确认按钮可用（只中止 run） |
| B-08 | unit | 展示组件 | skipped 计数非零 | — | 显示"已跳过 N 个非目标进程" |

**非功能指标**

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-PERF-01 | 弹窗打开到预览渲染 | ≤1.5s（P95，依赖后端 ≤1s） | 实测 |
| NFR-A11Y-01 | 键盘可达 | Tab 可聚焦所有操作，Esc 关闭 | 手动 + 组件测试 |

---

## 3. 前端技术设计

### 3.1 技术选型

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React | 现有版本 | 项目现状 |
| 状态管理 | 组件局部 state | — | 单弹窗交互，无全局状态 |
| 路由 | 无新增 | — | 复用用户详情弹窗 |
| 样式方案 | CSS Modules | — | 项目现状 |
| 数据请求 | `src/api.ts` 统一封装 | — | 规范要求，禁止裸 fetch |

### 3.2 页面与路由结构

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| 用户管理 | 现有 `Users` 页 | 现有布局 | 在 `HumanUserDetailDialog` → `IdentityManager` 的 identity 行增加操作 |

无新增页面与路由。

### 3.3 组件设计

**组件树**

```
<IdentityManager>                 # 容器（现有）：身份列表 + 操作
├─ <Table>                        # 展示（现有）
│  └─ 行操作「终止任务」           # 新增按钮，事件上抛
└─ <SessionCancelDialog>          # 容器（新增）：调用 preview/cancel，管理状态
   ├─ <SessionSummary>            # 展示：sessionKey、run 状态
   ├─ <ProcessPreviewTable>       # 展示：进程表 + 指纹/组长标记
   └─ <SessionCancelResult>       # 展示：逐进程结果与汇总
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | `SessionCancelDialog` | 容器 | 新建 | 打开时 preview；确认时 cancel；管理 loading/error/result |
| CMP-02 | `ProcessPreviewTable` | 展示 | 新建 | 渲染进程列表与警告条；纯 props |
| CMP-03 | `SessionCancelResult` | 展示 | 新建 | 渲染逐进程结果与汇总 |
| CMP-04 | Identity 行操作 | 展示 | 现有 `IdentityManager` 扩展 | 触发弹窗 |

### 3.4 组件接口契约

**CMP-01 `SessionCancelDialog`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| visible | boolean | 是 | false | 弹窗可见性 |
| humanUserId | string | 是 | — | 归属 |
| identity | Identity | 是 | — | 目标身份（含 channel/peerKind/externalId） |
| onClose | () => void | 是 | — | 关闭回调 |
| onCancelled | () => void | 否 | — | 成功终止后回调（用于提示/刷新） |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onClose` | — | 点击取消/关闭/成功后 |
| `onCancelled` | — | cancel 返回 killed>0 或 confirmed=true |

**CMP-02 `ProcessPreviewTable`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| processes | SessionCancelProcess[] | 是 | — | 候选进程 |
| skipped | SessionCancelSkipped | 是 | — | 跳过计数 |

**CMP-03 `SessionCancelResult`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| result | SessionCancelResultData | 是 | — | aborted/drained/killed/remaining/processes |

组件内禁止直接修改 props，全部通过回调上抛。

### 3.5 状态与数据流

**状态划分**

| 状态 | 作用域（local / shared store） | 形状（shape） | 读写方 |
|------|------------------------------|--------------|--------|
| preview | local（dialog） | `{loading, error?, data?}` | dialog |
| cancel | local（dialog） | `{busy, error?, result?}` | dialog |
| visible/identity | local（IdentityManager） | `{visible, identity?}` | IdentityManager |

**数据流**

```
行操作点击 → setVisible(identity) → dialog 打开 → api.previewSessionCancel()
→ 渲染预览 → 管理员确认 → api.cancelSession({expected}) → 渲染结果 → Toast
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `previewSessionCancel(humanUserId, identityId)` | `POST /human-users/{id}/identities/{identityId}/session/preview` | `SessionCancelDialog` |
| `cancelSession(humanUserId, identityId, expected)` | `POST /human-users/{id}/identities/{identityId}/session/cancel` | `SessionCancelDialog` |

**类型（`src/types/api.ts`）**

```ts
export interface SessionCancelProcess {
  pid: number;
  pgid: number;
  startTime: number;
  uid: number;
  leader: boolean;
  ageSeconds: number;
  cmdline: string;
  fingerprint: string;
}

export interface SessionCancelSkipped {
  notOwner: number;
  envMismatch: number;
  permissionDenied: number;
}

export interface SessionCancelPreview {
  sessionKey: string;
  agentId: string;
  activeRun: { active: boolean; sessionId?: string };
  processes: SessionCancelProcess[];
  skipped: SessionCancelSkipped;
}

export interface SessionCancelExpected {
  pid: number;
  fingerprint: string;
}

export interface SessionCancelProcessResult {
  pid: number;
  outcome: "terminated" | "killed" | "skipped";
  reason?: string;
}

export interface SessionCancelResultData {
  aborted: boolean;
  drained: boolean;
  confirmed: boolean;
  killed: number;
  remaining: number[];
  processes: SessionCancelProcessResult[];
}
```

### 3.6 UI 状态

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 预览弹窗 | Spin + "正在读取运行状态" | "没有正在运行的任务或后台进程"，确认禁用 | Banner + 重试；41007 显示不支持 | 摘要 + 进程表 + 危险确认按钮 |
| 确认动作 | 确认按钮 loading，禁止重复 | — | 41009 提示重新预览；41008/41010 错误 Banner | 结果表 + Toast |
| 行操作 | 按钮禁用（弹窗打开时） | — | — | — |

### 3.7 样式方案

| 维度 | 约定 |
|------|------|
| 样式与逻辑分离 | 新样式放 `SessionCancelDialog.module.css`；组件不内联大量样式 |
| 设计 tokens | 复用现有 Semi 主题变量与 `HumanUsersPanel.module.css` 的间距/字号 |
| 危险操作 | 确认按钮使用 Semi `type="danger"`；警告条使用现有警示色 token |
| 响应式 | 弹窗宽度自适应，进程表横向滚动；窄屏隐藏"启动时长"列 |

### 3.8 可访问性与兼容性

| 维度 | 要求 |
|------|------|
| 可访问性 | 弹窗打开后焦点进入标题；Esc 关闭；确认按钮 `aria-label` 含进程数；进程表 `rowKey=pid` |
| 浏览器兼容 | 与现有 Console 支持范围一致（Chrome/Edge 最新两个大版本） |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 | 验证场景 |
|--------|------|------|------|---------|
| RISK-FE-01 | 预览与确认之间进程变化 | 管理员确认的清单与实际不一致 | 只提交预览中的指纹；41009 时要求重新预览 | E-08 |
| RISK-FE-02 | 进程列表过长导致弹窗溢出 | 可读性差 | 表格限高 + 滚动；显示总数 | B-06 |
| RISK-FE-03 | 误把"跳过数"当成失败 | 误判 | 明确区分 skipped（非目标进程）与 failure | B-08 |

---

## Spec Compliance Matrix

| Spec/Rule | enforcement | 设计影响 | 设计落点 | 验证场景 | 状态/N/A 理由 |
|-----------|-------------|---------|---------|---------|----------------|
| `frontend-component-specs#RULE-frontend-component-001` | required | Props 强类型、展示组件无网络 IO、稳定 key | §3.3 组件树；§3.4 契约（`rowKey=pid`） | S-09, B-07 | applied |
| `frontend-component-specs#RULE-frontend-semi-shell-001` | required | 使用 Semi Modal/Table/Button/Tag/Toast | §3.1、§3.7 | S-07 | applied |
| `frontend-directory-structure#RULE-frontend-directory-001` | required | HTTP 只走 `src/api.ts` | §3.5 数据获取层 | S-07, E-09 | applied |
| `frontend-directory-structure#RULE-frontend-api-types-001` | required | 共享类型放 `src/types/api.ts` 并由 `api.ts` re-export | §3.5 类型定义 | S-07 | applied |
| `frontend-quality-standards#RULE-frontend-quality-001` | required | strict TS、三态处理、vitest | §3.6 UI 状态；§3.4 类型 | S-08, E-07, E-08 | applied |
| `frontend-quality-standards#RULE-frontend-api-client-001` | required | 统一 `api.ts`、`/api/v1`、`code===0` 解包 | §3.5 Service 方法 | S-07, E-09 | applied |
| `frontend-quality-standards#RULE-frontend-i18n-001` | required | 所有文案走 i18n；组件内 `useTranslation` | §2.2 FEAT-06；§3.7 | S-07, E-07 | applied |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| US / FEAT / NFR | 用户故事 / 功能项 / 非功能需求 |
| CMP | Component，组件 |
| 容器组件 | 负责数据获取与状态的组件 |
| 展示组件 | 纯 UI、props 驱动、事件上抛的组件 |
| fingerprint | 预览返回的进程指纹，确认时原样回传 |

---

*文档结束*

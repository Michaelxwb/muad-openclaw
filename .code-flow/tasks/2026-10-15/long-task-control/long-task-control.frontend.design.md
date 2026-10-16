# 长任务列表取消与终止：前端设计

> 文档编号：FE-LONG-TASK-CONTROL-1.0
> 版本：v1.0
> 创建日期：2026-10-15
> 状态：已批准，待实现

## 1. 文档控制

产品取舍来源为用户本次回复：优先保留唯一 Skill 自动执行、多个候选选择；先做控制台终止入口；失败任务不增加重试按钮。后端、运行时和共享 API 契约见同目录后端设计，场景 ID 在整个需求目录内唯一。

2026-10-15 用户审阅两份草稿后回复“定稿，开始拆分任务”，本设计据此批准。该确认不替代组件测试或真实浏览器终验。

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-10-15 | 记录列表操作、状态、异常反馈与真实浏览器验收 |
| v1.0 | 2026-10-15 | 用户确认定稿，进入任务拆解 |

## 2. 需求分析

### 2.1 需求概述

在现有长任务列表增加任务级操作，让管理员及时停止误下发的任务，同时明确区分“取消请求已接受”和“任务实际已停止”。沿用现有管理台布局、Semi、分页过滤和后台刷新。

### 2.2 功能方案

| 功能 | 交互 | 优先级 | 来源 |
|---|---|---|---|
| FEAT-03 | queued 行显示“取消排队”，请求成功后刷新任务状态及队列数 | P0 | 用户本轮第 2 项、后端 FEAT-03 |
| FEAT-04 | running 行显示“终止任务”，一次简短确认后发起终止 | P0 | 用户本轮第 2 项、后端 FEAT-04 |
| FEAT-05 | cancelling 展示“终止中”，真实取消完成后显示“已取消”；保留历史 | P0 | 后端 FEAT-05 |
| FEAT-06 | 展示能力缺失/调用错误；失败及其他终态没有重试操作 | P0 | 用户本轮第 2 项、后端 FEAT-06 |

### 2.3 范围与边界

首期只修改现有长任务页和公共 API/类型/i18n，入口沿用当前控制台权限。任务重试、批量终止、IM 操作入口和新增页面不在范围内。终止请求失败展示错误，状态由服务端刷新；没有专用重试按钮，也不会重新提交业务任务。参考 Skill 与自动匹配交互继续由既有 Agent/IM 完成，不在控制台新增执行前确认。

### 2.4 验收条件

| 场景 | 功能 | 层级 | 关键真实边界及断言 |
|---|---|---|---|
| S-05 | FEAT-03 | E2E | 复用后端 S-05：真实浏览器点击排队取消，经 Console/Worker/Store 收敛 cancelled；任务零业务执行 |
| S-06 | FEAT-04/05 | E2E | 复用后端 S-06：真实浏览器确认终止，展示终止中，再展示已取消；进程、进度、投递与列表状态一致 |
| S-09 | FEAT-03/04/05/06 | integration | Testing Library、真实 hook 与 API 封装、HTTP 边界 stub：仅可取消 queued/running 有操作，cancelling 不可重复点击；succeeded/failed/cancelled 无重试按钮；关闭终止确认框不发请求 |
| S-10 | FEAT-05/06 | E2E | 真实浏览器、后端及 Worker：中英文切换后按钮/状态/错误/确认文案正确，按取消状态筛选、分页和正常后台轮询不闪表格 spinner |
| E-05 | FEAT-04/06 | E2E | 实际 Worker 不可达或不支持取消，UI 显示明确原因而非成功；刷新不覆盖较新操作状态；权限失效回登录；不出现任务重试按钮 |
| B-01/02/03 | FEAT-05/06 | integration | 复用后端场景的 UI 断言：已结束响应使用实际终态；重复点击单次在途请求；旧轮询响应不得把已取消回退 running |

正常/异常覆盖由 S-05/06/09/10、E-05 及后端 E-01/02/03 提供。组件交互测试不能替代端到端运行停止证明。

## 3. 前端技术设计

### 3.1 技术选型

沿用 React 18、TypeScript strict、Semi Design、CSS Modules、现有 api.ts、i18next 和 Vitest/Testing Library。沿用 main.tsx 的 ConfigProvider，不在页面重新包装主题或语言壳。不新增状态库或路由依赖。

### 3.2 页面与路由结构

保留 `pages/LongTasks.tsx` 入口及 App 中已有页面切换。仅单页复用的动作逻辑/组件放 `pages/long-tasks/`；公共请求与契约位于 `src/api.ts`、`src/types/api.ts`。为控制文件职责可抽取列表 hook/操作单元，不扩展为全站重构。

### 3.3 组件设计

```text
LongTasks（列表数据、操作状态和反馈）
├─ LongTaskToolbar（现有筛选，增加取消相关状态）
└─ LongTaskTable（稳定 taskId 行键）
   └─ LongTaskActions（纯展示、确认和上抛动作）
```

CMP-01 LongTaskActions 根据 task.status、canCancel、busy 渲染，使用 Semi Button/Popconfirm，纯 props/events，不直接发 HTTP。CMP-02 useLongTaskActions 负责任务级在途状态、错误/成功反馈、统一 API 调用及触发刷新。

### 3.4 组件接口契约

| CMP-01 Prop | 类型 | 约束 |
|---|---|---|
| task | `LongTask` | 由公共 DTO 定义，状态含 cancelling/cancelled |
| busy | `boolean` | 只禁用对应任务操作，不锁整张表 |
| onCancel | `(taskId: string) => void` | 排队取消或运行终止确认后上抛 |

CMP-02 接收成功后后台刷新回调；提供 `busyTaskIds: ReadonlySet<string>`、`cancel(taskId): Promise<void>`、error/message。不得修改传入 task。公共 `LongTaskCancelResult` 与可操作能力字段只在 types/api.ts 定义，由 api.ts re-export，不复制 DTO。

### 3.5 状态与数据流

#### API-FLOW：统一请求与可信结果

新增 `api.cancelLongTask(taskId)` 对应后端 API-01。路径、`/api/v1`、认证头、Accept-Language、code===0 解包及 ApiError 都由 api.ts 处理；401 沿用 clear token + UNAUTHORIZED_EVENT。

操作使用 busy → try/catch/finally → setErr/setMsg。返回 cancel_requested 时显示“终止请求已接受”，以 cancelling 保留轮询；收到 cancelled 才显示“已取消”；already_terminal 展示实际任务状态，不把结束改写成已取消。超时不推断失败终态或自动重提业务任务，执行一次状态刷新以呈现 Worker 实际状态。

#### REFRESH-FLOW：刷新、幂等与竞争

保留现有 5 秒后台刷新，cancelling 视为活跃任务，即使当前过滤页没有 running 行仍持续收敛。后台刷新不设 loading=true。取消请求开始后使旧列表请求失效，按 task revision 或最新请求序号合并；组件卸载通过 useMountedRef 防止写状态。单个 taskId 在途禁止重复调用，不通过全表 loading 阻断其他任务操作。

能力来自后端按 Worker 实际版本提供的 canCancel/cancelUnavailableReason，前端不拼 Pod 地址、不接受用户输入 PID/session。已知不支持时显示禁用操作和原因；能力过期时依靠服务端最终校验及稳定错误反馈。

### 3.6 UI 状态

| 状态 | 操作与反馈 |
|---|---|
| queued + canCancel | “取消排队”，直接提交；该行请求期间按钮 loading |
| running + canCancel | “终止任务”；确认文案列出 Skill 与任务 ID，说明已完成的外部操作不会撤回 |
| cancelling | “终止中”，不可重复点击；继续后台刷新，未确认停止不显示已取消 |
| cancelled | “已取消”，显示终止时间和摘要；没有操作按钮 |
| succeeded / failed | 保留当前结果展示；没有取消或重试按钮 |
| 能力不支持/未知 | 不提供可点击终止入口，明确提示需升级或暂不可用 |
| 操作请求错误 | errorMessage 展示可读原因，技术 detail 经 ErrorDetail 折叠；没有新增重试按钮 |
| 首载/空列表 | 保留已有首载 loading 与 Empty；后台刷新保留现有行，无全表闪烁 |
| 操作成功 | 根据真实 outcome/status 展示反馈，并刷新列表与池计数 |

请求失败后，仍为 running 且 canCancel 的任务可按当前状态显示原“终止任务”入口；这是同一取消操作的幂等入口，不创建任务重试行为。

### 3.7 样式方案

新增操作列沿用现有表格与 Semi 小尺寸按钮，样式放 CSS Modules、颜色和间距沿用主题 token。不向业务 UI 展示 Gateway 方法、PID、脚本进程等实现细节。增加列后维持现有横向滚动，小屏不压缩任务 ID 或隐藏关键操作。

### 3.8 可访问性与国际化

所有按钮、状态、确认、反馈及不可用原因都有中英文 i18n key；依赖 t 的列配置保留 useMemo。操作有可读标签和键盘焦点；确认取消返回原操作焦点；busy/disabled 与可见文本一致。全局主题和 Semi locale 继续由既有壳配置。

## 4. 风险与依赖

| 风险 | 应对 | 场景 |
|---|---|---|
| RISK-F01：请求成功被误当成已经停止 | cancel_requested 与 cancelled 分开文案和状态 | S-06/09、E-05 |
| RISK-F02：旧轮询覆盖操作结果 | revision/请求序号及在途控制，后台刷新不闪表 | S-10、B-03 |
| RISK-F03：旧 Worker 显示无效按钮 | 服务端能力及错误契约，未知能力不推断支持 | E-05 |
| RISK-F04：失败任务出现业务重试入口 | 终态无操作，无任务 retry API；区分终止调用错误与任务失败 | S-09、E-05 |

## Spec Compliance Matrix

| Spec/Rule | enforcement | 具体设计落点 | 验证场景/verifier | 状态 |
|---|---|---|---|---|
| frontend-component-specs#RULE-frontend-component-001 | required | §3.3/3.4/3.7：typed props、纯展示、稳定 taskId、Semi/CSS Modules | S-09；原规范 verifier | 设计已确认，待实施验证 |
| frontend-component-specs#RULE-frontend-semi-shell-001 | required | §3.1/3.8：沿用 ConfigProvider 与主题/语言壳 | S-09/10；原规范 verifier | 设计已确认，待实施验证 |
| frontend-directory-structure#RULE-frontend-directory-001 | required | §3.2、API-FLOW：src 目录及 api.ts 唯一 HTTP 边界 | S-09；原规范 verifier | 设计已确认，待实施验证 |
| frontend-directory-structure#RULE-frontend-api-types-001 | required | §3.4：types/api.ts 唯一契约、api.ts re-export | S-09；原规范 verifier | 设计已确认，待实施验证 |
| frontend-quality-standards#RULE-frontend-quality-001 | required | §3.1/3.5/3.6：strict、异步状态、卸载保护、tsc/eslint/prettier/vitest | S-09、E-05；原规范 verifier | 设计已确认，待实施验证 |
| frontend-quality-standards#RULE-frontend-api-client-001 | required | API-FLOW：认证、解包、ApiError、401 事件，无裸 fetch | S-09、E-05；原规范 regex | 设计已确认，待实施验证 |
| frontend-quality-standards#RULE-frontend-i18n-001 | required | §3.8：中英 key、t/useMemo、可读错误文案 | S-10、E-05；原规范 verifier | 设计已确认，待实施验证 |

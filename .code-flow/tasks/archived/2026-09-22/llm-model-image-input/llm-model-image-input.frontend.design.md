# LLM 模型图片输入能力 前端模块需求与设计简报

> **文档编号**: FE-LLMIMG-1.0
> **文档版本**: v0.1
> **创建日期**: 2026-09-22
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: FEAT（功能）、CMP（组件）、NFR（非功能指标）、DEC（设计决策）、RISK（风险）
场景编号：S-（正常）、E-（异常）、B-（边界）。**本需求为全栈双文档；后端占 `S-01..04` / `E-01..04`，前端占 `S-11..13` / `E-11..12` 以免合并时撞号**（本文件全部为 `1x` 段）。

> 本文档为**前端域**设计；后端 + Runtime 域见同目录 `llm-model-image-input.backend.design.md`

---

## 目录

- [1. 文档控制](#1-文档控制)
- [2. 需求分析](#2-需求分析)
- [3. 前端技术设计](#3-前端技术设计)
- [4. 风险与依赖](#4-风险与依赖)
- [Spec Compliance Matrix](#spec-compliance-matrix)
- [附录：术语表](#附录术语表)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 | | 技术方案、代码实现 |
| 设计/交互 | | 视觉与交互稿（如有） |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-09-22 | | 初始草稿（自会话对齐结论细化） |
| v0.2 | 2026-09-22 | | S-11 层级由 E2E 改为 integration（仓库无浏览器级 E2E 设施，经用户 2026-09-22 确认）；真实浏览器段改由 TASK-009 人工验收覆盖 |
| v0.3 | 2026-09-22 | | 补 S-14（能力文案中英渲染场景）：原 i18n 需求只有 NFR、缺可验收场景，导致 TASK-006 无法满足「每个 TASK 引用 S/E/B 场景」的验收契约 |

---

## 2. 需求分析

### 2.1 需求概述 [必填]

| 项目 | 内容 |
|------|------|
| **模块名称** | 模型管理（LLM）— 模型能力配置与展示 |
| **需求类型** | 交互优化（既有表单/列表扩展字段 + 分组重构） |
| **业务背景** | 后端新增模型的「支持图片输入」能力字段后，管理员需要一个入口来声明该能力。现有模型管理页已有「支持函数调用（工具）」checkbox 与「工具调用」列表列，其承载的信息本质是**同一个问题：这个模型具备哪些能力**。<br>会话对齐结论：不新增顶层字段，而是把既有「工具调用」升级为「模型能力」分组/列，内含两项独立能力。**数据层保持两个正交布尔不合并** —— 因为在 OpenClaw 中「工具调用」（`compat.supportsTools`）与「图片输入」（`input`）是两条独立轴，且两侧都有真实场景：内网 vLLM 文本模型支持工具但不支持图片；纯视觉模型支持图片但不支持工具。合并为单字段会丢失这两种组合的表达力，且两者默认值相反（工具默认开、图片默认关），合并后默认值自相矛盾。 |
| **核心目标** | 管理员可在模型管理页显式声明某模型是否支持图片输入，并在列表中一眼看清每个模型的能力组合；默认不勾选，保证与现状（text-only）行为一致 |

---

### 2.2 功能方案 [必填]

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-F01 | 列表「模型能力」列 | 原「工具调用」单值列升级为能力 Tag 列表列，展示 `工具调用` / `文本+图片` / `不支持` 的组合 | P0 | 对齐结论（会话） |
| FEAT-F02 | 对话框「模型能力」分组 | 新建与编辑对话框中原单个 checkbox 改为「模型能力」分组，内含 `工具调用`（沿用原值）与 `文本+图片`（新增，默认不勾）两项独立 checkbox | P0 | 对齐结论（会话） |
| FEAT-F03 | i18n 中英同步 | 新增分组/能力文案 key，并同步 `locales/zh.ts` 与 `locales/en.ts` | P0 | 对齐结论（会话） |

> 来源：本需求无 PRD，来源为会话中对齐结论。

---

### 2.3 范围与边界 [必填]

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | `pages/LLM.tsx` 列表列重构；`pages/llm/LLMCreateDialog.tsx` 与 `LLMEditDialog.tsx` 表单分组；`types/api.ts` 类型扩展；`i18n/locales/{zh,en}.ts` 文案；`test/LLM.test.tsx` 对应用例 |
| **非范围（Out of Scope）** | ① 不新增页面或路由；② 不改动 API 客户端封装（沿用 `api.createLLMModels` / `api.updateLLMModel`，无新 endpoint）；③ 不做按模型名/供应商的自动推断预填（后端文档 §2.3 非范围①）；④ 不合并 `thinking`（推理档位）到「模型能力」分组 —— 属既有 UI，本次未要求改动；⑤ 不改动 `ConfigProvider` / 主题壳 |
| **有意妥协 / 技术债** | 默认**不勾选**「文本+图片」：对不具备视觉能力的模型勾选会导致 provider 层报错，故选择「安全默认 + 文案提示」而非「默认放开」。代价是存量与新建模型都需要管理员显式开启才能获得图片能力（后端文档 RISK-B03） |

---

### 2.4 验收条件 [必填]

**正常场景**

| 场景ID | 功能ID | 优先级 | 测试层级 | 关键真实边界 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|---------|-------------|
| S-11 | FEAT-F02 | P0 | integration | Browser → 对话框 → 列表重渲染（`src/api` 为模块级替身；真实浏览器 + 真实 HTTP 段由 TASK-009 人工验收覆盖） | 1. 打开编辑模型对话框<br>2. 勾选「文本+图片」<br>3. 保存 | PATCH 请求体含 `supportsImages:true`；对话框关闭；列表该行「模型能力」列出现 `文本+图片` Tag |
| S-12 | FEAT-F01 | P0 | integration | 组件 → 渲染（真实 fixture 数据） | 1. 分别以四种能力组合的模型数据渲染列表 | ① 两者皆 true → 同列显示 `工具调用` 与 `文本+图片` 两个 Tag；② 仅工具 → 仅 `工具调用`；③ 仅图片 → 仅 `文本+图片`；④ 两者皆 false → 显示 `不支持` |
| S-13 | FEAT-F02 | P0 | unit | 对话框组件真实实现 | 1. 打开新建对话框<br>2. 打开编辑一个 `supportsImages:true` 的模型 | 新建时「文本+图片」**默认未勾选**、「工具调用」沿用既有默认勾选；编辑时两者回显与模型数据一致 |
| S-14 | FEAT-F03 | P0 | unit | 两份 locale 文件真实内容 | 1. 读取 zh 与 en 的「模型能力」相关文案 | 中英两份均提供 `capabilities` / `imageInput` / `imageInputAria`；zh 侧 `toolCalls`/`supportFunctionCalls` = `工具调用`、`imageInput` = `文本+图片`；en 侧为对应英文文案（`Capabilities` / `Text + image` / `Tool calls`），**不回落为 key 名** |

**异常场景**

| 场景ID | 功能ID | 测试层级 | 关键真实边界 | 触发条件 | UI 表现 |
|--------|--------|---------|-------------|---------|---------|
| E-11 | FEAT-F02 | integration | Service(`api.ts`) → UI | 保存时 PATCH 返回 `ApiError`（如 50019） | 对话框保持打开、`busy` 复位；经 `Toast` 展示本地化错误文案，技术细节进 `ErrorDetail`；勾选状态不丢失，可重试 |
| E-12 | FEAT-F02 | unit | 对话框组件真实实现（DOM 断言） | 用户点击「文本+图片」checkbox 一次 | `onChange` **只触发一次**（防回归：`Field` 若以 `<label>` 包裹 checkbox 会导致 label 激活与 input 事件双触发；断言 `closest("label") === null`） |

**非功能指标** [按需]

| 指标ID | 指标名称 | 目标值 | 测量方法 |
|--------|---------|-------|---------|
| NFR-I18N-F01 | 文案覆盖 | 新增可见文案在中英两份 locale 均存在，无硬编码 | `npm test`（i18n key 缺失断言）+ 代码审查 |
| NFR-A11Y-F01 | 可访问性 | 新 checkbox 具备语义 `aria-label`，键盘可聚焦切换 | 组件测试 + 手动键盘验证 |
| NFR-TEST-F01 | 既有断言同步 | 列宽断言随新增列宽更新后仍通过 | `vitest` 全绿 |

---

## 3. 前端技术设计

### 3.1 技术选型 [必填]

沿用既有栈，不引入新依赖。

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React + TypeScript（strict） | 既有 | 与 `console/frontend` 一致 |
| 状态管理 | 组件局部 state（`useState`） | 既有 | 与 `LLMCreateDialog` / `LLMEditDialog` 现状一致，无跨页共享需求 |
| 路由 | 既有（本次不新增路由） | 既有 | 无新页面 |
| 样式方案 | Semi Design 组件 + 既有 `Field` 布局助手 | 既有 | `@douyinfe/semi-ui` 为项目主组件库（`frontend-component-specs#RULE-frontend-semi-shell-001`） |
| 数据请求 | `src/api.ts` 统一封装 | 既有 | 禁止页面内裸 `fetch`（`frontend-directory-structure#RULE-frontend-directory-001`） |

---

### 3.2 页面与路由结构 [必填]

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| 模型管理 | 既有（无变化） | 既有页面布局 | 仅内部列与对话框内容变化，不新增页面或路由 |

---

### 3.3 组件设计 [必填]

**组件树**（容器/展示分离）

```
<LLM>                              # 页面容器：数据获取 + 列表编排 + 对话框编排
├─ <Table>                         # 既有：列表
│  └─ 「模型能力」列 render        # 改造：单值 Tag → 能力 Tag 列表
├─ <LLMCreateDialog>               # 既有：新建（容器，持有 draft state）
│  └─ <Field label="模型能力">     # 改造：分组
│     ├─ <Checkbox> 工具调用        # 沿用 supportsTools
│     └─ <Checkbox> 文本+图片       # 新增 supportsImages
└─ <LLMEditDialog>                 # 既有：编辑（容器，持有各字段 state）
   └─ <Field label="模型能力">     # 改造：同上
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-F01 | `LLM` 页「模型能力」列 render | 展示 | 改造既有 `LLM.tsx` 列定义 | 由 `supportsTools` / `supportsImages` 两布尔派生 Tag 列表；无网络 IO |
| CMP-F02 | `LLMCreateDialog` 模型能力分组 | 容器 | 改造既有 | 持有 `supportsTools` / `supportsImages` draft 状态并随批量 payload 提交 |
| CMP-F03 | `LLMEditDialog` 模型能力分组 | 容器 | 改造既有 | 回显并随 PATCH payload 提交两字段 |

> **分层纪律**：本次不新增组件文件，仅改造既有容器的局部结构；Tag 派生为纯展示逻辑（`supportsTools/supportsImages → ReactNode`），不引入网络调用。
>
> **不新增抽象的理由**：两处对话框的 checkbox 结构同构，但分属两个既有文件且各自持有独立 state；抽取共享组件会引入一层 props 透传而收益有限。本次按项目既有形态就地改造（对既有代码做最小改动）。

---

### 3.4 组件接口契约 [必填]

**CMP-F02 `LLMCreateDialog`** — draft 状态扩展

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `supportsTools` | boolean | 是 | `true` | 既有，不变 |
| `supportsImages` | boolean | 是 | **`false`** | 新增；默认不勾选（与后端默认一致） |

**CMP-F03 `LLMEditDialog`** — state 扩展

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `supportsImages` | boolean | 是 | 由模型数据回显 | 新增；`useState` 初值取 `model.supportsImages` |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onChange`（两处 checkbox） | `React.ChangeEvent<HTMLInputElement>` → `e.target.checked` | 用户切换勾选；仅更新所属对话框局部 state，不上抛、不即时提交 |

> 组件内**禁止直接修改 props**；提交经既有 `onOk`/保存回调上抛。checkbox 必须包裹在 `<Field as="div">` 中，**禁止被 `<label>` 包裹**（E-12 回归约束）。

---

### 3.5 状态与数据流 [必填]

**状态划分**

| 状态 | 作用域（local / shared store） | 形状（shape） | 读写方 |
|------|------------------------------|--------------|--------|
| `supportsImages`（新建） | local（`LLMCreateDialog` draft） | `boolean` | 读：checkbox `checked`；写：`onChange`、重置 |
| `supportsImages`（编辑） | local（`LLMEditDialog` useState） | `boolean` | 读：checkbox `checked`；写：`onChange`、打开模型时重置 |
| 模型列表 | local（`LLM` 页） | `LLMModelConfig[]` | 读：Table；写：加载/保存后刷新 |

**数据流**

```
用户勾选 checkbox → onChange → setDraft/setState(local)
                                    ↓ 点击保存
              api.createLLMModels / api.updateLLMModel（src/api.ts）
                                    ↓ code===0 解包 / 失败抛 ApiError
                    重新加载列表 → Table 重渲染「模型能力」列
```

**数据获取层**：沿用既有 `api.ts` 封装，**不新增 API 方法、不新增路径字符串**。

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `api.createLLMModels()` | `POST /api/v1/llm/models/batch` | `LLMCreateDialog` 保存回调 |
| `api.updateLLMModel()` | `PATCH /api/v1/llm/models/{id}` | `LLMEditDialog` 保存回调 |
| `api.listLLMModels()` | `GET /api/v1/llm/models` | `LLM` 页加载/刷新 |

---

### 3.6 UI 状态 [必填]

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 模型列表 | 既有首载 spinner（后台刷新不置 loading，避免闪烁） | 既有空态（不变） | 既有错误提示（不变） | 「模型能力」列渲染能力 Tag |
| 新建/编辑对话框 | `busy` 置位、保存按钮禁用（既有三态） | N/A（表单） | `setErr` + `Toast` 展示本地化文案，技术细节进 `ErrorDetail`；对话框保持打开 | `setMsg` + 关闭对话框 + 列表刷新 |
| 模型能力 checkbox | 无异步 | N/A | 不适用 | 勾选态即时反映局部 state |

---

### 3.7 样式方案 [必填]

| 维度 | 约定 |
|------|------|
| **样式与逻辑分离** | 沿用 Semi Design 组件与既有 `Field` 布局助手；不新增内联样式或魔法值 |
| **设计 tokens** | Tag 颜色沿用既有语义色（`green` = 支持 / `grey` = 不支持）；新增「文本+图片」Tag 复用同一配色语义，不新增色值 |
| **响应式断点** | 沿用既有列表页策略；「模型能力」列宽需容纳两个 Tag，需同步更新列宽常量与列宽总和断言（`test/LLM.test.tsx` 中断言总和为 `1390`，本改动后必须更新为新总和） |

---

### 3.8 可访问性与兼容性 [按需]

| 维度 | 要求 |
|------|------|
| 可访问性 | 新 checkbox 提供语义 `aria-label` 与可见文案（对应新增 i18n key）；键盘可聚焦并切换；`Field` 必须以 `as="div"` 渲染避免 label 双触发 |
| 浏览器/设备兼容 | 沿用项目既有目标范围，不引入新 API |

---

## 4. 风险与依赖 [按需]

| 风险ID | 描述 | 影响 | 应对 | 验证场景 |
|--------|------|------|------|---------|
| RISK-F01 | 列表列宽变化导致 `test/LLM.test.tsx` 的列宽总和断言失败 | CI 红，阻塞合并 | 同步更新列宽常量与断言总和为新值 | NFR-TEST-F01、S-12 |
| RISK-F02 | 新 checkbox 被 `Field` 以 `<label>` 包裹，触发 onChange 双触发（项目已有此回归先例） | 勾选一次被切两次，表现为「点不动」 | 强制 `Field as="div"`；为新技术补齐同类回归断言 | E-12 |
| RISK-F03 | 用户对不支持视觉的模型勾选「文本+图片」 | 该模型收到图片在 provider 层报错 | 分组内提供说明文案（「模型支持图片输入时勾选」）；首版不做自动推断 | 手动验证（外部模型行为，见后端 RISK-B02） |
| RISK-F04 | 新增 i18n key 漏补 `en.ts` | 英文界面显示 key 原文 | 同一 PR 内补两份 locale；靠 NFR-I18N-F01 兜底 | NFR-I18N-F01 |

---

## Spec Compliance Matrix

> 从需求目录 `spec-context.yml` 继承并逐 Rule 回填。required Rule 必须有具体设计落点和 verifier/验收场景；N/A 只接受逐项用户确认。

| Spec/Rule | enforcement | 设计影响 | 设计落点 | 验证场景 | 状态/N/A 理由 |
|-----------|-------------|---------|---------|---------|----------------|
| `frontend-component-specs#RULE-frontend-component-001` | required | 组件需类型化 props；展示逻辑不持有网络 IO；列表 key 稳定；布局走 Semi + CSS Modules 而非内联样式 | §3.3 CMP-F01（纯展示派生）、§3.7 | S-12、E-12 | applied |
| `frontend-component-specs#RULE-frontend-semi-shell-001` | required | 沿用 `@douyinfe/semi-ui` 的 `Checkbox`/`Tag`/`Table`；不在页面内重复包 `ConfigProvider` | §3.1 技术选型、§3.3 | S-11、S-12 | applied |
| `frontend-directory-structure#RULE-frontend-directory-001` | required | 改动限于 `pages/`、`types/`、`i18n/`；HTTP 仍只经 `src/api.ts` | §3.5 数据获取层（不新增 API 方法与路径） | S-11、E-11 | applied |
| `frontend-directory-structure#RULE-frontend-api-types-001` | required | 读写 DTO 必须集中在 `src/types/api.ts`，页面不得自造漂移类型 | §3.4（`LLMModelConfig` / `LLMModelInput` / `LLMModelUpdateInput` 三处扩展） | S-11、S-12 | applied |
| `frontend-quality-standards#RULE-frontend-quality-001` | required | 保持 strict 类型；异步交互需显式 loading/error/success 三态 | §3.6 UI 状态（四态表） | E-11、S-11 | applied |
| `frontend-quality-standards#RULE-frontend-api-client-001` | required | 沿用 `api.ts` 既有契约（`/api/v1`、`code===0` 解包、`ApiError`、401 处理），不新增绕过路径 | §3.5 Service 方法表 | E-11、S-11 | applied |
| `frontend-quality-standards#RULE-frontend-i18n-001` | required | 所有新增可见文案走 i18n，且同一 PR 内同步 `zh.ts` 与 `en.ts`；组件内用 `useTranslation` | §3.8、FEAT-F03、§3.7（Tag 文案） | NFR-I18N-F01、S-12 | applied |

> 前端域未匹配到 `runtime-*` / `backend-*` 规范，故本文件 Matrix 仅含前端 Spec。后端 + Runtime 域的 required Rule（含 N/A 待确认项）见 `llm-model-image-input.backend.design.md`。

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| FEAT / CMP / NFR | 功能项 / 组件 / 非功能需求 |
| 容器组件 | 负责数据获取与状态的组件 |
| 展示组件 | 纯 UI、props 驱动、事件上抛的组件 |
| 模型能力 | 本次引入的 UI 分组概念，聚合「工具调用」与「文本+图片」两项独立能力声明 |
| `Field as="div"` | 项目内表单布局助手，禁用 `<label>` 包裹以避免 checkbox 双触发 |

---

*文档结束*

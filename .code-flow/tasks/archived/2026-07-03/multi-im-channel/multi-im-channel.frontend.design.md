# 多 IM 通道支持 前端模块需求与设计简报

> **文档编号**: FE-MULTICHAN-001
> **文档版本**: v0.1
> **创建日期**: 2026-07-03
> **文档状态**: 草稿

**评审边界说明**:
- **需求评审**: 第 2 章（需求分析）→ 通过后锁定需求基线
- **设计评审**: 第 3 章（前端技术设计）→ 通过后锁定设计基线

**ID 体系**: US（来自 PRD，可选）、FEAT（功能）、CMP（组件）、NFR（非功能指标）
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
- [附录：术语表](#附录术语表)

---

## 1. 文档控制

### 1.1 责任人

| 角色 | 姓名 | 职责范围 |
|------|------|---------|
| 开发负责人 | | 技术方案、代码实现 |

### 1.2 修订历史

| 版本 | 日期 | 作者 | 变更描述 |
|------|------|------|---------|
| v0.1 | 2026-07-03 | | 初始草稿，PRD 派生 |

---

## 2. 需求分析

### 2.1 需求概述 [必填]

| 项目 | 内容 |
|------|------|
| **模块名称** | 多 IM 通道支持（前端） |
| **需求类型** | 组件重构 + 交互优化 |
| **业务背景** | 当前创建容器时通道为单选下拉（企微/微信二选一），列表每行操作按钮过多（6 按钮+下拉），不支持多通道展示和批量操作。 |
| **核心目标** | ① 创建/编辑表单支持多通道勾选 + 各自凭证配置；② 容器列表每行展示多通道连接状态；③ 操作按钮重组，批量操作上移表头。 |

---

### 2.2 功能方案 [必填]

| 功能ID | 功能名称 | 功能描述 | 优先级 | 来源 |
|--------|---------|---------|--------|------|
| FEAT-02 | 数据驱动通道注册表 | `channels.ts` 扩展为 `ChannelDef[]`，含凭证字段声明；表单和展示组件据此动态渲染 | P0 | US-01, US-02, US-06 |
| FEAT-03 | 多渠道创建表单 | 创建容器弹窗：Checkbox 组 + 内联展开凭证字段；免凭证通道显示提示 | P0 | US-01 |
| FEAT-04 | 通道编辑表单 | 编辑弹窗：已有通道预填状态、secret 留空保持、取消勾选清凭证 | P0 | US-02, US-03, US-04 |
| FEAT-06 | 容器列表多通道展示 | "消息通道"列从单 Tag 变为 Tag 组，每通道独立连接状态 🟢/🔴；筛选器改为多选 | P1 | US-06 |
| FEAT-07 | 操作按钮重组+批量操作 | 表头增加复选框（全选）+ 批量按钮（重载 Skill/升级/删除）；行内精简为「日志/扫码/资源/更多▾」 | P1 | US-07, US-08 |

---

### 2.3 范围与边界 [必填]

| 类别 | 内容 |
|------|------|
| **范围（In Scope）** | ① `channels.ts` 注册表重构；② 创建表单改为多选 Checkbox + 条件凭证区；③ 编辑表单复用创建组件，追加预填/ diff 提交逻辑；④ 列表"消息通道"列改为 Tag 组；⑤ 表头批量操作栏 + 行复选框；⑥ 行内按钮精简 |
| **非范围（Out of Scope）** | ① 新通道的插件安装和具体凭证逻辑（仅做前端注册表数据定义）；② 移动端适配；③ 通道级别的会话切换（所有通道共享同一会话） |
| **有意妥协 / 技术债** | ① 编辑表单首次加载需要额外 API 调用（`GET /containers/{id}`），增加一次网络请求；② 批量操作不做进度展示（顺序执行，逐个反馈） |

---

### 2.4 验收条件 [必填]

**正常场景**

| 场景ID | 功能ID | 优先级 | 操作步骤 | 预期 UI 结果 |
|--------|--------|--------|---------|-------------|
| S-01 | FEAT-03 | P0 | 1. 点击"创建容器" 2. 勾选企微 + 微信 3. 填写企微凭证 4. 提交 | 弹窗关闭，列表新增一行，通道列显示 `🏢 企微 🟢 💬 微信 🟡` |
| S-02 | FEAT-04 | P0 | 1. 列表点击 alice 行的「编辑通道」 2. 企微已勾选且 botId 回填 3. 追加勾选微信 4. 保存 | 弹窗关闭，alice 通道列新增微信 Tag |
| S-03 | FEAT-04 | P0 | 1. 编辑 alice 2. 取消勾选微信 3. 确认保存 | 弹窗关闭，微信 Tag 消失 |
| S-04 | FEAT-04 | P0 | 1. 编辑 alice 2. 修改企微 botId，secret 留空 3. 保存 | 企微 Tag 仍在线（botId 更新，secret 不变） |
| S-05 | FEAT-07 | P1 | 1. 勾选 alice+bob 两行 2. 点击表头「批量删除」 3. 确认 | 两行移除 |
| S-06 | FEAT-06 | P1 | 列表加载完成 | 每行通道列渲染 Tag 组，在线🟢 / 离线🔴 |

**异常场景**

| 场景ID | 功能ID | 触发条件 | UI 表现 |
|--------|--------|---------|---------|
| E-01 | FEAT-03 | 提交时未勾选任何通道 | 弹窗内提示"至少选择一个通道"，阻止提交 |
| E-02 | FEAT-03 | 企微已勾选但 botId 为空 | 企微凭证区 botId 字段标红，提示"Bot ID 必填" |
| E-03 | FEAT-04 | 取消最后一个通道 | 二次确认弹窗"所有通道已取消，用户将无法通过 IM 访问。确认？" |
| E-04 | FEAT-07 | 批量删除未勾选任何行 | 删除按钮置灰不可点击 |
| E-05 | FEAT-04 | 保存时 API 返回 500 | Toast 错误提示"通道配置更新失败"，弹窗不关闭 |

**边界场景**

| 场景ID | 功能ID | 条件 | 预期行为 |
|--------|--------|------|---------|
| B-01 | FEAT-06 | 容器无通道（极端情况） | 通道列显示"—" |
| B-02 | FEAT-06 | 某通道 probe 数据缺失 | 该通道 Tag 显示灰色 ⚪ 未知状态 |
| B-03 | FEAT-07 | 批量操作中某容器失败 | 其余继续执行，结果汇总提示"3 成功 1 失败" |

---

## 3. 前端技术设计

### 3.1 技术选型 [必填]

| 类别 | 选型 | 版本 | 选型理由 |
|------|------|------|---------|
| 框架 | React | 18.3 | 沿用现有 |
| UI 库 | Semi UI (`@douyinfe/semi-ui`) | 2.101 | 沿用现有，使用其 Table/Checkbox/Modal/Tag/Toast/Button/Dropdown/Space |
| 状态管理 | 局部 `useState` + `useMemo` | — | 沿用现有模式，无全局状态库 |
| 路由 | 条件渲染（无路由库） | — | 沿用现有 App.tsx 模式 |
| 样式方案 | CSS Modules | — | 沿用现有 `*.module.css` |
| 数据请求 | `src/api.ts` 封装 `fetch` | — | 沿用现有，新增 API 方法 |
| 类型 | TypeScript 5.5 (strict) | — | 沿用现有 |

#### Semi UI 关键 API 确认（v2.101 类型定义实测）

以下 API 已通过 `node_modules/@douyinfe/semi-ui/lib/es/` 类型定义文件确认：

**Table `rowSelection`**（`interface.d.ts: RowSelectionProps`）:
```tsx
<Table
  rowKey="userId"
  rowSelection={{
    selectedRowKeys: selectedIds,          // (string | number)[]
    onChange: (selectedRowKeys, selectedRows) => { ... },
    onSelect: (record, selected, selectedRows, nativeEvent) => { ... },
    onSelectAll: (selected, selectedRows, changedRows) => { ... },
  }}
/>
```

**Checkbox 组**（`checkboxGroup.d.ts: CheckboxGroupProps`）:
```tsx
<Checkbox.Group
  value={selectedChannels}                 // any[]
  onChange={(value: any[]) => { ... }}
  options={[{ label, value, ...checkboxProps }]}
  direction="vertical"
/>
```

> 注意：通道勾选需内联展开凭证区（方案 A），`Checkbox.Group` 的 `options` 模式无法在每项之间插入展开内容。改用单个 `<Checkbox>` + 条件渲染展开区。

**Dropdown**（现有模式确认）:
```tsx
<Dropdown menu={[
  { node: "item", name: "启动", onClick: () => { ... } },
  { node: "item", name: "停止", onClick: () => { ... } },
]}>
  <Button size="small">更多▾</Button>
</Dropdown>
```

**Tag** / **Modal** / **Toast** / **Button**：现有代码用法正确，无需调整。

---

### 3.2 页面与路由结构 [必填]

| 页面 | 路由 | 布局 | 说明 |
|------|------|------|------|
| Containers | `/` (条件渲染) | Sidebar + 主内容区 | **修改**：新增批量操作栏、通道列 Tag 组、编辑弹窗 |

> 不新增页面。所有变更集中在 `Containers.tsx` 及其子组件。

---

### 3.3 组件设计 [必填]

**组件树**（容器/展示分离）

```
<Containers>                          # 容器：数据获取 + 全局状态
├─ <BatchToolbar>                     # 新增：表头批量操作栏
│  ├─ <Button "重载 Skill">           # Semi Button
│  ├─ <Button "批量升级">             # Semi Button
│  └─ <Button "批量删除">             # Semi Button (danger, selectedIds.length===0 置灰)
├─ <Table>                            # Semi Table，新增 rowSelection
│  │  rowSelection={{                # Semi Table 内置行选择（含表头全选 Checkbox）
│  │    selectedRowKeys: selectedIds,
│  │    onChange: (keys, rows) => setSelectedIds(keys),
│  │  }}
│  ├─ <Column "用户">                 # 不变
│  ├─ <Column "消息通道">              # 修改：render ChannelTags
│  │  └─ <ChannelTags>               # 新增展示组件
│  │     └─ <Tag color="..."> × N    # Semi Tag, color 根据连接状态
│  ├─ <Column "状态">                 # 不变
│  ├─ <Column "操作">                 # 修改：精简按钮
│  │  └─ <RowActions>                 # 新增展示组件
│  │     ├─ <Button size="small" "日志">
│  │     ├─ <Button size="small" "扫码">  # 仅 channelConfigs 含 wechat 时显示
│  │     ├─ <Button size="small" "编辑通道"> # 新增
│  │     ├─ <Button size="small" "资源">
│  │     └─ <Dropdown menu={[...]}><Button size="small">更多▾</Button></Dropdown>
├─ <Pagination>                       # 不变
├─ <CreateModal>                      # 修改：单通道 Select → 多通道 ChannelForm
│  └─ <ChannelForm>                   # 新增容器组件：通道勾选 + 凭证表单
├─ <EditChannelModal>                 # 新增：编辑通道弹窗，复用 ChannelForm
└─ <BatchDeleteConfirmModal>          # 新增：批量删除确认
```

| 组件ID | 组件名 | 类型 | 复用来源/去向 | 职责 |
|--------|--------|------|--------------|------|
| CMP-01 | ChannelForm | 容器 | 新建，CreateModal + EditChannelModal 复用 | 通道勾选状态 + 凭证输入 + 校验 |
| CMP-02 | ChannelTags | 展示 | 新建，列表列渲染 | 纯 UI：接收 channels 数组 + 连接状态 map，渲染 Tag 组 |
| CMP-03 | RowActions | 展示 | 新建 | 纯 UI：接收 channel 类型，渲染精简操作按钮 |
| CMP-04 | BatchToolbar | 容器 | 新建 | 接收 `selectedIds: string[]`（来自 Table rowSelection），渲染批量操作按钮；无勾选时按钮置灰 |
| CMP-05 | EditChannelModal | 容器 | 新建 | 加载已有配置 → ChannelForm（预填模式）+ diff 提交 |
| CMP-06 | ChannelCredentialFields | 展示 | 新建，ChannelForm 内使用 | 根据 `credentialFields` 声明渲染输入框组 |

---

### 3.4 组件接口契约 [必填]

**CMP-01 `<ChannelForm>`**

> **Semi UI 关键约束**：不使用 `Checkbox.Group`。原因是方案 A 要求每个勾选项下方内联展开凭证输入区，`Checkbox.Group` 的 `options`/`children` 模式无法在项之间插入任意内容。改用单个 `<Checkbox checked={...} onChange={...}>` + 条件渲染 `<div>` 展开区。

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| mode | `"create" \| "edit"` | Y | — | 模式：创建 vs 编辑 |
| initial | `ChannelConfig \| null` | N | `null` | 编辑模式下的已有配置（含脱敏凭证） |
| busy | `boolean` | N | `false` | 提交中 |
| error | `string` | N | `""` | 服务端错误 |

| Events / 回调 | 载荷类型 | 触发时机 |
|--------------|---------|---------|
| `onSubmit` | `{ channels: string[], channelConfigs: Record<string, ChannelCredential> }` | 表单校验通过后提交 |
| `onCancel` | — | 点击取消/关闭 |

**内部状态** (不暴露为 props):
- `selectedChannels: string[]` — 已勾选通道 ID（驱动 `<Checkbox checked>`）
- `credentials: Record<string, Partial<ChannelCredential>>` — 各通道凭证表单值

**渲染伪代码**:
```tsx
{CHANNEL_DEFS.map(def => (
  <div key={def.id}>
    <Checkbox
      checked={selectedChannels.includes(def.id)}
      onChange={e => toggleChannel(def.id, e.target.checked)}
    >
      {def.icon} {def.label}
    </Checkbox>
    {selectedChannels.includes(def.id) && (
      <div style={{ marginLeft: 24, borderLeft: '2px solid var(--semi-color-border)', paddingLeft: 12 }}>
        {def.credentialFields.length > 0 ? (
          <ChannelCredentialFields
            channelDef={def}
            values={credentials[def.id] || {}}
            onChange={(key, val) => updateCredential(def.id, key, val)}
          />
        ) : (
          <p className="hint">{def.hint}</p>
        )}
      </div>
    )}
  </div>
))}
```

**CMP-02 `<ChannelTags>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| channels | `string[]` | Y | — | 通道 ID 列表 |
| statuses | `Record<string, { connected: boolean }>` | Y | — | per-channel 连接状态 |

**CMP-06 `<ChannelCredentialFields>`**

| Props | 类型 | 必填 | 默认 | 说明 |
|-------|------|------|------|------|
| channelDef | `ChannelDef` | Y | — | 通道注册表项（含 credentialFields 声明） |
| values | `Partial<ChannelCredential>` | Y | — | 当前表单值 |
| existingConfig | `ChannelConfigMeta \| null` | N | `null` | 编辑模式下的已有配置元信息（secretConfigured/lastUpdated） |
| onChange | `(key: string, value: string) => void` | Y | — | 字段变更回调 |

---

### 3.5 状态与数据流 [必填]

**状态划分**

| 状态 | 作用域 | 形状 | 读写方 |
|------|--------|------|--------|
| containers | local (Containers) | `Container[]` | `refresh()` 写入，Table + BatchToolbar 读取 |
| selectedIds | local (Containers) | `Set<string>` | BatchToolbar 全选/行复选框写入，批量操作读取 |
| channelForm | local (ChannelForm) | `{ selected, credentials }` | ChannelForm 内部，提交时回调上抛 |
| createOpen / editTarget | local (Containers) | `boolean \| string \| null` | 弹窗开关 |

**数据流**

```
列表加载:
  Containers useEffect → api.listContainers()
    → setItems(views) → 列表渲染
    → ChannelTags 从 item.channels + item.channelStatuses 渲染

创建容器:
  CreateModal → ChannelForm (mode="create")
    → onSubmit: api.createContainer({ channels, channelConfigs })
    → refresh()

编辑通道:
  EditChannelModal (open) → api.getContainer(userId)
    → ChannelForm (mode="edit", initial=loaded)
    → onSubmit: api.updateChannels(userId, { channels, channelConfigs })
    → refresh()

批量操作:
  BatchToolbar 全选/行复选框 → selectedIds
    → onClick "删除": api.deleteContainer(id, false) × N (顺序)
    → onClick "升级": upgrade modal → api.upgrade(id, tag) × N
    → onClick "重载 Skill": api.reloadSkills()
    → refresh()
```

**数据获取层**

| Service 方法 | 对应后端接口 | 调用方组件/hook |
|-------------|-------------|----------------|
| `api.createContainer(b)` | `POST /containers` | CreateModal |
| `api.listContainers()` | `GET /containers` | Containers |
| `api.getContainer(id)` | `GET /containers/{id}` | EditChannelModal |
| `api.updateChannels(id, b)` | `PUT /containers/{id}/channels` | EditChannelModal |
| `api.deleteContainer(id, dv)` | `DELETE /containers/{id}` | BatchToolbar |
| `api.upgrade(id, tag)` | `POST /containers/{id}/upgrade` | BatchToolbar |
| `api.reloadSkills()` | `POST /skills/reload` | BatchToolbar |

---

### 3.6 UI 状态 [必填]

| 视图/交互 | loading | empty | error | success |
|----------|---------|-------|-------|---------|
| 容器列表 | 骨架屏（Semi Table skeleton） | "暂无容器，点击创建" | Toast 错误提示 | 正常表格 |
| 通道连接状态 | Tag 灰色 ⚪ "加载中" | — | Tag 红色 🔴 (probe 失败) | Tag 绿色 🟢 |
| 创建表单提交 | 按钮 loading + disabled | — | 弹窗内红字错误信息 | Toast "创建成功" + 弹窗关闭 |
| 编辑表单加载 | 弹窗内骨架 | — | Toast "加载失败" + 弹窗关闭 | 表单预填完成 |
| 编辑表单提交 | 按钮 loading + disabled | — | Toast "更新失败"，弹窗不关 | Toast "已更新" + 弹窗关闭 |
| 批量删除确认 | 按钮 loading | "未选择任何容器"（按钮置灰） | Toast "N 成功 M 失败" | Toast "已删除 N 个容器" |

---

### 3.7 样式方案 [必填]

| 维度 | 约定 |
|------|------|
| **样式与逻辑分离** | 每个组件独立 `*.module.css`；ChannelForm/ChannelTags/BatchToolbar 各有独立样式文件 |
| **设计 tokens** | 沿用 `styles.css` `:root` 变量（赛博朋克青紫主题），不引入新 token |
| **响应式** | 不做移动端适配（In Scope 外）；最小宽度 1024px |
| **Tag 间距** | 通道 Tag 之间 `gap: 4px`，与现有 Semi Tag 间距一致 |
| **凭证区域** | 勾选展开区 `margin-left: 24px`（缩进），`border-left: 2px solid var(--semi-color-border)` |

---

## 4. 风险与依赖

| 风险ID | 描述 | 影响 | 应对 |
|--------|------|------|------|
| RISK-01 | Semi UI Table 列宽在多 Tag 时可能溢出 | 通道列换行或截断 | 通道列 `width` 从 110 → 自动，Tag 允许折行；或限制最多显示 3 个+"+N" |
| RISK-02 | 编辑表单首次需新 API (`GET /containers/{id}`)，后端需同步实现 | 前端依赖后端 API-04 就绪 | 前后端同版本发布 |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| US / FEAT / NFR | 用户故事 / 功能项 / 非功能需求 |
| CMP | Component，组件 |
| ChannelDef | 通道注册表项类型，声明 id/label/icon/credentialFields/hint |
| 容器组件 | 负责数据获取与状态的组件 |
| 展示组件 | 纯 UI、props 驱动、事件上抛的组件 |
| 方案 A | 勾选 + 内联展开的表单模式 |

---

*文档结束*

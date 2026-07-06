---
description: 写/改组件时适用：props、hooks、渲染、UI 样式约束
checks:
  - id: no-native-confirm
    type: regex
    pattern: "\\b(confirm|prompt|alert)\\("
    files: ["*pages*", "*components*"]
    message: "禁止原生 confirm/prompt/alert，用自定义 Modal 组件（原生弹窗无法套用主题）"
  - id: no-native-select
    type: regex
    pattern: "<select"
    files: ["*pages*", "*components*"]
    message: "禁止原生 <select>，用自定义 Select 组件（原生 option 列表无法套用主题）"
  - id: no-index-key
    type: regex
    pattern: "key=\\{[^}]*\\b(index|idx|i|rowIndex|itemIndex)\\b[^}]*\\}"
    files: ["*pages*", "*components*"]
    message: "禁止 key={index}/{i}/{idx} 等数组索引作 key，顺序变更会触发错误复用。用稳定唯一字段（如 item.id、a.userId）"
---

# Component Specs

## Examples

✅ 稳定唯一 key + 改值经回调上抛

```tsx
{items.map((it) => <Row key={it.id} item={it} onChange={onChange} />)}
```

❌ 用数组 index 作 key + 组件内直接改 props

```tsx
{items.map((it, i) => { it.value = next; return <Row key={i} item={it} />; })}
```

✅ 容器/展示分离 + 样式走 token，展示组件不碰数据获取

```tsx
// 展示组件：纯 props 驱动，样式用 class/token，无请求
const OrderRow = ({ order, onSelect }: Props) =>
  <div className={styles.row} onClick={() => onSelect(order.id)}>{order.title}</div>;
```

❌ 展示组件内自取数据 + 内联魔法样式

```tsx
const OrderRow = ({ id }) => {
  const [o, setO] = useState(); useEffect(() => { fetch(`/orders/${id}`)... }, []);
  return <div style={{ margin: 13, color: '#3a7' }}>{o?.title}</div>;
};
```

## Rules
- Props 必须类型化（TS interface / PropTypes / defineProps），可选项给默认值
- 组件文件名与导出组件名一致，使用 PascalCase
- 单组件文件 ≤ 300 行，超出拆成子组件或提取 hook
- 组件内禁止直接修改 props，需改值通过事件 / 回调上抛
- **样式与逻辑/数据分离**：样式走 CSS Modules / 原子类 / 设计 token，不与数据获取或业务逻辑混在同一处；展示组件不发起请求

## Patterns
- 拆分容器组件（数据获取 / 状态）与展示组件（纯 UI），便于测试和复用
- 复用逻辑提取为 hook（`useXxx`）/ composable，禁止跨组件复制粘贴
- 列表渲染必须给 `key`，且 `key` 稳定唯一，避免使用数组索引
- 受控表单优先；非受控仅用于不需要回读值的场景
- 样式遵循设计系统：间距用 4 的倍数，强调色 ≤ 2 种
- **[项目] [Login.tsx, Containers.tsx] 表单提交模式**：`busy` state → `try { await api.xxx() } catch { setErr() } finally { setBusy(false) }`；提交按钮 `disabled={busy}` 防重复；成功/错误通过 `msg`/`err` state 展示
- **[项目] [Containers.tsx] 轮询刷新**：`useCallback` 包裹 refresh → `useEffect` 中 `setInterval(refresh, 5000)` → cleanup `clearInterval`；不单独发起 fetch，统一经 `api.ts`；`useCallback`/`useEffect` 依赖数组必须含全部读取的 state（如 `[actor, page, pageSize]`），漏依赖会导致回调不更新
- **[项目] [Modal.tsx, NotificationBell.tsx, Select.tsx] 浮层交互统一**：点击遮罩/外部关闭（`useRef` + mousedown 监听）+ Esc 关闭 + `fadeIn` 动画；z-index 分层（下拉 20–50 / 模态 200）
- **[项目] [Modal.tsx] 通用对话框壳**：所有弹窗（创建/升级/删除/重载/日志/扫码）统一用 `components/Modal.tsx`——固定头部 + 固定底部 footer + body 单一滚动区（`max-height:85vh`，只 body 滚动）+ `wide` 变体（日志等宽内容）；禁止再自定义弹窗 DOM 结构，保证视觉一致
- **[项目] [src/channels.ts] 通道元数据集中**：消息通道的标签/图标集中在 `channels.ts`（`CHANNELS` 列表 + `channelMeta(value)`）；前端按 channel 值渲染图标/名称/过滤项，新增通道只在此一处登记，不在组件里散落硬编码
- **[项目] 同一表单的 create/edit 复用模式**：`ChannelForm.tsx` 一份代码同时承载新建和编辑两种用法。`mode="create"` 时所有 required 字段必填；`mode="edit"` + `initial.channelConfigs[ch].secretConfigured === true` 时**跳过该通道的 required 校验**（敏感字段已配置的不让用户重填）。提交时**空字符串 = 保留旧值**（不是清空）——后端 `mergeChannelConfig` 也按这个语义走。前后端这套约定一致：「空字符串 = 保留」对 secret 字段成立，对 botId 等非敏感字段可改成必填。表单组件需要兼顾 create/edit 时按这个约定设计 prop / validate / onSubmit 三者。

## Anti-Patterns
- 禁止在组件内直接修改 props 或 store 内部状态
- 禁止把大量逻辑塞进 JSX 表达式，复杂条件提取变量或子组件
- 禁止用 `index` 作为列表 `key`（顺序变更会触发错误复用）
- 禁止省略 `alt` / `aria-*` 等可访问性属性
- **[项目] 禁止原生 `confirm()` / `prompt()` / `alert()`**：确认/输入对话框统一用自定义 `Modal` 组件（`components/Modal.tsx`）。原生弹窗由浏览器渲染、位置不可控、无法套用赛博朋克主题
- **[项目] 禁止原生 `<select>`**：下拉统一用自定义 `Select` 组件（`components/Select.tsx`）。原生 `<select>` 控件本身可样式化，但**展开的 `<option>` 列表由浏览器/OS 渲染，CSS 无法覆盖**，导致样式割裂

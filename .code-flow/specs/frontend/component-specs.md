---
id: frontend-component-specs
description: 写/改 Console 组件时适用：Semi UI、props、hooks、样式
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-frontend-component-001
    type: manual
    config:
      checklist: Confirm props typing, Semi + ConfigProvider, CSS modules, and no in-component fetches.
      owner: project-owner
  - rule: RULE-frontend-semi-shell-001
    type: manual
    config:
      checklist: Confirm Semi is primary UI lib and ConfigProvider shell stays in main.tsx / App theme helpers.
      owner: project-owner
---

# Component Specs

## Examples

✅ Semi 组件 + CSS Module + 纯 props

```tsx
import { Button } from "@douyinfe/semi-ui";
import styles from "./Row.module.css";
export const OrderRow = ({ title, onSelect }: Props) => (
  <div className={styles.row} onClick={onSelect}>{title}</div>
);
```

❌ 展示组件内请求 + 内联魔法样式

```tsx
export const OrderRow = ({ id }) => {
  const [t, setT] = useState("");
  useEffect(() => { fetch(`/api/x/${id}`).then(...) }, []);
  return <div style={{ margin: 13 }}>{t}</div>;
};
```

## Rules
- [RULE-frontend-component-001] Components must type props, keep presentational pieces free of network I/O, use stable list keys, and prefer Semi Design + CSS Modules over ad-hoc inline styles for layout/theme.
- [RULE-frontend-semi-shell-001] Console UI must use `@douyinfe/semi-ui` as the primary component library; locale/theme shell is configured via `ConfigProvider` in `main.tsx` (and App-level theme helpers), not per-page re-wrapping.

## Guidance
- Props 必须 TypeScript 声明；可选 props 给合理默认
- 文件名与主导出组件名 PascalCase 一致
- 列表 `key` 使用稳定业务 id，禁止用数组 index（静态常量列表除外）
- 样式优先 Semi token / CSS Modules；避免散落魔法色值
- 复杂表单与对话框状态就近管理，确认/取消路径完整；破坏性操作（删除/升级）弹窗需明确确认文案
- 人用户、平台凭证、模型等敏感操作对话框必须有明确确认文案

## Patterns
- 容器组件拉数，展示组件只渲染
- 复用逻辑 → `hooks/useXxx` 或 page 级 hook
- 批量操作走 `BatchToolbar` 一类统一条，避免每页复制
- 顶栏操作/过滤分区与内容区组件拆分，避免单页巨型 JSX

## Avoid
- 禁止直接改 props
- 禁止展示组件发起 API 请求
- 禁止用 index 当可变列表 key
- 禁止在页面内重复挂载冲突的全局 theme provider

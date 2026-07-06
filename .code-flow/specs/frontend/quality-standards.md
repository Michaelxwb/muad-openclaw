---
description: 写前端代码时适用：类型、lint、错误处理、测试、状态管理质量约束
---

# Frontend Quality Standards

## Examples

✅ `unknown` 收敛 + 异步三态

```ts
setState("loading");
try {
  const raw: unknown = await api.fetch();
  setState("success", parse(raw));
} catch (e) {
  setState("error", toMessage(e));
}
```

❌ `any` + `@ts-ignore` + 只处理成功路径

```ts
// @ts-ignore
const data: any = await api.fetch();
render(data);
```

## Rules
- TypeScript 项目禁止使用 `any`，未知类型用 `unknown` 并显式收敛
- 组件统一使用函数组件（React）/ 组合式 API（Vue 3），禁止类组件新增
- 关键交互（提交 / 删除 / 支付）必须有错误提示与 loading 状态
- 异步操作必须处理 loading / success / error 三态，禁止只处理成功路径
- 提交前必须通过 lint 与 type check，禁止 `eslint-disable` / `@ts-ignore` 滥用
- **[项目] 异步轮询必须用 `mounted` ref 守卫 setState**：`useEffect` 内 `setInterval` + 异步 fetch + `setState` 的模式（如 `pages/Containers.tsx:131-147` 5s 拉 `/containers`、`components/NotificationBell.tsx:15-33` 30s 拉 `/alerts`）必须用：
  ```tsx
  let mounted = true;
  const fetch = async () => {
    api.x().then(r => { if (mounted) setX(r); }).catch(() => {});
  };
  fetch();
  const t = setInterval(fetch, N);
  return () => { mounted = false; clearInterval(t); };
  ```
  否则 React 18 StrictMode 双 mount + 异步 fetch 解析会向已卸载/重挂载组件 setState，触发 `postMessage` componentStack 警告。`useCallback` 包裹 + 正确的依赖数组（`[refresh]`）也要满足——否则 effect 不会在依赖变化时重启，旧 refresh 闭包捕获过期 state。
- **[项目] 入口处 console.error/warn filter 屏蔽**已知**上游库 deprecation 警告**（如 Semi v2.x 通过 `react-resizable@3` / `react-draggable@4` / `tooltip` 内部 `findDOMNode` 持续打 console.error）：在 `main.tsx` 顶部 import 后立即装，**必须**按 React 警告的 printf 格式 `console.error("Warning: %s\n\n%s", msg, stack)` 扫描**所有** args（`args.some(a => String(a).includes(KEYWORD))`），不能只看 `args[0]`——那是格式串，关键词在 `args[1]` 的 msg 里。filter 必须装在 React 渲染前（`createRoot` 调用之前），否则首次 render 的告警漏过。**仅**屏蔽**明确**关键词（如 `"findDOMNode"`），不要用宽泛正则以免吞掉真错误。

## Patterns
- 跨组件状态用集中式状态管理，避免 prop drilling 超过 2 层
- 表单校验在提交前完成，错误信息定位到具体字段
- 网络请求统一处理 401 / 403 / 5xx，避免每个调用方重复
- 关键路径补端到端测试或组件交互测试

## Anti-Patterns
- 禁止在 render / setup 中发起未受控的副作用（用 `useEffect` / `onMounted`）
- 禁止把后端错误直接抛给用户（如 SQL / stack trace）
- 禁止用 `// @ts-ignore` 绕过类型错误，必须修复或改为 `@ts-expect-error` 加注释
- 禁止在组件中直接修改 store 内部状态，必须走 action / mutation

## Project-Specific Notes

- **[tsconfig.json]** `strict: true`、`noUnusedLocals: true`、`noFallthroughCasesInSwitch: true` — 类型检查严格
- **[vite.config.ts]** `tsc --noEmit` 在 build 前执行（`"build": "tsc --noEmit && vite build"`）
- **[package.json]** ESLint (flat config) + Prettier + vitest 已配置；`tsc --noEmit` + eslint + prettier --check + vitest run 组成 CI 检查链
- **[src/api.ts]** API 调用统一走 `api.ts` 封装，页面组件不直接 `fetch`

---
id: frontend-quality-standards
description: 写 Console 前端代码时适用：TypeScript、lint、API 客户端、错误与测试
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-frontend-quality-001
    type: manual
    config:
      checklist: Confirm TS/lint/test, async UI states, and api.ts contract for console/frontend changes.
      owner: project-owner
  - rule: RULE-frontend-api-client-001
    type: regex
    config:
      pattern: "\\bfetch\\("
      files:
        - console/frontend/src/components/**
        - console/frontend/src/pages/**
      message: "HTTP 必须经 api.ts，禁止在 pages/components 裸 fetch"
---

# Frontend Quality Standards

## Examples

✅ 经 api.ts 解包 code===0 的 data

```ts
const data = await api.listPods(); // unwrapResponse 已校验 code===0
```

❌ pages 内裸 fetch + 只处理成功路径

```ts
const data: any = await fetch("/api/v1/pods").then((r) => r.json());
render(data);
```

✅ 异步三态

```ts
setState("loading");
try {
  const data = await api.listPods();
  setState("success", data);
} catch (e) {
  setState("error", e instanceof ApiError ? e.message : toMessage(e));
}
```

## Rules
- [RULE-frontend-quality-001] Console frontend changes must keep TypeScript strict typing, explicit async loading/error/success handling, and pass project frontend validators (tsc/eslint/prettier/vitest when applicable).
- [RULE-frontend-api-client-001] All Console HTTP must go through `console/frontend/src/api.ts`: base path `/api/v1`, success only when response `code === 0` then unwrap `data`, failures as `ApiError(status, code?)`, and HTTP 401 must clear token and dispatch `UNAUTHORIZED_EVENT`.

## Guidance
- 禁止无必要的 `any` / `@ts-ignore`；外部 JSON 先收成 `unknown` 再收窄（见 `parseResponseBody` / `isRecord`）
- 用户可见错误必须可读，优先展示服务端 `message` / `ApiError.message`
- 列表/详情请求必须处理 loading 与 empty；失败可重试或明确提示
- 鉴权失效：依赖 `api.ts` 的 401 清 token + `UNAUTHORIZED_EVENT`，App 层回到登录，不静默吞
- 会话 token 仅经 `token` helper 存 `localStorage` 的约定 key；禁止另存 LLM/平台 API Key、binding code 明文
- 后台轮询/自动刷新不得把首载 `loading` 一直置 true（区分 background 刷新，避免表格闪烁）
- 测试：纯函数与 hooks 优先单测；关键交互用 Testing Library

## Patterns
- 页面只调用 `api.*`，错误用 `Toast` / Banner 展示 `ApiError`
- `useMountedRef` 防止卸载后 setState
- 变更 `api.ts` / `types/api.ts` 时同步检查调用方与 vitest

## Avoid
- 禁止在 `pages/**`、`components/**` 使用裸 `fetch` / axios
- 禁止忽略 ESLint/Prettier 项目约定另起风格
- 禁止在 UI 展示原始堆栈或内部路径
- 禁止把 LLM/平台密钥渲染进 DOM 调试块

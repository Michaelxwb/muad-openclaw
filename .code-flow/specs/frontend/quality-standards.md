---
id: frontend-quality-standards
description: 写 Console 前端代码时适用：TypeScript、lint、API 客户端、错误、i18n 与测试
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
  - rule: RULE-frontend-i18n-001
    type: manual
    config:
      checklist: Confirm user-visible text goes through useTranslation/i18n.t and zh/en locales stay in sync.
      owner: project-owner
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

✅ 文案走 i18n（组件内 hook，配置数组依赖 t 用 useMemo）

```tsx
const { t } = useTranslation();
const options = useMemo(() => STATUS_KEYS.map((k) => ({ value: k, label: t(`status.${k}`) })), [t]);
```

## Rules
- [RULE-frontend-quality-001] Console frontend changes must keep TypeScript strict typing, explicit async loading/error/success handling, and pass project frontend validators (tsc/eslint/prettier/vitest when applicable).
- [RULE-frontend-api-client-001] All Console HTTP must go through `console/frontend/src/api.ts`: base path `/api/v1`, success only when response `code === 0` then unwrap `data`, failures as `ApiError(status, code?, detail?, requestId?)`, and HTTP 401 must clear token and dispatch `UNAUTHORIZED_EVENT`.
- [RULE-frontend-i18n-001] 用户可见文案一律走 i18n：组件内 `useTranslation()`（依赖 `t` 的配置数组用 `useMemo(..., [t])`），组件外纯模块（`api.ts` / `channels.ts` / `model.ts` / `createPodModel.ts` / `Pagination`）直接 `import i18n` 用 `i18n.t`；新增 key 必须同步补 `locales/zh.ts` 与 `locales/en.ts`。

## Guidance
- 禁止无必要的 `any` / `@ts-ignore`；外部 JSON 先收成 `unknown` 再收窄（见 `parseResponseBody` / `isRecord`）
- 用户可见错误必须可读，优先展示服务端 `message` / `ApiError.message`；技术细节展示用 `utils/error.tsx` 的 `ErrorDetail`（`<details>` 折叠）且 detail 来自后端 `requestId`/`detail` 字段
- 列表/详情请求必须处理 loading 与 empty；失败可重试或明确提示
- 鉴权失效：依赖 `api.ts` 的 401 清 token + `UNAUTHORIZED_EVENT`，App 层回到登录，不静默吞
- 会话 token 仅经 `token` helper 存 `localStorage` 的约定 key；禁止另存平台认证 credential、binding code 明文
- LLM 模型 API Key 例外：按产品决策明文存储并在模型管理页明文展示（管理员自维护的模型凭据，属本控制面内部配置，不进入会话存储）
- 后台轮询/自动刷新不得把首载 `loading` 一直置 true（区分 background 刷新，避免表格闪烁）
- 所有请求带 `Accept-Language`（api.ts 从 `i18n.language` 读取），后端据此返回对应语言 message
- 语言切换：`LanguageSwitcher` 挂 `AppShell` topbar 与 Login 视图；Semi locale 由 `main.tsx` 的 `ConfigProvider` 随 `useLanguage()` 切换
- 测试：纯函数与 hooks 优先单测；关键交互用 Testing Library；`test/setup.ts` 先写 `muad_lang=zh` 再动态 import `src/i18n`（保证中文 DOM 断言确定）
- 错误文案统一收敛到 `utils/error.tsx` 的 `errorMessage(error, fallbackKey)`：后端 message 优先，否则回退 fallbackKey 的 i18n 文案

## Patterns
- 页面只调用 `api.*`，错误用 `Toast` / Banner 展示 `ApiError`，技术细节经 `ErrorDetail` 折叠
- `useMountedRef` 防止卸载后 setState
- 变更 `api.ts` / `types/api.ts` 时同步检查调用方与 vitest
- 模块级 config 数组/列工厂（`SCOPE_OPTIONS` / `STATUS_OPTIONS` / `skillColumns` / `platformColumns`）移入组件 `useMemo(..., [t])`，`label` 走统一 i18n key，`color` 留在代码
- 纯函数模块直接 `i18n.t`；组件内统一 `useTranslation`

## Avoid
- 禁止在 `pages/**`、`components/**` 使用裸 `fetch` / axios
- 禁止忽略 ESLint/Prettier 项目约定另起风格
- 禁止在 UI 展示原始堆栈或内部路径
- 禁止把平台认证 credential / binding code 渲染进 DOM；LLM 模型 API Key 按产品决策允许在模型管理页明文展示
- 禁止在组件/页面硬编码用户可见中文文案（应走 i18n key，zh/en 双份）
- 禁止把 `ApiError.detail` 原文直接糊到用户界面而不折叠

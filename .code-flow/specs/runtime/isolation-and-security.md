---
id: runtime-isolation-and-security
description: 多用户隔离、凭证注入、浏览器/会话边界与镜像安全
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-runtime-security-001
    type: manual
    config:
      checklist: Confirm secrets stay out of images, restrictive file modes, users stay isolated, and tokens are not logged.
      owner: project-owner
  - rule: RULE-runtime-secret-file-mode-001
    type: manual
    config:
      checklist: Confirm config/secret material uses 0o600 (token files 0400 at canonical path) and atomic writes.
      owner: project-owner
---

# Runtime Isolation And Security

## Examples

✅ 运行时注入密钥 + 严格文件权限

```js
writeFileSync(file, content, { mode: 0o600 });
// Pod service token: 0400 under /run/secrets/muad/pod-service-token
```

❌ 烤进镜像 / 宽松权限

```Dockerfile
ENV OPENAI_API_KEY=sk-xxx
```

```js
writeFileSync(file, secretsJson) // 默认 umask，可能过宽
```

## Rules
- [RULE-runtime-security-001] Channel credentials, LLM keys, platform API keys, and service tokens must be injected at runtime and never baked into images or committed; each Human User must keep isolated agent workspace, browser profile, and session state.
- [RULE-runtime-secret-file-mode-001] Files that materialize config, bundles, or secrets on disk must use restrictive modes (`0o600` for written config/bundle material; Pod service token files `0400` at the canonical path validated by image self-check).

## Guidance
- 多用户同 Pod：严格用户级隔离（工作区、浏览器 Profile、模型绑定、私有 skill）
- 绑定码/身份激活走控制面可信路径；runtime-guard 校验上下文后再放行
- session-manager 仅按可信 Agent 上下文解析业务平台凭证，生成隔离登录态
- 日志与 progress 事件禁止包含 token、cookie、Authorization
- 镜像自检（`runtime-image-self-check`）应能发现缺失插件/技能种子与错误 token 路径，但不依赖外部密钥
- 原子写：先写临时文件再 rename，避免半截密钥文件

## Patterns
- inject-env / inject-channels / inject-multi-user-config 作为注入单一入口
- 工具策略与浏览器租约集中在 `muad-runtime-guard`
- Docker driver 将 service token 以只读方式挂进容器

## Avoid
- 禁止跨用户复用浏览器 profile 或工作区路径
- 禁止在 skill 或日志中回显密钥
- 禁止默认信任未绑定的 IM External ID
- 禁止把密钥 COPY/ENV 进 Dockerfile 或提交到 git

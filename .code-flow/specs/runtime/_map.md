# Runtime Retrieval Map

> Worker 运行时、镜像、Skill 与部署资产导航地图。路径均相对仓库根。

## Purpose

`runtime` 域覆盖 OpenClaw Worker 侧能力：镜像构建、多用户配置注入、Skill 执行、会话/浏览器隔离、进度与守护插件，以及 K8s/Docker 部署模板。平台不 fork OpenClaw 上游。

## Architecture

- Base image: OpenClaw `2026.6.10` + Chromium/Playwright
- Control scripts: `bin/*.mjs`（配置渲染、事务 apply、自检、安装）
- Plugins/tools: `tools/muad-run-skill`、`muad-runtime-guard`、`session-manager`、`muad-progress` 等
- Skill seeds/templates: `skills/`
- Deploy: `Dockerfile`、`entrypoint.sh`、`k8s/`、`compose.template.yml`

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Worker 镜像；凭证不进镜像 |
| `entrypoint.sh` / `provision-user.sh` | 容器启动与用户供给 |
| `bin/openclaw-config-renderer.mjs` | 多用户配置渲染 |
| `bin/runtime-config-transaction.mjs` | 配置事务（prepare/validate/commit） |
| `bin/runtime-config-schema.mjs` | runtime config schema |
| `bin/inject-*.mjs` | env/channels/multi-user 注入 |
| `bin/private-skill-installer.mjs` | Private Skill 安装 |
| `bin/runtime-image-self-check.mjs` | 镜像自检 |
| `tools/muad-run-skill/` | Skill 激活、执行、进度、telemetry |
| `tools/muad-runtime-guard/` | 绑定、工具策略、浏览器租约 |
| `tools/session-manager/` | 业务平台会话/凭证解析 |
| `tools/muad-progress/` | 进度 CLI（Go） |
| `skills/` | system skill 种子与开发模板 |
| `k8s/` | Console/user/reaper 清单 |

## Module Map

```
bin/                 # Node runtime helpers + tests
tools/
├── muad-run-skill/  # skill runner plugin
├── muad-runtime-guard/
├── session-manager/
├── muad-progress/   # Go progress + skill-check
├── progress-adapters/
└── runtime-concurrency/
skills/              # seeds + _templates
k8s/ Dockerfile entrypoint.sh
```

## Related Domains

- 控制面 API/apply 编排：`backend`
- 管理台 UI：`frontend`

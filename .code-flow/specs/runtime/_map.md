# Runtime Retrieval Map

> Worker 运行时、镜像、Skill 与部署资产导航地图。路径均相对仓库根。

## Purpose

`runtime` 域覆盖 OpenClaw Worker 侧能力：镜像构建、多用户配置注入、Skill 执行、会话/浏览器隔离、进度与守护插件，以及 K8s/Docker 部署模板。平台不 fork OpenClaw 上游。

## Architecture

- Base image: OpenClaw `2026.7.1` + Chromium/Playwright
- Control scripts: `bin/*.mjs`（配置渲染、事务 apply、自检、安装）
- Plugins/tools: `tools/muad-run-skill`、`muad-runtime-guard`、`muad-skill-sdk`、`session-manager`、`muad-progress` 等
- Skill seeds/templates: `skills/`
- Deploy: `Dockerfile`、`entrypoint.sh`、`build/helm-build/`、`compose.template.yml`

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
| `tools/muad-runtime-guard/src/long-task-command-policy.mjs` | 长任务前台命令判定（Shell AST：cd/包装器/find -exec/awk/sed） |
| `tools/muad-runtime-guard/src/long-task-cancel-state.mjs` | 长任务取消状态（0600 JSONL、单调 revision、取消墓碑） |
| `tools/session-manager/` | 业务平台会话/凭证解析 |
| `tools/muad-skill-sdk/` | Skill Python SDK（requests 透传、审计、限额、业务主机 requests compat） |
| `tools/muad-progress/` | 进度 CLI（Go） |
| `skills/` | system skill 种子与开发模板 |
| `skills/self-skill-review/` | 用户自建 Skill 只读审查（确定性检查 + 语义审查） |
| `build/helm-build/` | Console Helm chart（内网部署） |

## Module Map

```
bin/                 # Node runtime helpers + tests
tools/
├── muad-run-skill/  # skill runner plugin
├── muad-runtime-guard/
├── session-manager/
├── muad-skill-sdk/  # Skill Python SDK
├── muad-progress/   # Go progress + skill-check
├── progress-adapters/
└── shared/               # shared-lease-queue + notify-user
skills/              # seeds + _templates（含 self-skill-review）
build/helm-build/ Dockerfile entrypoint.sh
```

## Related Domains

- 控制面 API/apply 编排：`backend`
- 管理台 UI：`frontend`

---
id: runtime-directory-structure
description: 新建/移动 Worker 运行时、bin、tools、skills 文件时的目录约束
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-runtime-directory-001
    type: manual
    config:
      checklist: Confirm runtime code stays in bin/tools/skills/k8s and does not fork OpenClaw upstream into this tree.
      owner: project-owner
---

# Runtime Directory Structure

## Examples

✅ Skill 执行逻辑放 tools，控制面只编排

```text
tools/muad-run-skill/src/runner.mjs
console/backend/internal/runtimeapply/  # 触发 apply，不复制 runner
```

❌ 在 console/backend 复制一整份 skill runner

```go
// internal/api 内嵌 node skill 引擎副本
```

## Rules
- [RULE-runtime-directory-001] Worker/runtime assets must live under `bin/`, `tools/`, `skills/`, `seed/`, `k8s/`, or image entrypoints; do not vendor or fork OpenClaw upstream source into this repository.

## Guidance
- `bin/`：镜像内 CLI/注入/事务脚本及其 `bin/test`
- `tools/`：可独立测试的插件与适配器（Node/Go）
- `skills/`：内置 skill 种子与 `_templates`；运行态 public/private 由 Console 管理
- 部署清单放 `k8s/` 与 compose 模板，不把集群专用路径写死进业务代码
- 新增工具优先自包含 package（自有 package.json/go.mod + test）

## Patterns
- 控制面改行为 → backend；Worker 内执行 → tools/bin
- Skill 模板变更同步 `skills/README.md` 与检查器

## Avoid
- 禁止把 OpenClaw 上游 clone 进仓库当可改源码
- 禁止在 `users/` 或运行数据目录提交真实用户状态
- 禁止 skill 脚本散落仓库根目录

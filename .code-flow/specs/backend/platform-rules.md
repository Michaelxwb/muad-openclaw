---
id: backend-platform-rules
description: Console API、多用户隔离、模型池、Skill 与运行时编排平台规则
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-backend-platform-001
    type: manual
    config:
      checklist: Confirm multi-user isolation, model binding, writeJSON/writeErr, secret handling, and runtime apply semantics.
      owner: project-owner
  - rule: RULE-backend-http-envelope-001
    type: regex
    config:
      pattern: "json\\.NewEncoder\\("
      files:
        - console/backend/internal/api/**
      message: "HTTP 输出必须走 writeJSON/writeErr，禁止 json.NewEncoder"
  - rule: RULE-backend-model-pool-001
    type: manual
    config:
      checklist: Confirm CreateHumanUser binds unbound model_config_id and conflicts on already-bound models with no override fallback.
      owner: project-owner
---

# Backend Platform Rules

## Examples

✅ 统一错误输出 + 稳定 code

```go
writeErr(w, r, errcode.ConflictLLMModelBound)
writeJSON(w, http.StatusOK, data)
```

❌ handler 手写杂散 JSON

```go
json.NewEncoder(w).Encode(map[string]any{"error": "bad"})
```

✅ 创建用户绑定未占用模型

```go
// CreateHumanUser 校验 model_config_id 未被占用，否则 ErrLLMModelAlreadyBound
```

## Rules
- [RULE-backend-platform-001] Control-plane changes must preserve multi-user isolation, mandatory model-pool binding, secret-not-in-image injection, and generation-based runtime apply with health/rollback semantics.
- [RULE-backend-http-envelope-001] All Console HTTP handlers must emit responses via `writeJSON` / `writeErr` with stable `code*` constants; do not call `json.NewEncoder` (or ad-hoc maps) in handlers.
- [RULE-backend-model-pool-001] Creating a Human User requires binding an unbound `model_config_id`; already-bound models must fail with a conflict (`ErrLLMModelAlreadyBound` / API conflict). No implicit shared or override model fallback chain.

## Guidance
- **不 fork OpenClaw**：能力通过控制面、runtime 配置与外置插件扩展
- **多用户隔离**：用户级 Agent/会话/浏览器 Profile/模型/私有状态不得串扰；Pod 容量由管理员策略约束
- **模型池**：创建用户必须绑定未占用模型配置；禁止隐式全局/Pod/用户 override 回退链
- **IM 身份**：wecom / openclaw-weixin；已知 External ID 直接绑定，未知走一次性绑定码
- **Skill**：system/public/private 分层；public 需显式应用到 Pod；private 装目标用户工作区；同名冲突默认不静默覆盖
- **Public Skill 同步（单路径）**：console 直写共享存储（k8s RWX PVC / 本地 hostPath）生成 active 视图（`.muad-active-public-skills`），worker 只读 subPath 挂载；禁止创建临时 Pod 中转
- **Skill 删除走显式 remove-index**：仅 disabled/deleted 的 skill 进删除列表；同步失败的 active skill 保留磁盘 last-good，不删除
- **ManifestHash = 主 Skill 目录内容 hash**：Go 与 JS 算法须逐字节一致（同文件集、忽略 `.`/node_modules/__pycache__、拒 symlink、`path+\0+content+\0`、`sha256:` 前缀）；脚本变而 SKILL.md 不变必须触发重装，两端算法漂移会破坏重装检测
- **Skill 同步 partial 失败降级**：单个 skill 同步失败 → 跳过并记 warning（reload 响应带 `warnings` 透传前端），不阻断整批 apply 与 private 同步；仅驱动层失败才返回 error
- **凭证**：通道/LLM/service token 运行时注入，禁止写入镜像或入库明文可逆存储而不经 crypto；业务平台用户凭证按产品决策存入 `user_platform_credentials.credentials_json` 明文 JSON 便于排障，管理员的人用户平台凭证列表/详情 API 可返回明文用于查看和覆盖，但禁止进入镜像、审计/日志明文或暴露给 LLM
- **Runtime apply**：经 `runtimeconfig` + `runtimeapply`，带 generation、分 stage、失败可回滚；不要在 handler 里半套 apply
- 错误码统一经 `internal/errcode` 定义（一场景一码、按业务块分段），`api/errors.go` 的 `errorCatalog` 提供 zh/en 文案与 HTTP status；用户 message 稳定、可本地化理解
- 健康检查与业务鉴权分离

## Patterns
- 新平台能力先扩 registry/repo，再暴露 api，最后才动 driver
- repo 层 sentinel error → `errors.go` / handler 映射到 HTTP code
- 破坏性 API 变更走显式版本或兼容窗口

## Avoid
- 禁止把密钥写进 Dockerfile、compose、k8s manifest 明文
- 禁止跨用户复用同一浏览器 profile / 工作区路径
- 禁止 apply 成功写 generation 但跳过健康检查
- 禁止 public skill 状态变更后假定已自动同步到全部 Pod
- 禁止创建用户时复用已绑定模型或静默改绑

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
writeErr(w, http.StatusConflict, codeConflict, "LLM model is already bound")
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
- **凭证**：通道/LLM/平台 API Key/service token 运行时注入，禁止写入镜像或入库明文可逆存储而不经 crypto
- **Runtime apply**：经 `runtimeconfig` + `runtimeapply`，带 generation、分 stage、失败可回滚；不要在 handler 里半套 apply
- 错误码保持项目约定（客户端/服务端分段 + 场景子码）；用户 message 稳定、可本地化理解
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

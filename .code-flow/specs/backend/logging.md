---
id: backend-logging
description: Console 后端日志/审计/监控相关改动时适用
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-backend-logging-001
    type: manual
    config:
      checklist: Confirm structured logs, RedactDiagnostic on stored/logged errors, no secrets, audit vs skill-execution separation.
      owner: project-owner
  - rule: RULE-backend-redact-001
    type: manual
    config:
      checklist: Confirm error strings persisted to logs/audit/apply failures use auditlog.RedactDiagnostic first.
      owner: project-owner
---

# Backend Logging

## Examples

✅ 结构化字段 + 脱敏后再落库/日志

```go
_ = s.store.FailPodConfigApply(podID, gen, auditlog.RedactDiagnostic(err.Error()))
log.Printf("pod_upgrade_rollback_failed pod=%s error=%s", podID, auditlog.RedactDiagnostic(err.Error()))
```

❌ 打印 token / 未脱敏 error

```go
log.Printf("auth header=%s", r.Header.Get("Authorization"))
_ = s.store.FailPodConfigApply(podID, gen, err.Error()) // 可能含敏感上下文
```

## Rules
- [RULE-backend-logging-001] Logs and audit records must be structured enough to debug, must never include secrets/credentials, and must keep operation audit separate from skill-execution telemetry.
- [RULE-backend-redact-001] Error strings written to logs, audit details, apply-failure fields, or user-visible diagnostics that may embed internal context must pass `auditlog.RedactDiagnostic` (or equivalent redaction) before persistence or emission.

## Guidance
- 使用项目既有 logging 工具（如 `internal/logging` daily writer），保持字段命名稳定：`pod_id`、`user_id`、`request_id`、`route`、`status`、`latency`
- 错误日志保留错误链；不要只打 `"failed"`
- 操作审计走 `internal/audit`；Skill 执行日志走独立查询面，禁止混表混接口糊成一团
- 凭证、binding code、LLM key、service token 禁止进日志/审计明文
- 请求日志避免记录完整 body 若可能含密钥
- Skill execution / audit 查询侧只返回已 redacted 摘要

## Patterns
- handler 入口记录关键 id，apply 流水按 stage 打点
- 用户可见错误 message 与内部 err 分离；内部 err 落库前 Redact
- repo 模型注释明确 “already-redacted payload”

## Avoid
- 禁止 `print` 调试残留
- 禁止把密钥写入 `console/backend/logs/` 或响应
- 禁止用操作审计表塞 Skill 进度刷屏事件
- 禁止把未脱敏的 driver/gateway 错误原文直接写入 apply error 字段

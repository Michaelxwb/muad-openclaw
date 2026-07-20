---
id: backend-code-quality-performance
description: Console 后端错误处理、测试、超时与性能约束
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-backend-quality-001
    type: manual
    config:
      checklist: Confirm explicit errors, context timeouts, and go test/vet expectations.
      owner: project-owner
---

# Backend Code Quality & Performance

## Examples

✅ 错误包装 + context 超时

```go
ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
defer cancel()
if err := s.operations.Run(ctx, podID); err != nil {
    return fmt.Errorf("pod op: %w", err)
}
```

❌ 忽略 error / 无超时

```go
s.drv.Exec(context.Background(), podID, "sh", "-c", cmd) // 无超时
_ = err
```

## Rules
- [RULE-backend-quality-001] Backend changes must handle errors explicitly, bound remote/runtime calls with context deadlines, and keep `go vet` / `go test` green for touched packages when run in the project validators.

## Guidance
- 所有 `error` 必须检查；向用户返回稳定 code/message，内部保留 `%w`
- 调 driver/gateway/LLM probe 必须带 timeout/cancel
- 单元测试覆盖：repo 边界、binding limiter、runtimeapply stage、关键 API
- 避免在请求路径做无界全表扫描或同步扫全部 Pod 文件系统
- CPU/IO 重任务放到后台 worker/enqueue（如 reconcile），不要堵死 HTTP

## Patterns
- table-driven tests
- fake Driver 注入 apply/coordinator 测试
- 关键路径先写失败用例再实现

## Avoid
- 禁止裸 `_ = err` 吞失败
- 禁止无限重试无 backoff
- 禁止在热路径打巨大 JSON debug

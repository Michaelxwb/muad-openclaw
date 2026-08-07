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
  - rule: RULE-backend-write-err-001
    type: regex
    config:
      pattern: 'writeErr\([^)]*"[^")]*"'
      files:
        - console/backend/internal/api/**
      message: "writeErr 只传 errcode 常量，禁止字符串 message（旧签名残留）"
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
- [RULE-backend-write-err-001] HTTP 错误响应必须走 `writeErr` / `writeRuntimeFailure` / `writeRepoError` 且只传 `errcode` 常量；禁止旧签名 `writeErr(w, r, status, code, msg)` 或传字符串 message。

## Guidance
- 所有 `error` 必须检查；向用户返回稳定 code/message，内部保留 `%w`
- 调 driver/gateway/LLM probe 必须带 timeout/cancel
- 单元测试覆盖：repo 边界、binding limiter、runtimeapply stage、关键 API
- 避免在请求路径做无界全表扫描或同步扫全部 Pod 文件系统
- CPU/IO 重任务放到后台 worker/enqueue（如 reconcile），不要堵死 HTTP
- 错误码是一场景一码的稳定契约：常量定义在 `internal/errcode`，按业务块分段（400xx 通用 / 401xx 认证 / 402xx 用户 / … / 503xx 依赖）；code 与 HTTP status 解耦（status 存于 `api` 的 `errorCatalog` 连同 zh/en 文案）
- 新增错误场景：在 `internal/errcode` 业务块内递增新常量 → `api/errors.go` 的 `errorCatalog` 补 `{httpStatus, zh, en}` → 追加进 `errcode.AllCodes`；守卫测试 `TestErrorCatalogCoversAllCodes` 双向校验
- 禁止复用/改号已有 code：前端硬编码 40101（登录失败）/ 42901（登录限流）依赖契约
- repo 层 sentinel 统一 `&Error{Code: errcode.X, Msg: "repo: ..."}` 携带 code，handler 侧 `writeRepoError` 单次 `errors.As` 映射；多态语义（如绑定码 scope/expired/used/revoked）才在 handler 用 `errors.Is` 分支区分
- 技术细节只进 `detail` 字段并经 `auditlog.RedactDiagnostic` 脱敏，`message` 始终是本地化友好文案；`requestId` 由 `writeErrorEnvelope` 统一附加
- `writeErr` 按 `Accept-Language`（zh* → zh，其余 → en，缺省 zh）渲染 zh/en 文案

## Patterns
- table-driven tests
- fake Driver 注入 apply/coordinator 测试
- 关键路径先写失败用例再实现
- 错误响应统一走 `writeErr` / `writeRuntimeFailure` / `writeRepoError`，禁止 handler 手写 `json.NewEncoder` 错误响应

## Avoid
- 禁止裸 `_ = err` 吞失败
- 禁止无限重试无 backoff
- 禁止在热路径打巨大 JSON debug
- 禁止 `writeErr(w, r, status, code, msg)` 旧签名或传字符串 message —— `writeErr` 只接受 `errcode` 常量
- 禁止复用/改号已有错误码、禁止让两个不同场景共用同一 code

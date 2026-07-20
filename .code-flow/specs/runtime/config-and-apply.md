---
id: runtime-config-and-apply
description: 多用户 runtime 配置渲染、schema 与事务 apply
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-runtime-config-001
    type: manual
    config:
      checklist: Confirm validateRuntimeConfig, transactional apply stages, generation, and rollback/health behavior.
      owner: project-owner
  - rule: RULE-runtime-validate-before-write-001
    type: manual
    config:
      checklist: Confirm renderer/inject calls validateRuntimeConfig before atomic write and carries monotonic generation.
      owner: project-owner
---

# Runtime Config And Apply

## Examples

✅ 先校验 schema，再事务分 stage

```text
validateRuntimeConfig(dto)
prepare → validate → commit → restart? → health
失败：回滚到上一 generation，不留半截配置
```

```js
validateRuntimeConfig(runtime);
writeFileSync(temporary, contents, { mode: 0o600 });
// atomic rename
```

❌ 直接覆盖配置文件无校验

```js
fs.writeFileSync(target, nextConfig) // 无 backup / validate / generation
```

## Rules
- [RULE-runtime-config-001] Runtime configuration changes must validate against schema, apply through the transactional pipeline (`runtime-config-transaction` / control-plane `runtimeapply`), and preserve rollback or failed-health recovery.
- [RULE-runtime-validate-before-write-001] Any renderer/inject path that materializes runtime config must call `validateRuntimeConfig` (or shared schema helper) before atomic write; desired state carries a monotonic `generation`.

## Guidance
- schema 定义以 `bin/runtime-config-schema.mjs` 与 backend `runtimeconfig` 为准，两侧语义保持一致
- renderer 输出确定性；相同输入 → 相同 config bytes（便于 generation 对比）
- apply 必须可观测 stage；健康检查失败不得标记成功
- 重启策略（none/gateway/pod）显式选择，禁止隐式乱重启
- 变更 inject/renderer 时同步更新 `bin/test`
- 落盘使用临时文件 + rename，mode `0o600`

## Patterns
- 控制面构建 desired DTO，Worker 执行 transaction script
- 用 generation 单调递增检测漂移与冲突（generation conflict）

## Avoid
- 禁止跳过 validate 直接 commit
- 禁止成功写 generation 但 health 失败仍对外报成功
- 禁止手工改容器内 config 绕过控制面（除紧急只读排障）

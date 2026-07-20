---
id: runtime-skill-execution
description: Skill 分层、激活执行、进度 telemetry 与并发约束
stages: [design, plan, code, review]
enforcement: required
verifiers:
  - rule: RULE-runtime-skill-001
    type: manual
    config:
      checklist: Confirm skill layering, system protection, activation gates, progress events, and concurrency limits.
      owner: project-owner
  - rule: RULE-runtime-skill-layering-001
    type: manual
    config:
      checklist: Confirm system-first resolution, system_protected, and no silent public/private overwrite without allow_override.
      owner: project-owner
---

# Runtime Skill Execution

## Examples

✅ 分层与冲突策略

```text
system (system_protected) 优先且不可被用户卸载/静默覆盖
public vs private 同名：默认冲突失败
仅 SkillPolicyAllowOverride / allow_override 时 private 可覆盖 public
```

❌ 同名 private 静默盖掉 system

```text
install private "web-tools-guide" over system seed without error
```

## Rules
- [RULE-runtime-skill-001] Skills must honor system/public/private layering, require explicit activation/policy gates before tools run, emit progress/telemetry without secrets, and respect concurrency/lease limits.
- [RULE-runtime-skill-layering-001] Resolution order prefers system (`system_protected`) over public/private; public/private name conflicts must not silently overwrite—override only via explicit allow_override policy.

## Guidance
- `SKILL.md` 为最小必需；`muad.skill.json` 为 managed 编排增强
- 分类：managed / traditional-script / traditional-prompt（见 `skills/README.md`）
- 执行入口：`tools/muad-run-skill`（activation、hook lifecycle、outbox、telemetry、manifest 选择）
- Public skill 需控制面“应用”并标记 Pod 后才期望在运行中 Pod 生效；Private 装目标用户工作区
- 进度经 `muad-progress` / adapters 上报；终态、耗时、失败摘要可查询且 redacted
- 浏览器/工具并发走 lease/queue（`runtime-concurrency`、runtime-guard）

## Patterns
- 先 policy/activation gate，再 runner
- 长任务用 progress 事件，不堵死主会话
- 模板变更放 `skills/_templates`，种子放 `skills/<name>`
- repo 查询 system/public 时 `ORDER BY CASE scope WHEN 'system' THEN 0 ELSE 1 END`

## Avoid
- 禁止 system skill 被用户卸载或静默覆盖
- 禁止执行日志写入密钥或完整 cookie
- 禁止无并发上限地并行打开浏览器会话
- 禁止 private 默认覆盖 public/system

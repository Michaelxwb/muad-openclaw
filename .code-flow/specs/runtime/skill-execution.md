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
  - rule: RULE-runtime-log-injection-001
    type: manual
    config:
      checklist: Confirm tool/plugin modules inject `log` (default no-op) instead of scattered console.*; plugin path uses api.logger.warn, CLI path uses console.warn.
      owner: project-owner
  - rule: RULE-runtime-log-prefix-001
    type: manual
    config:
      checklist: Confirm log lines carry a stable module prefix ([session-manager]/[muad-runtime-guard]) and [<module>-<action>] sub-tags.
      owner: project-owner
  - rule: RULE-runtime-skill-fail-loud-001
    type: manual
    config:
      checklist: Confirm skill scripts write failures to stderr and exit non-zero; stdout reserved for machine-readable result.
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

✅ 失败写 stderr + exit 非 0（fail loud）

```js
process.stderr.write(`${error.message}\n`);
process.exitCode = 1;
```

❌ 失败写 stdout（exec 失败日志转发不到，guard hook 只读 stderr）

```python
def _die(message):
    print(f"[ERROR] {message}")   # ← 写 stdout，排查时日志进不了 openclaw 日志
    sys.exit(1)
```

## Rules
- [RULE-runtime-skill-001] Skills must honor system/public/private layering, require explicit activation/policy gates before tools run, emit progress/telemetry without secrets, and respect concurrency/lease limits.
- [RULE-runtime-skill-layering-001] Resolution order prefers system (`system_protected`) over public/private; public/private name conflicts must not silently overwrite—override only via explicit allow_override policy.
- [RULE-runtime-log-injection-001] Tool/plugin modules must receive logging via an injected `log` callback (default no-op) instead of scattered `console.*`; the openclaw plugin path injects `api.logger?.warn`, the CLI path injects `console.warn`.
- [RULE-runtime-log-prefix-001] Log lines must carry a stable module prefix (`[session-manager]`, `[muad-runtime-guard]`) with `[<module>-<action>]` sub-tags for grep-ability.
- [RULE-runtime-skill-fail-loud-001] Skill scripts must report failures to stderr and exit non-zero (fail loud); stdout is reserved for the machine-readable result. Errors written to stdout break exec-failure log forwarding.

## Guidance
- `SKILL.md` 为最小必需；`muad.skill.json` 为 managed 编排增强
- 分类：managed / traditional-script / traditional-prompt（见 `skills/README.md`）
- 执行入口：`tools/muad-run-skill`（activation、hook lifecycle、outbox、telemetry、manifest 选择）
- Public skill 需控制面“应用”并标记 Pod 后才期望在运行中 Pod 生效；Private 装目标用户工作区
- 进度经 `muad-progress` / adapters 上报；终态、耗时、失败摘要可查询且 redacted
- 浏览器/工具并发走 lease/queue（`tools/shared` 的 shared-lease-queue、runtime-guard）

## Patterns
- 先 policy/activation gate，再 runner
- 长任务用 progress 事件，不堵死主会话
- 模板变更放 `skills/_templates`，种子放 `skills/<name>`
- repo 查询 system/public 时 `ORDER BY CASE scope WHEN 'system' THEN 0 ELSE 1 END`
- 匹配/授权来源以可信入站消息为准：`explicit_name` 只认本轮用户明确命令（`/skill:<name>` 或展开的 skill 标记），runtime preflight 复核，模型自报即拒（`explicit_name_untrusted`）；“参考”文档不授权执行被参考 Skill
- 取消运行语义：`aborted`（接受）≠ `drained`（原生清理）≠ 进程已退出；只有真实退出才确认停止，只对本 Worker detached 进程组补发终止（best-effort，不作为停止证据），禁止 `forceClear`
- 取消后关闭目标任务会话的新工具调用；终态只释放目标任务租约（`releaseSession`，幂等，未持有 no-op），取消中占槽不提前释放
- 进度桥取消语义：拒绝迟到事件（`execution_cancelled`）、丢弃未发起队列、在途发送保留可解释边界、终态结算最多一次且不发送成功/失败类消息
- 结果投递由 manager 仲裁：子 CLI 不再 `--deliver`（stdout 持续消费 + 有界缓冲解析 `result.payloads`）；取消已提交的任务不新发成功结果或通用失败通知，许可发起即视为在途
- 内部取消 RPC 仅 `operator.write`（绝不注册为模型工具）；能力只在取消链完整（manager 可取消 + 原生 abort/drain 可用）时上报，缺失明确不可用、不危险兜底

## Avoid
- 禁止 system skill 被用户卸载或静默覆盖
- 禁止执行日志写入密钥或完整 cookie
- 禁止无并发上限地并行打开浏览器会话
- 禁止 private 默认覆盖 public/system
- 禁止在工具/插件模块散落 `console.*`（应走注入的 `log`）
- 禁止 skill 脚本把失败信息写 stdout（应写 stderr 并 exit 非 0）

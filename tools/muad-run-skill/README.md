# muad-run-skill

`muad-run-skill` 是外置 OpenClaw 插件，负责统一的 Skill 激活、受控脚本执行、进度投递和执行审计。它只使用 OpenClaw 公开 Tool/Hook API，不修改上游源码，也不为每个 Skill 注册独立 Tool。

## 支持的 Skill

| entryType | 判定 | 执行方式 |
|-----------|------|----------|
| `managed` | 存在合法 `muad.skill.json` | `muad_run_skill` 按 steps 或 entrypoint 执行 |
| `traditional-script` | 无 manifest，扫描到脚本 | 激活后通过相对 `script_path + argv` 执行 |
| `traditional-prompt` | 无 manifest，只有指令或原生工具流程 | 激活后由 Agent 调用 browser/read 等 OpenClaw 工具 |

`SKILL.md` 必需，`muad.skill.json` 可选。

## 激活边界

Skill 激活只属于当前用户消息轮次：

1. Agent 读取 Runtime Config 授权清单中精确的 `<root>/SKILL.md`。
2. Hook 校验路径与当前 Agent grant，创建 executionId，`activationMode=path-detected`。
3. 原生读取不可用时，Agent 调用 `muad_use_skill`，`activationMode=tool`。
4. 当前轮的后续工具进度归入该执行；新用户消息必须重新激活。

Prompt 只能指导模型，不能形成确定性边界。对于 frontmatter `description` 中声明：

```yaml
description: "MANDATORY before calling web_search, web_fetch, browser, or opencli."
```

插件会在 `before_tool_call` 检查当前轮是否已有激活 Skill。未激活时阻断声明的工具，返回匹配 Skill 的精确 `SKILL.md` 路径；读取或调用 `muad_use_skill` 后重试才放行。门禁不依赖 `muad.skill.json`，也不从 Skill 正文中的偶然工具名推断要求。

## Tools

插件注册两个通用 Tool：

```text
muad_use_skill(skill_name, input_summary?)
muad_run_skill(skill_name, input?, script_path?, args?)
```

### `muad_use_skill`

- 校验当前 Agent 是否拥有对应 grant。
- 读取授权根内的 `SKILL.md`，返回指令、scope、version、entryType 和脚本清单。
- 未授权、内容缺失或请求非法时创建 `rejected` 执行记录，不泄露 Skill 内容。

### `muad_run_skill`

- managed Skill：加载 `muad.skill.json` 并执行 steps/entrypoint。
- traditional-script：只允许 Runtime Config 下发的 `scriptFiles`，使用相对脚本路径和 argv。
- traditional-prompt 不可直接作为脚本运行，继续使用原生工具路径。

运行时从可信 Tool Context 注入 `MUAD_AGENT_ID`、`MUAD_SESSION_KEY` 和 `MUAD_WORKSPACE_DIR`，不接受脚本或用户输入伪造这些值。

## Managed manifest

Steps 模式由 runner 生成粗粒度进度：

```json
{
  "name": "example-long-task",
  "runtime": "script",
  "mode": "steps",
  "steps": [
    { "id": "auth", "title": "鉴权", "command": ["bash", "scripts/auth.sh"] },
    { "id": "query", "title": "查询", "command": ["python3", "scripts/query.py"] }
  ]
}
```

Entrypoint 模式允许一个上层脚本调用多个子脚本，并通过 `muad-progress` 主动上报业务阶段：

```json
{
  "name": "example-long-task",
  "runtime": "script",
  "mode": "entrypoint",
  "entrypoint": ["bash", "scripts/run.sh"],
  "steps": [
    { "id": "auth", "title": "鉴权" },
    { "id": "query", "title": "查询" }
  ]
}
```

解释器仅允许 `bash`、`sh`、`python3` 和 `node`。绝对路径、`..`、隐藏路径、未声明脚本、目录及符号链接逃逸都会被拒绝；runner 不启用 shell 字符串拼接。

## Public / Private grant

- Public Skill 根目录默认为 `/opt/openclaw-skills`。
- Private Skill 根目录来自当前 Agent 的可信 `<workspace>/skills`。
- Runtime Config 为每个 Agent 下发最终有效 grant，包括 name、source、skillId、version、entryType、rootPath 和 scriptFiles。
- system Skill 优先；public/private 同名需显式 `allow_override` 策略，不能静默覆盖。
- Runtime Guard 仅允许业务 Agent 只读自身工作区和当前 grant 根目录。

## 生命周期审计

插件通过公开 Hook 维护 Run 级上下文：

```text
Skill activation
  → running(seq=1)
  → before/after_tool_call progress(seq=N)
  → agent_end / runner terminal(seq=N+1)
```

执行快照异步上报 Console `/internal/v1/skill-executions`：

- 每次执行使用唯一 executionId 和递增 eventSeq。
- 工具单次失败记录为 `tool-failed` 过程，不提前关闭执行；最终状态由 Agent/Runner 结束决定。
- 同一 Run 切换 Skill 时，前一个执行以 `handoff` 关闭。
- 摘要、错误和进度在持久化前统一截断并脱敏。
- Console 不可用时写入 state PVC 中的 NDJSON outbox，恢复后幂等重放。
- outbox pending/write failed 会进入 Runtime Guard 健康结果和 Console 告警。

操作审计与执行审计严格分离：Skill 上传、启禁用、删除和应用属于操作审计；Agent 实际运行属于 Skill 执行日志。

## 进度与最终回复

`muad-progress` 是由 Shell、Python、TypeScript 或 Go 脚本调用的语言无关 CLI；`muad-run-skill` 持有可信会话上下文并把进度作为独立消息投递。

进度只表示已知业务阶段，不能替代 OpenClaw 原生最终回复。最终回复仍可完整携带文本、附件、图片或卡片。

## 并发

Pod 级 `SharedSkillQueue` 使用 Runtime Config 下发的：

- `maxConcurrency`
- `queueTimeoutMs`
- `maxQueue`

队列满或等待超时返回稳定错误 `skill_busy`，不会无限创建子进程。传统 prompt-only Skill 使用原生工具，不占脚本并发槽；browser 并发由 Runtime Guard 单独限制。

## 插件配置

主要配置由 Console Runtime Config 生成：

```json
{
  "skillsRoot": "/opt/openclaw-skills",
  "maxConcurrency": 2,
  "skillPolicies": [],
  "activation": {
    "requireBeforeExecution": true,
    "detectSkillFileReads": true
  },
  "telemetry": {
    "consoleInternalURL": "http://muad-console:8080",
    "serviceTokenFile": "/run/secrets/muad/pod-service-token",
    "outboxPath": "/home/node/.openclaw/muad/skill-execution-outbox.ndjson"
  }
}
```

不要手工在 Worker 中维护 `skillPolicies`；其内容必须来自控制面 resolver。

## 测试

```bash
cd tools/muad-run-skill
npm test
```

测试覆盖 grant、逐轮激活、mandatory tool 门禁、Hook 生命周期、managed/traditional 执行、路径逃逸、并发、进度、脱敏、outbox 和恢复重放。

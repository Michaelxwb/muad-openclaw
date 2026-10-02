# 长任务 Skill 显式预检与异步执行

适用于配套更新的 muad-runtime-guard 插件与 Worker 固定指导。普通 Skill 保留原生激活机制。

## 执行边界

用户请求 → 按 available_skills 筛选 → 当前轮 read SKILL.md → 匹配和参数预检 → muad_submit_long_task → 现有队列 → 后台独立 Agent 会话 → 原有 IM 结果投递。

- 唯一明确匹配、输入完整时直接提交，无需二次确认。
- 多个合理候选，先列出区别让用户选择；无适用 Skill，说明缺少能力。
- SKILL.md 定义脚本调用及必填参数。只有客户名称但要求 customerId 时立即追问，不猜、不启动后台探查。只有文档明确提供名称解析方法才查询；多结果选择、无结果追问。
- 文档明确无参允许执行；未说明或矛盾先澄清。
- `/skill:<name>` 仅指定 Skill，仍须本轮读文档和参数预检。
- read 说明、脚本及引用文件不提交、不登记长任务执行、不发进度。成功 read 后只记录短期文档版本；失败 read 不算预检。
- 前台 exec/bash 命中授权长任务脚本仅 block，提示使用提交工具；ls/cat/grep 等查看放行。不自动入队，不转前台 fallback。命令路径检测不承诺识别任意混淆 shell。

旧 read-to-enqueue、提交桩、回复改写与斜杠瞬时提交已移除。不得只改 prompt 而保留旧 hook。

## 提交契约

```json
{
  "skillName": "quarterly-report",
  "objective": "为客户生成本季度报告",
  "selectionBasis": "unique_match",
  "requiredNames": ["customerId"],
  "bindings": [{"name":"customerId","value":"customer-123","source":"user_message"}]
}
```

selectionBasis 可取 unique_match/user_choice/explicit_name；source 可取 user_message/conversation/document_default/document_resolution。未知字段拒绝，模型不能传 agentId/sessionKey/peerId/rootPath/投递目标。身份取可信工具上下文，本轮读取与当前 effective grant 再校验；system 优先与已有显式覆盖策略保持。

成功返回 accepted、taskId、skillName、queuedAhead、active、queued。相同可信 agent/session/run 重试使用同taskId；同轮另一个 Skill 拒绝，新轮可以再提交。

失败返回 rejected 与 reason：skill_not_authorized、context_unavailable、documentation_not_read、documentation_changed、invalid_input、missing_input、queue_unavailable。缺参结果可含 missingNames；状态写入失败或队列关闭明确失败，不声称已启动、不前台执行。

代码只检查模型声明的 requiredNames 都有非空值，不能证明声明覆盖文档要求、值语义正确或用户真正选择过。匹配和参数理解依赖固定指导、文档质量及真实模型验收。

## 队列、审计与隔离

复用 LongTaskManager，池按 agent/channel/peer 隔离，限额沿 maxLongTasksPerUserAgent。任务会话 `agent:<agentId>:longtask:<taskId>` 使用独立 lane，复用业务 Agent workspace、模型及授权。保持已有共享执行租约与失败投递；前台长任务预检不占执行租约。

排队形成队列状态，实际后台 run 开始才登记审计，executionId=taskId；后台重复 read 不重复登记，伪造或非running任务会话不登记。进度沿 SkillProgressManager 背景注册与原有执行接口，不因前台查看注册。

任务增加可选 executionInputs（requiredNames/bindings），连同原请求和最终目标保存在既有0600状态JSONL；公共快照不暴露参数值。后台消息使用最终绑定，发现遗漏明确失败，不改ID自动重试。读取记录按agent/session/run/授权root隔离、有TTL和数量上限，turn结束清理。

旧队列记录无executionInputs仍按既有中断恢复逻辑处理。已有running任务不因新规则取消；旧误提交任务由管理员决定处理，变更不追溯撤销。

## 发布与回滚

K8s/Docker使用相同Worker插件，不改卷结构或数据库。必须配套更新Worker镜像与renderer固定指导；新工具加入业务Agent allowlist与全局alsoAllow，main deny。不得恢复废弃muad_use_skill/muad_run_skill。

配置继续经 runtime DTO/schema → prepare/validate/commit → generation与health/rollback；不直接覆盖生产配置。检查当前OpenClaw版本的registerTool上下文、after_tool_call与实际工具可见性。

回滚旧镜像/指导会恢复旧读取触发行为；工作区与旧队列数据保留。发布前执行真实模型终验：唯一匹配、多候选、缺参、生产误触发等价场景，以及控制面应用、健康失败回滚。编码期仅功能测试，E2E登记后由 cf-task-verify-e2e 执行。运行说明见 tools/muad-runtime-guard/skill-preflight-e2e.md。

# Skill 预检真实模型终验

编码期只运行 PreflightS13 fixture 校验。模型/部署场景使用 `env MUAD_PREFLIGHT_E2E=1 node --test --test-name-pattern PreflightS02 ...` 显式启用；没有环境配置将失败。普通 Node 单测 glob 只加载 E2E 模块，不注册或执行真实模型场景，不代表 E2E 通过。

## 准备真实环境

使用独立测试 Console/Worker、新镜像、真实工具模型及两个以上测试 IM 用户；不得使用真实客户收件人或 fake OpenClaw/model。测试命令在能访问 Console 与 Worker 的机器执行。默认本机 Worker CLI；远程可用 `workerExec` argv，例如 `["kubectl","exec","-n","muad","<test-pod>","--"]`。远程 Worker 的实际配置路径应已是默认配置路径（例如 `/state/openclaw.json`）；模型与通道凭证仍由控制面维护，勿写入测试产物。

按场景创建隔离业务 Agent（ID 以 preflight- 开头）及真正模型绑定，配置下表 Skill 授权。先在测试 Worker 的实际私有 Skill 根目录生成 fixture，再经 Console 的技能扫描/绑定/应用流程让 effective grants 生效。可在测试 PVC staging 生成并上传；部署后重新生成文档时用实际最终根路径，只有测试环境可这样准备数据。最终 SKILL.md 必须与生成文档一致，harness 会核验，不接受伪造队列/调用记录。

```js
import { writePreflightFixtures } from './test/skill-preflight-e2e-support.mjs';
writePreflightFixtures('/state/workspace-preflight-s02/skills');
```

脚本 `run.mjs` 为真实 Node 业务执行哨兵，输出 E2E_REPORT_RESULT 并写0600 business.jsonl。文档授权的名字查询脚本在 Skill 根目录的兄弟目录 `skills-evidence/lookup.mjs`，不属于长任务业务脚本；唯一客户→customer-123，同名客户→两条，不存在→空。该目录仅在测试用户workspace内，不共享给其他用户。

配置 `MUAD_PREFLIGHT_E2E_CONFIG` 指向0600 JSON文件（不要提交凭证）：

```json
{
  "isolated": true,
  "consoleURL": "http://test-console:8080",
  "consoleTokenFile": "/private/test-console-token",
  "podId": "preflight-test",
  "configPath": "/state/openclaw.json",
  "stateFile": "/tmp/muad-runtime-queues/long-task/state.jsonl",
  "workerExec": [],
  "cases": {
    "S02": {
      "agentId": "preflight-s02", "peerId": "test-user", "channel": "wecom",
      "root": "/state/workspace-preflight-s02/skills",
      "evidenceRoot": "/state/workspace-preflight-s02/skills-evidence",
      "workspace": "/state/workspace-preflight-s02",
      "sessionDir": "/state/agents/preflight-s02/sessions",
      "deliveriesFile": "/test-observer/received.jsonl",
      "skills": ["quarterly-report"]
    }
  }
}
```

`deliveriesFile` 必须由实际测试 IM 收件端接收后导出，JSONL每条含 `peerId`、`text`；不能由发送spy或测试自己写入。普通CLI前台输出不算后台实际投递。测试使用真实会话JSONL toolCall检查读取，真实manager状态文件检查任务数/最终参数；后台必须 succeeded 且哨兵恰好一次、实际投递有 taskId 与结果标记。每次执行前确保这些独立用户没有running/queued旧任务，保留日志作证据。

| case | 授权 Skill / 边界 |
|---|---|
| S02、S04、S08、E01、B02 | quarterly-report |
| S03、B01 | quarterly-report、quarterly-summary |
| S05-unique、S05-multiple、S05-none | lookup-report，每子场景独立用户 |
| B04-noarg / B04-unknown / B04-conflict | noarg-report / undocumented-report / conflicting-report，独立用户 |
| B01-other | 和B01不同用户、没有待选上下文 |
| S09 | quarterly-report；实际控制面应用及故障回滚专用用户 |

在不同case使用不同test peer，避免投递计数串扰。单场景命令一次执行一个文件；整体验收串行，不能并行改变同一个测试Worker配置。场景不清空历史队列或对话，通过基线delta计数；首次创建测试用户确保无旧候选，重复完整终验前新建测试用户/session或用新peer。

不同case必须使用独立Agent和workspace，避免共享记忆或测试文件影响匹配与参数判断。可以分布到多个真实Worker：在对应case中设置 `workerExec` argv覆盖全局值。所有配置、会话、队列和收件路径都在该case选定的Worker内读取；S09的Worker须与顶层Console `podId`一致。Worker升级会清空 `/tmp`，升级完成后重新部署收件观察器与私密IM客户端配置。

## 部署与回滚场景 S09

配置额外 `deployment` 对象，含 S09 隔离用户的 `humanUserId`，提供实际健康故障的 **Worker argv**：`breakHealthCommand`/`restoreHealthCommand`。应在专用Worker短时阻断guard健康而保持配置事务与CLI可观察；恢复命令必须幂等。没有故障命令明确失败，不能以假health函数代替。S09 先 PATCH 该用户的 prompt 推进真实 generation，finally 恢复原 prompt 并等待重新健康。

S09 调用真实 Console POST `/api/v1/containers/{podId}/apply-config`，等待appliedGeneration等于configGeneration与healthy；读取实际指导/配置、调用真实Worker工具目录确认业务工具可见、main不可用。再注入健康故障、重走控制面apply，观察failed与last-good配置恢复，finally恢复故障。保存Console apply状态、Worker previous/candidate/config哈希、实际工具目录和健康输出作为证据。运行前按当前OpenClaw版本确认 `gateway call tools.catalog --params` 输出包含工具，若版本不支持将明确失败，需要适配实际上游契约后再终验，不用静态配置替代工具可见性。

B02 配置顶层 `slashIngressCommand` argv：测试 Worker 可执行的真实 IM 发消息客户端，harness 追加 `[testPeerId, message]`。必须由实际测试 IM ingress 触发 channel before_dispatch；CLI agent 不等同 IM 分发。收件日志包含首轮追问、后续提交回执与后台结果，业务哨兵恰好一次。客户端凭证用私密运行时文件，没有该命令明确失败。

## 完成判定

真实模型可能违反语义规则；测试失败应保留输出、toolCalls、队列/查询/业务/投递delta，不修改期望或用fake模型转绿。S05/B01/B04含多个实际子场景，可耗时数分钟。E2E与规范人工验收由 cf-task-verify-e2e 统一收集；本轮fixture功能测试不构成模型效果或生产发布证明。

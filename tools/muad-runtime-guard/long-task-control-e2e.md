# 长任务取消与控制真实终验

编码期只运行 LongTaskControlS28 fixture 校验。真实模型/Worker/浏览器场景使用 `env MUAD_LONG_TASK_CONTROL_E2E=1 node --test --test-name-pattern ...` 显式启用；没有环境配置将失败。普通 Node 单测 glob 只加载 E2E 模块，不注册或执行真实场景，不代表 E2E 通过。

## 准备真实环境

使用独立测试 Console/Worker、固定版本 Worker、独占模型（同用户排队会互相干扰，每 case 独立用户与模型绑定）及两个以上测试 IM 收件人；不得使用真实客户收件人或 fake OpenClaw/model。测试命令在能访问 Console 与 Worker 的机器执行。默认本机 Worker CLI；远程可用 `workerExec` argv，例如 `["kubectl","exec","-n","muad","<test-pod>","--"]`；多 Worker 场景在对应 case 内覆盖 `workerExec`。远程 Worker 的实际配置路径应已是默认配置路径（例如 `/state/openclaw.json`）；模型与通道凭证仍由控制面维护，勿写入测试产物。

按场景创建隔离业务 Agent（ID 以 `longtask-` 开头）及独占模型绑定，配置下表 Skill 授权。先在测试 Worker 的实际私有 Skill 根目录生成 fixture，再经 Console 的技能扫描/绑定/应用流程让 effective grants 生效：

```js
import { writeLongTaskControlFixtures } from './test/long-task-control-e2e-support.mjs';
const fixture = writeLongTaskControlFixtures('/state/workspace-longtask-s06/skills');
```

fixture 内容（0600 文件；证据文件在 `skills-evidence/` 兄弟目录）：

- `cancel-long-task/run.mjs`（真实长时间脚本，必填 `--customer-id`，可选 `--ticks N`）：启动即把真实 pid 与真实子进程 pid 写入 `business-pids.jsonl`，每 200ms 追加业务计数到 `business.jsonl`（`kind=start/tick/result`，含 `MUAD_LONG_TASK_CONTROL_RESULT` 标记）。取消验收要求进程真实停止（双 pid 均不再存活）且业务计数不再增长；`--ticks` 用于自然完成场景。
- `alternate-long-task/run.mjs`：与取消哨兵行为一致的第二业务候选，用于 S-02 多候选选择（选择前零执行）。
- `queued-cancel/run.mjs`：排队取消哨兵，一旦执行即写业务行；S-05 要求零行、零任务、零投递。
- `reference-report/run.mjs`：S-03 其他长任务文档引用，只允许读取文档，业务脚本零执行。
- `company-label-server.mjs`：company_label 测试接口。启动：`COMPANY_LABEL_PORT=39127 node <evidenceRoot>/company-label-server.mjs`（仅 127.0.0.1）。每次访问追加 `company-label.jsonl`；S-03 要求恰好一次，无关 Skill 场景要求零增量。

配置 `MUAD_LONG_TASK_CONTROL_E2E_CONFIG` 指向 0600 JSON 文件（不要提交凭证）：

```json
{
  "isolated": true,
  "consoleURL": "http://test-console:8080",
  "consoleTokenFile": "/private/test-console-token",
  "podId": "longtask-test",
  "configPath": "/state/openclaw.json",
  "stateFile": "/tmp/muad-runtime-queues/long-task/state.jsonl",
  "workerExec": [],
  "cases": {
    "S06": {
      "agentId": "longtask-s06", "peerId": "test-user-a", "channel": "wecom",
      "root": "/state/workspace-longtask-s06/skills",
      "evidenceRoot": "/state/workspace-longtask-s06/skills-evidence",
      "workspace": "/state/workspace-longtask-s06",
      "sessionDir": "/state/agents/longtask-s06/sessions",
      "deliveriesFile": "/test-observer/received.jsonl",
      "skills": ["cancel-long-task"]
    }
  }
}
```

`deliveriesFile` 必须由实际测试 IM 收件端接收后导出，JSONL 每条含 `peerId`、`text`；不能由发送 spy 或测试自己写入。取消场景要求取消后**无新结果投递**（taskId 与结果标记零增量）；自然完成场景要求结果恰好投递一次。

## 观察断言与失败语义

harness（`long-task-control-e2e-support.mjs`）提供统一观察接口，全部读取真实证据，缺失即失败：

- `assertInstalled`：实际 Worker 配置里的 Agent/模型、longTaskSkillGrants 与 AGENTS.md 指导；不接受伪造配置。
- `assertProcessStopped`：必须存在真实 pid 记录（缺失 → `missing real process stop evidence`），且记录进程与子进程均不再存活；进程仍存活时明确失败（伪造停止不通过）。
- `assertZeroBusinessRows` / `assertBusinessStopped`：零执行与“计数不再增长”判据；发现意外执行为失败。
- `assertDeliveredOnce`：必须存在实际收件端导出的匹配记录且恰好一次。
- `consoleFetch`/`cancelTask`：真实 Console 请求返回原始 status 与包络（202 仅表达已接受，不冒充 cancelled）；`assertCancelResponse` 校验 outcome/taskStatus。
- 任务状态优先读 Worker 真实状态文件（`stateFile`）与 Console 列表；`waitForTask` 只接受声明的目标状态。

缺环境、缺 case、未就绪 Worker 或零匹配一律失败；不允许 fake 模型、跳过读取断言、放宽零执行要求或伪造通过。

## case 分组与登记命令

三个 E2E 文件由后续任务登记，命令均需 `MUAD_LONG_TASK_CONTROL_E2E=1`，工作目录 `.`：

| 文件 | 场景 | 隔离断言要点 |
|---|---|---|
| `tools/muad-runtime-guard/test/long-task-control-matching.e2e.test.mjs` | S-01、S-02、S-03、E-06 | 唯一适用且完整输入→恰好执行一次；多候选先列差异、选择前零执行、选择后仅执行所选；截图等价请求读取其他长任务文档并恰好访问 company_label 一次、无关 Skill 零任务零业务；无适用/缺用户必填输入/显式名称不一致→说明或追问且零入队 |
| `tools/muad-runtime-guard/test/long-task-control-cancel.e2e.test.mjs` | S-05、S-06、S-07、E-01、E-02、B-04 | 排队取消哨兵零执行且最终 cancelled；运行终止后双进程停止、计数不再增长、无新投递；同用户其他任务与另一用户任务继续运行、执行槽恰好释放一次；Worker 不可达/能力缺失明确失败且不伪报；重启后取消墓碑保留、孤儿运行仅在归属可证明且确认停止后 cancelled |
| `tools/muad-runtime-guard/test/long-task-control-ui-deployment.e2e.test.mjs` | S-08、S-10、E-05 | Console 配置→generation 事务→Worker health 成功与故障回滚；真实浏览器中英文切换、按取消状态筛选、分页与后台轮询不闪 spinner；Worker 不可达/不支持时 UI 显示原因而非成功、权限失效回登录、无重试按钮 |

单场景命令一次执行一个文件；整体验收串行，不能并行改变同一个测试 Worker 配置。场景不清空历史队列或对话，通过基线 delta 计数；重复完整终验前新建测试用户/session 或用新 peer。不同 case 必须使用独立 Agent 和 workspace，避免共享记忆或测试文件串扰。

## case 与故障/浏览器命令契约

三个 E2E 文件使用的 case id 与必需字段（通用字段见上文示例；`skills` 按场景授权）：

| case | 文件 | 必需字段（除通用字段外） |
|---|---|---|
| S01 / S02 / S03 | matching | S01：`skills:["cancel-long-task"]`；S02：`skills:["cancel-long-task","alternate-long-task"]`（多候选）；S03：`skills:["cancel-long-task","reference-report"]` 且启动 company-label 服务 |
| E06-none / E06-missing / E06-mismatch | matching | E06-none：无适用长任务授权；E06-missing：`skills:["cancel-long-task"]`；E06-mismatch：显式名称与本轮请求不一致的隔离用户 |
| S05 / S06 | cancel | S05：`skills:["queued-cancel","cancel-long-task"]` 且 poolLimit=1；S06：`skills:["cancel-long-task"]` |
| S07 / S07-other | cancel | S07：`skills:["cancel-long-task","alternate-long-task"]` 且 poolLimit≥2；S07-other：另一隔离用户 |
| E01 | cancel | `fault: { "breakCommand": [...], "restoreCommand": [...] }`：使 Worker 网关不可达/健康失败的本地 argv，restore 必须幂等 |
| E02-unsupported | cancel | 旧版本 Worker（无取消能力） |
| E02-ownership / B04 | cancel | `restartCommand`：真实重启固定版本 Worker 的本地 argv |
| S08 | ui-deployment | `deployment: { "breakHealthCommand": [...], "restoreHealthCommand": [...] }` |
| S10 / E05 | ui-deployment | `browserCommand`：真实浏览器执行器 argv（例如 Playwright 脚本），harness 追加 `[scenarioFile, resultFile]` |

浏览器执行器契约：读取 `scenarioFile`（含 consoleURL、consoleTokenFile、podId 与 checks；token 仍从私密文件读取、不写入场景文件），用真实浏览器（不允许 HTTP stub/接口直调）访问 Console，并把观测写入 `resultFile`（0600 JSON）。S-10 观测字段：`zhStatusLabels`、`zhActionLabels`、`enStatusLabels`、`enActionLabels`、`confirmDialogText`、`confirmMentionsNoRecall`、`filterCancelledOnly`、`paginationApplied`、`spinnerDuringBackgroundRefresh`、`retryButtonPresent`、`terminateRequested`、`terminateDisabledDuringStop`；E-05 观测字段：`failureText`、`successShown`、`retryButtonPresent`、`messageSurvivesRefresh`、`unauthorizedRedirectedToLogin`。结果文件缺失或字段缺失即失败，不接受测试自写观测或 stub 结果。

## 完成判定

真实模型/Worker/浏览器可能违反语义规则；测试失败应保留输出、toolCalls、队列/进程/业务/公司标签/投递 delta，不修改期望或用 fake 转绿。E2E 与规范人工验收由 cf-task-verify-e2e 统一收集；本轮 fixture 功能测试（LongTaskControlS28）不构成真实模型效果或生产发布证明。

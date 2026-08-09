# 长任务 Skill 异步并发设计文档

## 1. 背景与目标

**痛点**：同一企微会话严格串行。OpenClaw 的 session lane 硬编码 `maxConcurrent:1`，无配置键可改。长任务 skill（如导出客户周报，耗时数分钟）一旦执行，整个会话被占死，用户无法发第二个问题。

**目标**：
1. `muad.skill.json` 中标记 `longTask:true` 的 skill，触发即**异步**，不阻塞当前会话。
2. 触发方式覆盖两种：显式 `/skill:<name>` 与自然语言（模型 mid-turn 决定调 skill）。
3. 收到长任务**立即返回**确认（用户感知后台已在调度），任务结果后续由 IM **主动推送**。
4. 后台按 **user-agent 维度**调度（每业务会话独立并发池，互不影响）。
5. Console 页面按 user-agent 展示任务执行情况，**核心是"是否被消费"**（排队 vs 执行中）。
6. 普通问答保持阻塞串行，与现状一致；无 `longTask` 标记的 skill 行为不变。

**决策记录**（已与用户逐条确认）：
- 执行模型：**独立 agent turn**（任务会话复用同一 agentId，独立 session key / lane），不复活已废弃的 `muad-run-skill` 插件。
- 触发边界：显式 `/skill:` 瞬时拦截 + 自然语言经 SKILL.md 读取拦截（**不用关键词/声明式触发词**，识别交给模型）。
- 监控：实时队列（`muad.runtime.long-tasks`）+ 独立队列表 `long_task_tasks`；审计表 `skill_execution_records` 保持纯净、零改动。

## 2. 现状与约束（探测结论）

- **无同会话并发**：`command-queue-*.js` 中 session lane 硬编码 `maxConcurrent:1`；`agents.defaults.maxConcurrent`（默认 4）只控制 `main` 全局 lane（跨会话并行 ≤4）。无任何配置键可开同会话并发。
- **可行路径**：钩子拦截 + **独立 session lane 并行** + 原生 CLI 出站投递。
  - agent session key 需满足 `agent:<agentId>:<rest>`；长任务使用 `agent:<id>:longtask:<uuid>`，并显式传 `--agent <id>` 让上游校验 agent 与 session key 一致。
  - 唯一 CLI 出站形态：`openclaw agent --deliver --reply-channel <channelId> --reply-to <peerId>`（`message send` 不支持 wecom）。
- **钩子语义**（已核实 `src/plugins/`）：
  - `before_dispatch`：返回 `{handled:true, text}` 可短路路由并直接回发文本，run 不开始；事件含 `content/sessionKey/channel/senderId/replyToId`。
  - `before_tool_call`：返回 `{params?, block?, blockReason?, requireApproval?}`；**可改写 `read` 工具的参数（路径）**，不能伪造工具结果。
  - `before_agent_reply`：返回 `{handled:true, reply:{text}}` 替换回复。
  - guard 插件无"注册模型可调用工具"能力（只有 `registerCommand`/`registerGatewayMethod`/`registerTrustedToolPolicy`/`registerReload`）。
- **原生 skill 激活**：模型决定用某 skill → 读 `<available_skills>` 列出的**精确 SKILL.md 路径**（经 `read` 工具，见 AGENTS.md 激活边界指引）→ 按其执行。这是 mid-turn 决定调用 skill 的**第一个可钩住动作**。

## 3. 总体架构

```
触发(两种)              拦截                    立即确认           后台调度                    投递
────────────────────────────────────────────────────────────────────────────────────────────
/skill:name        → before_dispatch     → 瞬时回执(排队N)   │ per-user-agent 池           │
自然语言            → 模型读 SKILL.md → before_tool_call    │ (每池上限 maxLongTaskConcurrency)
                    → 改写 read→提交桩   → 模型提交标记       │ 出队 → spawn 任务会话        │
                    → before_agent_reply → 回执(排队N)      │ agent:<id>:longtask:<uuid>  │ --deliver
                                                            │ 独立 lane 并行               │ 结果回推企微
                                                            ↓ long_task_tasks 队列表（console 落账）
                                                      Console Long Tasks 视图(monitor 轮询)
```

## 4. 核心概念

| 概念 | 说明 |
|---|---|
| 长任务标记 | `muad.skill.json` 顶层布尔 `longTask`；installer / bundle ingest 解析并入 manifestJSON，同时为这类 skill 生成提交桩 |
| 提交桩 | skill 目录内 `_longtask_submit.md`；正常会话读它=提交协议，任务会话读真实 `SKILL.md`=执行 |
| 提交标记 | 模型回复首行的 `MUAD_TASK|<skill>|<任务目标>`；只有当前 run 已登记 pending long task 时才接受 |
| 任务会话 | `agent:<agentId>:longtask:<taskId>`，独立 lane；复用同一 agentId（同 workspace/模型/私有 skill/记忆） |
| 池 | key = 业务会话 key `agent:<id>:<channelId>:direct:<peerId>`；每池并发上限可配 |
| 派生索引 | guard 配置中的 `longTaskSkillGrants`，由 effective skills 自动派生，非人工维护的全局配置 |

## 5. 触发与拦截

### 5.1 显式 `/skill:<name> <args>`（瞬时）

- 钩子 `before_dispatch`，guard 新逻辑：
  1. 非 task 会话；`content` 匹配 `/^\/skill:([a-z][a-z0-9_-]{0,63})(?=\s|$)/`（复用 `skill-hooks.mjs` 的 `explicitSkillName`）。
  2. 从 `sessionKey` 解析当前 `agentId`；解析不到则放行。按 `agentId` 在派生的 `longTaskSkillGrants` 中查找该 `name`；命中才说明这是当前 agent 可用的 longTask skill。
  3. 命中 → 建任务记录（`queued`）→ 入池 → 返回 `{handled:true, text: 确认消息}`。**零模型调用，立马返回**。

### 5.2 自然语言（模型 mid-turn 决定）

- 钩子 `before_agent_run`（非 task 会话）：
  1. 用 `ctx.runId/sessionKey/agentId` 关联本 turn；`prompt/accountId/channelId/senderId` 从 event 取，`channel` 可从 ctx 取。记录这些字段作为自然语言长任务的原始目标与投递上下文。
  2. 只记录短期内存态，turn 结束或超时清理；不把用户原话写入 guard 日志。
- 钩子 `before_tool_call`（tool=`read`，非 task 会话）：
  1. `params.path` 指向某 skill 的 `SKILL.md`（basename 为 `SKILL.md`）。
  2. 路径必须落在当前 agent 允许读取的 skill root 内；读取同目录 `muad.skill.json`，`longTask === true` → 命中（识别层读**磁盘 manifest**）。
  3. 登记 `pendingLongTask[runId] = {skillName, skillRoot, originalPrompt, sessionKey, agentId, peerId}`。
  4. 改写 `params.path` → `<skillDir>/_longtask_submit.md`。模型读到提交桩 → 依协议回复标记 + "任务已提交"。
  5. 同一 run 已有 pending long task 后，首版不强行 block 后续工具调用；稳定边界由“真实 `SKILL.md` 已被提交桩替换”保证。若联调确认模型在读桩后仍会继续调工具，再单独打开 block 策略并补回归测试。
- 钩子 `before_agent_reply`（非 task 会话）：
  1. 仅当 `pendingLongTask[runId]` 存在时解析回复首行 `MUAD_TASK|<skill>|<任务目标>`。
  2. skill 名必须与 pending 记录一致；命中 → 入队 + 建记录 + 替换回复为确认消息。
  3. pending 存在但标记缺失/格式错误/skill 不一致 → 不入队，替换为受控失败文案（例如“未能提交长任务，请稍后重试或使用 /skill:<name>”），并清理 pending；禁止向用户暴露 `MUAD_TASK|...` 原文。
- 兜底：若模型未走 `read` 工具（如用 `cat`）或未遵守桩 → 串行执行（功能不坏，只是阻塞），见 §11。

### 5.3 拦截时序

```
用户"导一下客户周报"
  └─ 网关 before_dispatch 放行（自然语言，无 /skill:）
  └─ agent turn 开始
      └─ before_agent_run: 记录本 turn 原始 prompt 与投递上下文
      └─ 模型决定用 report-customer → 读 /opt/openclaw-skills/report-customer/SKILL.md
          └─ before_tool_call: path 命中长任务 → 记录 pending → 改写为 _longtask_submit.md
      └─ 模型读桩 → 回复首行 MUAD_TASK|report-customer|导出客户周报…
      └─ before_agent_reply: 解析标记 → 入池 + 替换回复
  └─ turn 结束（数秒）→ lane 释放
  └─ 池出队 → spawn task 会话 → 读真实 SKILL.md → 执行 → --deliver 回推
```

### 5.4 确认消息格式

```
任务已提交：report-customer
当前排队：2 ｜ 执行中：1
完成后结果会自动推送给你，可继续发消息。
```

## 6. 后台任务管理器（guard 新增 `long-task-manager.mjs`）

### 6.1 per-user-agent 分池与并发

- 池 key = 业务会话 key（`agent:<id>:<channelId>:direct:<peerId>`，含 agentId + channelId + peerId）。
- 每池并发上限 = `maxLongTaskConcurrency`（默认 2，可配）。不同池互不竞争。
- 池内队列 FIFO；超出上限的任务保持 `queued`（"待消费"）。

### 6.2 任务生命周期状态机

```
提交请求(内存瞬时态，不落库)
  └──(入池成功)──▶ queued ──(出队 spawn 成功)──▶ running ──(完成)──▶ succeeded
                         │                              └──(失败/超时)──▶ failed
                         └──(pod 进程重启 reconcile)──▶ failed
```

对应 `long_task_tasks.status`（见 §8.2）：`queued→running→succeeded/failed`。审计表 `skill_execution_records` 保持 `running/succeeded/failed/cancelled/rejected` 不变，只记真实执行。

### 6.3 出队与 spawn

```
openclaw agent \
  --agent <agentId> \
  --session-key agent:<agentId>:longtask:<taskId> \
  --message-file <0600-temp-file> \
  --deliver \
  --reply-channel <channelId> \
  --reply-to <peerId> \
  --json \
  --timeout <seconds>
```

- `taskId` = uuid；`<peerId>` 取自业务会话（优先 `replyToId/senderId`，按 channel 去 `wecom:` / `openclaw-weixin:` / `mattermost:` 等前缀，再退回 session key 的 peerId，规避大小写差异）。
- `child_process.spawn`/`execFile` 必须使用 argv 数组，禁止 shell string。
- 任务消息写入 `0o600` 临时文件并通过 `--message-file` 传递，避免命令行注入、长度限制和日志泄露；任务结束后清理临时文件。
- 任务消息 = 用户原话（忠实）+ 明确执行真实 `SKILL.md` 的指令 + 防重复提交指示；不得以 `/skill:` 开头。
- 任务会话完成 → `--deliver` 把最终结果推回企微（原生出站，无需额外投递代码）。
- 子进程退出码 0 → succeeded；非 0 / 超时 → failed（`error_code` 记录，如 `longtask.timeout`）。

### 6.4 递归防护

- 所有拦截（before_dispatch / before_tool_call / before_agent_reply）对 `parseAgentSessionKey(sessionKey).rest` 以 `longtask:` 开头的会话一律跳过。
- 任务消息非 `/skill:` 前缀，且任务会话跳过 SKILL.md 改写 → 读真实 `SKILL.md` 执行，不产生提交标记。

### 6.5 状态持久化与重启 reconcile

- 运行时队列在 guard 内存 + JSONL 运行态（状态目录，`0o600`）；manager 放在 `globalThis[Symbol.for("muad.longtask.manager")]`，插件热 reload 不丢队列、不重复 spawn。
- JSONL 只作为恢复用运行态日志，按最新 task 状态定期压缩；过期终态按终态保留窗口清理，避免无限增长。
- 每次状态变更经 `muad.runtime.long-tasks` 快照由 console 落账到 `long_task_tasks`（§8.2）。
- gateway/pod 进程重启时无法继续持有 child handle：启动 reconcile 将遗留 `queued/running` 标记为 `failed`（`terminal_reason="pod restart"`），reconcile 结果进入快照，DB 镜像随之收敛，并尽量通知用户。
- MVP 不做 detached child；因此不声明“pod 重启后已 spawn 子进程仍会投递”。后续若要 detached，需引入 `orphaned/unknown` 或独立 wrapper 回写终态。

### 6.6 投递

- 结果：任务会话 `--deliver`（唯一出站形态）。
- 可选增强（不在 MVP）：出队消费时再推一条"任务已开始执行"，进一步强化"已在调度"感知。

## 7. 配置

### 7.1 `runtime.concurrency.maxLongTasksPerUserAgent`（默认 2）

链路：`bin/runtime-config-schema.mjs` `validateConcurrency` 允许该键 → `driver/runtime.go` `RuntimeConcurrency.MaxLongTasksPerUserAgent` → `runtimeconfig/builder.go` 填充 → `openclaw-config-renderer.mjs` guard config `maxLongTaskConcurrency` → guard `config.mjs` 解析。

该值是 **每个 user-agent 池** 的并发上限，默认 2，可配置；超出上限的任务进入该池 FIFO 队列。不同池互不竞争。reload 后新配置必须作用到已有 pool，禁止写死。

### 7.2 `longTaskSkillGrants`（派生索引，非人工配置）

`longTask` 跟随 skill manifest，不存在人工维护的全局 longTask 列表。guard 需要一个派生索引，仅用于 `/skill:` 这种不进入模型、不会读取 `SKILL.md` 的瞬时判断。

链路：`muad.skill.json longTask` → console `skill_assets.manifest_json`（installer / bundle ingest 入库）→ `EffectiveSkill.LongTask`（解析层从 manifestJSON 派生）→ `runtimeconfig/builder.go` 从每个 agent 的 effective skill grants 收集 `RuntimeSkills.LongTaskGrants []{agentId,name,rootPath}` → renderer guard config `longTaskSkillGrants` → guard 解析。
`before_tool_call` 的 mid-turn 识别仍以磁盘 manifest 为准，但必须校验路径属于当前 agent 的 effective skill root。

### 7.3 guard 配置形状

```js
config: {
  ...,
  maxLongTaskConcurrency: 2,
  longTaskSkillGrants: [
    { agentId: "agent-a", name: "report-customer", rootPath: "/opt/openclaw-skills/report-customer" },
  ],
}
```

## 8. Console 监控

### 8.1 实时队列（Long Tasks 视图）

- guard `registerGatewayMethod("muad.runtime.long-tasks")` 返回：
  ```js
  { pools: [{
      sessionKey, agentId, peerId,
      queued, active, limit,
      tasks: [{ taskId, skillName, status, submittedAt, startedAt, endedAt, terminalReason, errorCode }],
  }] }
  ```
- console collector（同 health 的 `openclaw gateway call ... --json` Exec 模式）轮询 → 全量 upsert 到 `long_task_tasks` → `/api/v1/long-tasks` → 前端 **Long Tasks 视图**。
- guard 对终态任务至少保留 10 分钟，避免 Console 轮询错过 `running→succeeded/failed` 终态。
- `/api/v1/long-tasks` 返回分页任务行 + 独立 `pools` 摘要；池卡片的 queued/running/limit 使用运行时快照落库的权威计数，不从当前分页切片推导。
- 视图形态：按 user-agent 分组；每池一卡片（排队/执行中/上限）；任务表列 = 任务ID / skill / 状态（`queued`/`running`/`succeeded`/`failed`，`submitted` 为入池前瞬时态不落库）/ 提交时间 / 开始时间 / 结束时间。**"是否被消费" = `queued`（待消费）vs `running`（已消费）**。

### 8.2 持久队列表（long_task_tasks，审计表不动）

长任务队列独立成表；`skill_execution_records` 保持审计定位、**零改动**（不加 `queued`、不放宽 upsert）。

- **新表 `long_task_tasks`**（console 后端唯一写者）：
  ```sql
  CREATE TABLE IF NOT EXISTS long_task_tasks (
    task_id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL,
    human_user_id TEXT NOT NULL DEFAULT '',
    pool_key TEXT NOT NULL,          -- user-agent 会话 key agent:<id>:<channelId>:direct:<peerId>
    agent_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    skill_root TEXT NOT NULL DEFAULT '',
    pool_queued INTEGER NOT NULL DEFAULT 0 CHECK (pool_queued >= 0),
    pool_running INTEGER NOT NULL DEFAULT 0 CHECK (pool_running >= 0),
    pool_limit INTEGER NOT NULL DEFAULT 0 CHECK (pool_limit >= 0),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
    submitted_at TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT '',
    ended_at TEXT NOT NULL DEFAULT '',
    terminal_reason TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX idx_long_task_pod_updated ON long_task_tasks(pod_id, updated_at);
  CREATE INDEX idx_long_task_user_status ON long_task_tasks(human_user_id, status, submitted_at);
  CREATE INDEX idx_long_task_pool_status ON long_task_tasks(pool_key, status, submitted_at);
  ```
- **数据流**：guard 运行时队列（内存 + JSONL）→ `muad.runtime.long-tasks` 快照 → console collector 轮询 **全量 upsert** 到 `long_task_tasks` → Long Tasks 视图查询该表。guard 重启后快照自带 reconcile 终态（§6.5），DB 镜像随之收敛。
- upsert 必须参数化、显式列名、仅在 `internal/repo` 实现；同一 `task_id` 的状态只能按 `queued→running→terminal` 单调前进，终态不得被旧快照回退。
- **审计**：长任务真正执行时，runner 照常上报 → `skill_execution_records` 记 `running→succeeded/failed`（现状能力，无改动）。Audit 页按 skill 名查 manifest 增 longTask 徽标。

### 8.3 UI 展示

- Skills 页/详情展示 `longTask` 徽标（`skill_bundle.go`/`skills.go` 视图从 manifestJSON 派生，**无 DB 列变更**）。

## 9. 改动面（涉及文件）

| 层 | 文件 |
|---|---|
| guard | `tools/muad-runtime-guard/src/long-task-manager.mjs`（新）、`long-task-hooks.mjs`（新）、`index.mjs`、`config.mjs`、复用 `skill-hooks.mjs` |
| installer / bundle ingest | `bin/private-skill-installer.mjs`、`console/backend/internal/api/skill_bundle.go`（解析 longTask + 生成提交桩） |
| 配置 | `bin/runtime-config-schema.mjs`、`bin/openclaw-config-renderer.mjs` |
| console 后端 | `driver/runtime.go`、`runtimeconfig/builder.go`、`api/skill_bundle.go`、`api/skills.go`、`repo/schema.go`、`repo/long_tasks.go`（新）、`gateway/long_tasks.go`（新）、`collector/collector.go`、`api/long_tasks.go`（新） |
| console 前端 | `types/api.ts`、`api.ts`、新 Long Tasks 页面/组件 |
| 测试 | 各层配套单测 + e2e |

## 10. 测试与验证

- **单元测试**：
  - guard：per-user-agent 分池、并发上限、状态转换、task 会话跳过、read 路径改写、`before_agent_run` 上下文记录、pending long task 成功/失败清理、`MUAD_TASK` 标记解析失败不泄露、pending 后不依赖 block、确认消息含排队计数、重启 reconcile、`--message-file`/`--reply-channel` argv spawn。
  - installer / bundle ingest：manifest 解析含 longTask、提交桩生成，system/public/private 路径一致。
  - console：`long_task_tasks` 迁移与快照落账（upsert）、状态单调、快照→DB 镜像一致性、renderer/schema。
- **e2e（企微）**：
  1. 自然语言"导一下客户周报" → 数秒收到"任务已提交（排队 N）" → 主会话立即可继续问答 → 后台执行完结果推回企微。
  2. `/skill:report-customer 上季度` → 瞬时确认。
  3. 并发验证：同一会话连续提交 3 个长任务 → 池内前 2 个 running、第 3 个 queued；期间主会话问答不被阻塞。
  4. console Long Tasks 页：per-user-agent 显示排队/执行中/完成，"是否被消费"清晰；Audit 页台账完整。
- **回归**：普通问答串行不变；无 `longTask` 标记的 skill 行为不变。

## 11. 风险、边界与决策记录

| 项 | 说明 |
|---|---|
| 依赖模型走 `read` 工具 + 遵守提交桩 | 稳定边界是“只要模型读 longTask 的 SKILL.md，就不会在主会话执行”；未读 SKILL.md 则退化为串行执行；`read` 参数名需兼容 `path/file_path/filePath/file` |
| 全局 `main` lane（默认 4） | 并发任务可能挤压普通回复 → 实施时验证配平（调大全局池或降默认值） |
| 确认延迟 | `/skill:` 瞬时；自然语言约数秒（一次短模型 turn） |
| pod 重启 | 热 reload 不中断；真实 gateway/pod 进程重启后遗留 `queued/running` reconcile 为 failed |
| 每池资源 | 每 user-agent 池 × 可配上限；超过上限只在该池 FIFO 排队。总资源随活跃池数增长，MVP 不做跨池全局排队 |
| 提交标记泄漏 | 只有 pending run 才解析 marker；解析失败也替换为受控失败文案并清理 pending，禁止暴露 `MUAD_TASK|...` |
| 不 fork 上游 | 全部改动收敛在 guard 插件 + installer + console，OpenClaw 源码只读 |

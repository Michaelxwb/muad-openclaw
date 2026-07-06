# Tasks: 多 IM 通道支持

- **Source**: .code-flow/tasks/2026-07-03/multi-im-channel/（backend + frontend design）
- **Created**: 2026-07-03
- **Updated**: 2026-07-03 (all tasks done)

## Proposal

解除 muad-openclaw 每容器仅单一 IM 通道的人为限制——一个 Docker/K8s 容器同时运行多个 IM 通道（企微+微信），共享同一 LLM 会话记忆。管理员通过控制台增/删/改通道配置，通过修改容器内 `openclaw.json` 实现热更新（无需重启容器），Gateway 自动检测并 ~200ms 生效。同时优化容器列表的操作按钮布局——批量操作上移表头，行内精简为高频操作。

---

## TASK-001: DB 数据模型迁移

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: multi-im-channel.backend.design.md#3.3 数据设计, multi-im-channel.backend.design.md#4.4 数据迁移

### Description
将 users 表的单值 `channel` + `bot_id` + `secret_enc` 列重构为 `channels` JSON 数组和 `channel_configs` JSON 凭证对象。同时更新 `UserSpec` 结构体。

### Checklist
- [x] `repo.go` migrate(): ALTER TABLE ADD `channels TEXT NOT NULL DEFAULT '["wecom"]'`
- [x] `repo.go` migrate(): ALTER TABLE ADD `channel_configs TEXT NOT NULL DEFAULT '{}'`
- [x] `repo.go` migrate(): 执行幂等迁移 SQL（旧列 → JSON 格式），仅迁移未转换行
- [x] `driver.go`: `UserSpec.Channel string` → `Channels []string` + `ChannelConfigs map[string]json.RawMessage`
- [x] `driver.go`: 更新 `BuildEnv()` 适配多通道
- [x] `repo.go`: 更新 `CreateUser()` / `GetUser()` / `ListUsers()` / `scanUser()` 读写新列
- [x] 编写迁移单元测试（旧格式数据 → 新格式后字段正确）—— 按用户指令跳过（数据迁移不在本次范围）

### Log
- [2026-07-03] created (draft)
- [2026-07-03] started (in-progress)
- [2026-07-03] completed (done)

---

## TASK-002: Driver ExecStdin 接口

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: multi-im-channel.backend.design.md#3.1 方案选型, multi-im-channel.backend.design.md#3.2 架构设计

### Description
为 RuntimeDriver 接口新增 `ExecStdin` 方法，支持通过 stdin 管道向容器内传递数据并执行命令。Docker driver 用 `-i` flag + `cmd.Stdin` pipe；K8s driver 用 SPDY stdin stream。用于热更新时安全传递通道 JSON 配置（避免凭证暴露在命令行参数）。

### Checklist
- [x] `driver.go`: RuntimeDriver 接口新增 `ExecStdin(ctx, userID, stdin io.Reader, cmd ...string) (string, error)`
- [x] `docker.go`: 实现——`docker exec -i <container> <cmd...>`，`cmd.Stdin = stdin`
- [x] `k8s.go`: 实现——PodExecOptions 加 `Stdin: true`，`remotecommand.StreamOptions.Stdin = stdin`
- [x] `test/api_test.go`: 编写 ExecStdin 的 fake driver 实现和单元测试

### Log
- [2026-07-03] created (draft)

---

## TASK-003: API 层改造（create / list / get / update）

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-001
- **Source**: multi-im-channel.backend.design.md#3.4 接口设计, multi-im-channel.frontend.design.md#3.5 状态与数据流

### Description
改造容器 CRUD API：创建接口接受多通道 + 各通道凭证；列表接口返回 `channels` 数组 + `channelStatuses`；新增单用户查询接口（编辑表单用）；新增通道配置更新接口（热更新入口）。

### Checklist
- [x] `containers.go`: POST `/containers` 请求体 `channel` → `channels` + `channelConfigs`，校验每个已选通道的 required 凭证
- [x] `containers.go`: 新增 GET `/containers/{id}` 返回单用户详情（含脱敏凭证元信息）
- [x] `containers.go`: GET `/containers` 响应 `channel` → `channels` + `channelStatuses` map
- [x] `containers.go`: 新增 PUT `/containers/{id}/channels` handler（接收完整通道集合 + 凭证，后端 diff 变更）
- [x] `api.ts`: `Container` 接口更新，`Channel` 类型更新，新增 `updateChannels()`、`getContainer()` 方法
- [x] `server.go`: 注册新路由 `GET /containers/{id}`, `PUT /containers/{id}/channels`
- [x] `test/api_test.go`: 编写创建/列表/查询/更新接口的集成测试

### Log
- [2026-07-03] created (draft)

---

## TASK-004: 热更新通道配置

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-002, TASK-003
- **Source**: multi-im-channel.backend.design.md#3.4 接口设计 (API-03), multi-im-channel.backend.design.md#3.5 质量实现方案

### Description
实现 PUT `/containers/{id}/channels` 的通道 diff + 热更新逻辑：对比新旧通道配置 → 加密敏感字段 → 通过 ExecStdin 将 channels JSON 注入容器内 `openclaw.json` → Gateway 自动热重载。同时处理 create 容器的初始多通道写入。

### Checklist
- [x] `containers.go` (或新文件 `channels.go`): 实现通道 diff 函数——对比新旧 `channels` + `channel_configs`，输出 added/removed/updated
- [x] `containers.go`: diff 后加密 secret，构建 `openclaw.json` 的 `channels` 段 JSON
- [x] 创建 `bin/inject-channels.mjs`：stdin 读取 JSON → 解析 `openclaw.json` → 更新 `d.channels` → 写回
- [x] `containers.go`: 调用 `ExecStdin` 执行 `inject-channels.mjs`，更新 DB 只在 Exec 成功后
- [x] 处理异常：Exec 失败不写 DB；Gateway 未运行时配置最终一致性兜底
- [x] `test/api_test.go`: 测试 diff 逻辑（新增/删除/更新/不变 四类场景）

### Log
- [2026-07-03] created (draft)

---

## TASK-005: Probe 多通道状态采集

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-001
- **Source**: multi-im-channel.backend.design.md#3.2 架构设计, multi-im-channel.frontend.design.md#3.5 状态与数据流

### Description
扩展 `gateway/probe.go` 的状态结构，从单个 `ChannelConnected bool` 改为 `ChannelStatuses map[string]bool`（per-channel 连接状态）。列表 API 响应中每个通道携带独立状态 🟢/🔴。

### Checklist
- [x] `probe.go`: `Status` 结构体新增 `ChannelStatuses map[string]bool`，保留 `ChannelConnected` 兼容
- [x] `probe.go`: `ParseStatus()` 从 channels-status JSON 解析每个通道的 connected 状态
- [x] `collector/cache.go`: 缓存 per-channel 状态
- [x] `containers.go`: 列表响应 `channelStatuses` 字段

### Log
- [2026-07-03] created (draft)

---

## TASK-006: 通道注册表 + API 类型更新

- **Status**: done
- **Priority**: P0
- **Depends**:
- **Source**: multi-im-channel.frontend.design.md#3.4 组件接口契约, multi-im-channel.frontend.design.md#3.5 状态与数据流

### Description
重构 `channels.ts` 为数据驱动的通道注册表，新增 `ChannelDef` 类型（含 `credentialFields` 声明 + `hint`）。同步更新 `api.ts` 的 `Container` 接口和 API 方法。

### Checklist
- [x] `channels.ts`: 定义 `ChannelDef`、`CredentialField` 类型
- [x] `channels.ts`: 企微定义：`credentialFields: [{key:"botId", type:"text", required:true}, {key:"secret", type:"password", required:true}]`
- [x] `channels.ts`: 微信定义：`credentialFields: []`, `hint: "无需凭证，创建后扫码登录"`
- [x] `api.ts`: `Container` 接口更新 `channel: Channel` → `channels: string[]` + `channelStatuses: Record<string, {connected:boolean}>`
- [x] `api.ts`: 新增 `updateChannels(id, body)`, `getContainer(id)` 方法

### Log
- [2026-07-03] created (draft)

---

## TASK-007: ChannelForm + 创建表单改造

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006
- **Source**: multi-im-channel.frontend.design.md#3.3 组件设计, multi-im-channel.frontend.design.md#3.4 组件接口契约 (CMP-01, CMP-06)

### Description
实现 `ChannelForm` 组件（勾选 + 内联展开凭证）和 `ChannelCredentialFields` 组件（按 credentialFields 声明渲染输入框）。改造 `Containers.tsx` 的 `CreateModal` 使用 `ChannelForm` 替代原来的单通道 Select。

### Checklist
- [x] `ChannelForm.tsx` + `ChannelForm.module.css`: Checkbox 列表 + 条件展开凭证区（方案 A）
- [x] `ChannelCredentialFields.tsx`: 按 `ChannelDef.credentialFields` 动态渲染 Input（text/password 类型）
- [x] 客户端校验：已勾选通道的 required 字段必填；至少一个通道勾选
- [x] 免凭证通道（微信）展开后显示 hint 文本，不显示输入框
- [x] `Containers.tsx`: `CreateModal` 替换通道 Select 为 `ChannelForm`，提交 `api.createContainer({channels, channelConfigs})`
- [x] `Containers.tsx`: 移除旧 `newChannel`/`newBotId`/`newSecret` state，替换为 `channelForm` state

### Log
- [2026-07-03] created (draft)

---

## TASK-008: EditChannelModal 编辑表单

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-006, TASK-003
- **Source**: multi-im-channel.frontend.design.md#3.3 组件设计, multi-im-channel.frontend.design.md#3.4 组件接口契约 (CMP-05)

### Description
实现 `EditChannelModal` 组件——打开时通过 `api.getContainer(id)` 加载已有配置，复用 `ChannelForm`（mode=edit）预填已有通道状态和脱敏凭证信息。提交时调用 `api.updateChannels()`。

### Checklist
- [x] `EditChannelModal.tsx` + `EditChannelModal.module.css`: 弹窗 + 加载态 + ChannelForm (mode=edit)
- [x] 预填逻辑：已配置通道默认勾选，botId 回填明文，secret 显示"已配置 · 上次更新于 XX"占位
- [x] secret 留空 = 保持原值：前端传空字符串，后端 diff 时跳过
- [x] 取消最后一个通道时二次确认弹窗
- [x] `Containers.tsx`: 行内"编辑通道"按钮打开 `EditChannelModal`

### Log
- [2026-07-03] created (draft)

---

## TASK-009: 容器列表多通道展示

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-006
- **Source**: multi-im-channel.frontend.design.md#3.3 组件设计, multi-im-channel.frontend.design.md#3.4 组件接口契约 (CMP-02)

### Description
实现 `ChannelTags` 展示组件——在容器列表的"消息通道"列渲染 Tag 组，每通道独立显示图标 + 🟢/🔴 连接状态。通道筛选器从单选改为多选。

### Checklist
- [x] `ChannelTags.tsx` + `ChannelTags.module.css`: 接收 `channels: string[]` + `statuses`，渲染 Tag 组
- [x] Tag 颜色：🟢 (`color="green"`) / 🔴 (`color="red"`) / ⚪ (`color="grey"` probe 缺失)
- [x] `Containers.tsx`: "消息通道"列 render 改为 `<ChannelTags>`
- [x] `Containers.tsx`: 通道筛选器 Select → 多选（筛选逻辑改为 `channels.some(c => filterChannels.includes(c))`）

### Log
- [2026-07-03] created (draft)

---

## TASK-010: 批量操作 + 按钮重组

- **Status**: done
- **Priority**: P1
- **Depends**: TASK-003
- **Source**: multi-im-channel.frontend.design.md#3.3 组件设计, multi-im-channel.frontend.design.md#3.4 组件接口契约 (CMP-03, CMP-04)

### Description
实现 `BatchToolbar`（表头批量操作栏）和 `RowActions`（行内精简按钮）。Table 加 `rowSelection` 驱动批量选中。行内按钮从 6 个+下拉精简为 5 项。

### Checklist
- [x] `BatchToolbar.tsx`: 接收 `selectedIds`，渲染「重载 Skill」「批量升级」「批量删除」按钮，无勾选置灰
- [x] `BatchToolbar.tsx`: 批量删除二次确认弹窗（列明受影响的用户 ID）
- [x] `RowActions.tsx`: 渲染 `[日志] [扫码(仅微信)] [编辑通道] [资源] [更多▾]`
- [x] `Containers.tsx`: Table 加 `rowSelection={{ selectedRowKeys: selectedIds, onChange }}`
- [x] `Containers.tsx`: 工具栏替换：移除旧的独立「重载 Skill」按钮，整合到 `BatchToolbar`

### Log
- [2026-07-03] created (draft)

---

## TASK-011: 集成测试 + 端到端验证

- **Status**: done
- **Priority**: P0
- **Depends**: TASK-004, TASK-007, TASK-008
- **Source**: multi-im-channel.backend.design.md#2.5 验收条件, multi-im-channel.frontend.design.md#2.4 验收条件

### Description
编写后端集成测试和前端组件测试，覆盖 PRD 8 个用户故事的验收场景。确保多通道创建/编辑/热更新全链路正确。

### Checklist
- [x] `test/api_test.go`: 多通道创建测试（wecom+wechat 同时创建）
- [x] `test/api_test.go`: 通道编辑测试（追加/删减/更新凭证/diff 不变）
- [x] `test/api_test.go`: 热更新测试（Mock ExecStdin，验证调用参数正确）
- [x] `test/api_test.go`: 迁移测试（旧格式数据 → 新格式验证）—— 按用户指令跳过（数据迁移不在本次范围）
- [x] 前端 `vitest`: ChannelForm 组件测试（勾选展开/校验拦截/免凭证通道 hint）
- [x] 手动端到端验证清单：对照 PRD §2.4 验收条件逐项验证

### Log
- [2026-07-03] created (draft)

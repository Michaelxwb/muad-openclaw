# MSSW 平台消息通道（本地 Demo 接入）

平台聊天后端可以通过 HTTP 将受信平台用户消息提交给绑定的 muad Agent，部分回复与终态通过 HTTP 回调交付给原会话。原 Agent / Skills / Guard / Console 配置与状态卷继续复用。

## 两个仓库的分工

- 本仓库：Console 的 `mssw` 通道配置与身份绑定、Worker 原生 `tools/mssw-channel` 插件、镜像装配、MSSW 回程目标与持久 Runtime 目录。
- [guxianggao/mssw-ai](https://github.com/guxianggao/mssw-ai)：独立 Vue / FastAPI 聊天 Demo、SQLite 历史、SSE 订阅、模型转发、本机流式适配和 Docker 部署入口。该仓库为私有，访问需仓库权限。
- 配对版本、部署步骤和逐文件改动索引见 Demo 仓库的 `docs/DEPLOYMENT.md`、`docs/CHANGE_INVENTORY.md`。

网页 → Demo 后端保存 → HTTP `/mssw/messages` → 原生 Channel SDK → Agent / Skills → HTTP `/internal/mssw/events` 回传 → 后端保存 → SSE 网页更新。

## 通道配置与绑定

通过 Console Pod 创建/通道配置 API 启用 `mssw`，提供 `baseUrl`（平台回调根地址）和 `botToken`（可信服务令牌）。Demo 使用 `${OPENCLAW_GATEWAY_TOKEN}` 运行时引用，不将真实凭据写入镜像。

给 Human User 添加 `channel=mssw` 的 Identity，并显式绑定模型。配置必须通过 Console apply 与健康检查生效。此插件不会自动给未知发送者开通账户，也不接受消息调用方指定 `agentId` 或内部 `sessionKey`。

## HTTP 合同

Gateway 鉴权入口：`POST /mssw/messages`，JSON 字段为 `runId`、`conversationId`、`senderId`、`tenantId`、`text`，可携带近期已完成的 `history`。使用 Gateway Bearer 鉴权；返回 202 表示已接收，不代表执行完成。

平台回调：`POST <baseUrl>/internal/mssw/events`，字段为 `event_id`、`run_id`、`conversation_id`、`sender_id`、`tenant_id`、`text`、`state`。状态包含 running / complete / interrupted / notification。平台只有持久保存成功后才能返回 `{"ok":true}`。

平台必须从自己的可信登录态确定身份及权限，且校验回调与 Run / 会话归属。此协议不是生产 MSSW SSO 或业务权限实现。

## 会话与交付

目标包含用户、租户和会话；小写 hex 编码兼容核心会话 key 规范化。一个用户的多段聊天使用不同 session key。回程必须保留整个 MSSW target，不能压成 sender ID。

Worker 在 Agent 状态目录的 `mssw-delivery` 保存任务与待交付回调，同一个 Run 重试不重新执行。回调失败重投已有结果。旧进程未完成的任务恢复为 interrupted，不承诺从模型字节或业务副作用处自动续跑。交付账本不提供所有外部业务的 exactly-once 保证。

## 代码导航

- `console/backend/internal/driver/driver.go`：通道与插件映射。
- `console/backend/internal/api/pod_channels.go`：配置校验。
- `console/frontend/src/channels.ts`：通道表单与中英文标签。
- `bin/startup-context.mjs`、`bin/image-plugin-paths.mjs`、`Dockerfile`：插件装配。
- `tools/mssw-channel/index.mjs`：接收、路由、SDK 调度、回传与恢复。
- `tools/mssw-channel/protocol.mjs`：目标编码与消息校验。
- Runtime Guard 的 long-task-hooks / skill-progress-manager：保留 MSSW 会话回程目标；不代表真实长任务已验收。
- Docker driver 的 `CONSOLE_DOCKER_SECRET_DIR` 与 `/host_mnt` 路径兼容：持久目录在 Docker Desktop 重启后仍可识别。

## 验证边界

新增测试覆盖原生 SDK 调度、重复 Run、未知发送者、归属冲突、主动文本与中断恢复；Console driver/API、通道表单、启动装配与 Guard 回程也有检查。插件 SDK 测试使用 fake，不能替代实际镜像验证。

10 月 8 日配对本机 Demo 记录了真实模型流式、主动文本与完整 Docker 重启追问。当前 PR 基于最新 main 移植；Docker Demo 固定旧 Console / Worker 基线与兼容补丁，版本关系在 Demo 文档中记录，不将本机结果冒充最新主分支镜像验收。

本 PR 不包含 MSSW 生产登录、租户业务授权、媒体、真实业务长任务，或禁用 Guard 收尾的 Demo 流式开关。只在 Demo 仓库中保留后者，且限定无长任务授权。

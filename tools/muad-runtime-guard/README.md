# Muad Runtime Guard

`muad-runtime-guard` 是外置 OpenClaw 插件，负责多用户 Pod 中的身份激活、模型前置检查、浏览器并发、文件访问策略和运行时健康。它只使用公开插件接口，不修改 OpenClaw 上游源码。

## main 与业务 Agent

- `main` 只用于未知 IM 身份的绑定引导，不执行普通模型请求。
- 未绑定用户在 main Agent 私聊中发送 `/bind <code>`，插件从可信命令上下文取得 sender、channel、account 和 session，再调用 Console internal API 完成绑定。
- 绑定码是唯一用户参数；响应不会回显绑定码、External ID、token 或内部错误。
- 已绑定身份由 Runtime Config 路由到对应业务 Agent，继续正常模型与 Skill 流程。

目前支持 WeCom 和个人微信 direct message。`/bind` 结果设置 `continueAgent: false`，避免额外模型回复。

## 模型门禁

业务 Agent 进入模型调用前必须能解析到有效 provider 和 model reference。缺失模型时插件在 dispatch 前返回稳定用户提示，不把 provider、API Key 或内部配置暴露给 IM 用户。main Agent 不经过业务模型门禁。

## 浏览器并发与隔离

- browser profile 必须与当前 Agent 的 Runtime Config 映射一致，禁止伪造或跨用户访问。
- Pod 级共享 lease manager 执行 `maxBrowserConcurrency`、有界等待和超时。
- Tool 成功、失败或取消后均释放 lease；watchdog 回收异常遗留 lease。
- 浏览器用户数据目录按 Agent 隔离，不能通过 Tool 参数切换到其他 Profile。

## Skill 并发

- 显式 `/skill:<name>` 触发的 Agent run 会在 `before_agent_run` 获取 Pod 级共享 lease。
- 普通聊天不占用 Skill 并发。
- `agent_end` 释放 lease；异常遗留 lease 由共享队列 TTL 回收。
- 并发满时请求在模型调用前 fail closed，并返回稳定用户提示。

## 文件与 Skill 根策略

- 业务 Agent 只允许访问自身 workspace。
- 当前 Runtime Config 授权的 system/public/private Skill 根只读开放。
- main、跨用户目录、未授权 Skill 根、运行时内部状态和写入操作保持拒绝。
- `apply_patch` 校验所有目标路径，不信任模型提供的派生路径。
- 业务 Agent 的 shell/code-exec 类工具保持拒绝，避免模型绕过文件策略读取运行时凭证。

Skill 激活走 OpenClaw 原生 Skill 机制；Runtime Guard 只负责可信边界、显式 Skill/浏览器并发和健康检查。

## 健康检查

插件注册 `muad.runtime.health` 和 `muad.runtime.verify-routes`，都需要 `operator.read` Gateway scope。基础健康结果只有在以下条件全部满足时才为 true：

- Runtime DTO generation 合法且与控制面期望一致。
- Agent、browser profile、session route 映射完整且无 quarantine 复用。
- `session-manager` 已加载。
- browser 和 Skill 共享队列可用。

Console Collector 读取 `muad.runtime.health` 并生成 generation mismatch 和 Runtime Guard unhealthy 告警。Runtime apply 成功判定额外调用 `muad.runtime.verify-routes`，用 Gateway 当前内存态配置和 OpenClaw 原生 `resolveAgentRoute` 验证所有 direct route 都解析到预期 Agent；它不读取 `openclaw.json` 文件作为路由已生效的证明。

## Service token

绑定与健康相关的内部请求使用 Pod service token。插件每次从以下只读文件读取：

```text
/run/secrets/muad/pod-service-token
```

token、绑定码和业务凭证不得进入日志、错误或健康响应。

## 测试

```bash
cd tools/muad-runtime-guard
npm test
```

测试覆盖 WeCom/WeChat 绑定、main 拦截、模型门禁、浏览器与 Skill lease、文件/Skill 根策略、插件注册及健康降级。

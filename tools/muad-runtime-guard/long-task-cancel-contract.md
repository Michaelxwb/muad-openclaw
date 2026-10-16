# OpenClaw 2026.7.1 长任务取消契约

TASK-001 / S-11，2026-10-15。本地已安装分发物验证，不依赖相邻工作区或新版源码。

## 验证来源

- 仓库 `Dockerfile.base` 固定 `2026.7.1`。
- 本地镜像 `muad-openclaw:skill-preflight-e2e-20261001-r4`，image ID
  `sha256:f80c78dc38a95bb36b0d92dad06c232b03b746d47d24f223254847dac4cbc708`。
- `/app/package.json.version` 和 SDK `OPENCLAW_VERSION` 均为 `2026.7.1`；镜像标签
  `io.muad.openclaw.upstream.revision=2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`。
- 测试使用 `--network none`、无挂载的临时容器，创建并销毁自己的本地进程。

## 公开入口及停止语义

`openclaw/plugin-sdk/agent-harness-runtime` 的公开导出：

```js
resolveActiveEmbeddedRunSessionId(sessionKey) // 活跃 sessionId 或 undefined
abortAndDrainAgentHarnessRun({ sessionId, sessionKey, settleMs, forceClear: false })
// Promise<{ aborted: boolean, drained: boolean, forceCleared: boolean }>
```

它与 Gateway 原生运行共享进程内注册表。不得在独立 CLI 中调用后认为已停止
Gateway 的运行；独立进程拥有另一张表。Worker 必须先核对 taskId、可信后台
sessionKey、当前 Worker 实例和真实运行身份，再调用。API 内部按 sessionId 定位，
不会替调用方验证 sessionKey/runId 的归属。

`aborted=true` 只说明调用到了可取消句柄；`drained=true` 说明等到了原生句柄清理。
无活跃句柄返回 `aborted=false, drained=false`，不能据此推断已停止或未曾启动。
等待超时返回 `drained=false`。禁止使用 `forceClear:true`：强制删除注册记录不证明
执行已停止。直接 `chat.abort` 的接受响应及生命周期事件也不能代替收尾确认。

`openclaw/plugin-sdk/agent-core` 公开提供 `killProcessTree(pid, opts)` 和
`signalProcessTree(pid, signal, opts)`。前者返回 void，是 best effort 信号发送，
并非退出确认。Unix 默认向进程组发送；只有本任务以 detached 模式创建并持有的
进程组才可这样调用。非 detached 必须显式传 `detached:false`。不得拿历史 PID、
其他会话 PID 或 CLI 进程组代替 Gateway 内业务进程的归属句柄。

原生 abort/drain 不额外承诺所有业务子进程或远端作业都停止。运行适配器必须保留
可证明归属的进程控制句柄并等待实际退出；不能证明的运行不开放成功终止能力。
真实运行停止与 Skill/browser 租约、进度桥和材料清理均确认后才能置 cancelled。

`gateway-method-runtime.dispatchGatewayMethod` 限于声明
`contracts.gatewayMethodDispatch: ["authenticated-request"]` 的插件 HTTP 路由，
不能从任意插件 RPC 直接调用。实现无需使用该受限入口或导入分发物哈希内部路径。

## 已执行的局部断言

```sh
env MUAD_LONG_TASK_CONTRACT=1 node --test --test-name-pattern LongTaskControlS11 tools/muad-runtime-guard/test/long-task-cancel-contract.test.mjs
```

结果：1 个测试通过，零跳过。测试可通过 `MUAD_LONG_TASK_CONTRACT_IMAGE` 指定包含
同版分发物的隔离镜像；版本不符、缺失公开导出或镜像不可用均明确失败。普通回归
未设置 opt-in 时跳过 Docker 契约测试，正式 S-11 命令显式设置 opt-in。

- 使用 SDK 的真实注册表及自己创建的运行句柄，不替换 SDK 实现。
- 精确 sessionKey 解析；错误句柄无法清除目标身份。
- 公开 abort/drain 驱动本测试持有的真实进程停止，并等待 close 后释放句柄。
- 另一个会话保持存活；未清理的句柄返回 drained=false 且仍在注册表中。
- 不存在的运行返回两个 false，拒绝把它当作停止成功。

此任务是现有上游能力的契约补测，无生产行为改动，无法产生合理的功能 RED；
未伪造失败。该测试不冒充真实模型、原生 exec 或投递 E2E，S-06/E-02/B-04
仍须在集成实现后按原契约验证。

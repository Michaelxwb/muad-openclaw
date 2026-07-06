---
description: 涉及 API 设计/部署/配置/版本兼容时适用：平台规则
---

# Backend Platform Rules

## Examples

✅ 走统一封装 + 错误码常量

```python
return success(data)
raise BizError(ORDER_NOT_FOUND)   # 错误码定义在 errors/order.py
```

❌ handler 手拼响应结构 + 硬编码 message

```python
return {"code": 1, "message": "order not found", "data": None}
```

## Rules
- API 变更必须保持向后兼容；破坏性变更走新版本路径（`/v2/...`）并保留旧版本至少一个发布周期
- 配置项分环境管理（dev / staging / prod），敏感值走密钥管理服务，禁止入库
- 新增外部依赖必须更新部署文档与 `requirements` / `package.json` 锁文件
- 灰度 / 实验性功能必须由 feature flag 控制，默认关闭
- API 响应必须走统一封装：`success(data)` / `fail(code, message?)`，handler 禁止手写 `{code, message, data}` 字面量
- 错误码 → message 映射定义为常量，按业务模块拆分（`errors/order.py`、`errors/user.py`），错误码全局唯一，禁止重复

## Patterns
- API 响应统一结构：`{ code, message, data }`（`code=0` 表示成功），全项目一致
- 错误码命名空间：模块前缀 + 顺序号（如订单错误码 `10xxx`、用户 `20xxx`），便于定位归属
- 异常 → 错误码：自定义业务异常类携带 `code`，由中间件统一转 `fail(code)` 响应
- 配置加载优先级：环境变量 > 配置文件 > 默认值
- 健康检查端点（`/healthz`、`/readyz`）必须独立于业务认证
- 部署前跑 smoke test，覆盖核心路径
- **[项目] [internal/config/config.go]** env > yaml > defaults 三级优先级，`config.yaml` 不存在时静默使用 defaults（容器友好）；敏感值（密码/密钥）禁止写入 yaml，仅从 env 注入
- **[项目] [Dockerfile]** 凭证不进镜像（`NFR-SEC-02`），运行时经 env 注入；浏览器/插件/基线配置在构建期烤入，首启从种子卷播种
- **[项目] [CI: build-console.yml, build-image.yml]** tag push 触发 Docker build & push 到 GHCR，`console-v*` tag → 控制台镜像，`v*` tag → 工作镜像
- **[项目] [internal/api/server.go:80-90]** API 响应统一通过 `writeJSON` / `writeErr` 两个 helper 输出，禁止 handler 直接调用 `json.NewEncoder(w).Encode(...)`；所有 handler 必须走统一封装
- **[项目] [internal/api/*.go 所有 handler]** 错误码按 HTTP 状态码分段：`40001`（invalid body/param）、`40101`（unauthorized）、`40401`（not found）、`40901`（conflict/duplicate）、`50001`（internal error）；新增错误码沿用此体系，不重复使用已有编号
- **[项目] 消息通道为插件式架构** [Dockerfile, baseline-config.json, bin/inject-env.mjs]：openclaw 通道由**构建期安装的插件**提供——企微 `@wecom/wecom-openclaw-plugin`（通道 id `wecom`）、个人微信 `@tencent-weixin/openclaw-weixin`（通道 id `openclaw-weixin`）。baseline 声明通道、`inject-env.mjs` 按 `CHANNEL` env 仅启用所选通道（其余关闭防互踢）。外部 channel 值（`wecom`/`wechat`）→ openclaw 通道 id 的映射集中在 inject-env（`wechat`→`openclaw-weixin`）。openclaw 核心**无内置 wechat 通道**，未装插件就配 `channels.wechat` 会 `unknown channel id` 启动失败；新增通道必须先在 Dockerfile 装插件。
- **[项目] 通道凭证差异** [bin/inject-env.mjs]：企微用 `WECOM_BOT_ID/WECOM_SECRET`；个人微信**免凭证**，登录靠日志二维码（`openclaw channels login --channel openclaw-weixin` 输出 `liteapp.weixin.qq.com` 链接 + ASCII 二维码）。后端创建校验据此区分：仅 wecom 要求 botId/secret。
- **[项目] 容器内配置注入走 `ExecStdin` + stdin JSON，禁止走命令参数** [internal/driver/driver.go:91, internal/driver/docker.go:175-184, internal/driver/k8s.go:358-381, internal/api/containers.go:576-579]：RuntimeDriver 暴露 `ExecStdin(ctx, userID, stdin io.Reader, cmd ...string)` 接口，长 JSON / 凭据经 stdin pipe 传入——Docker driver 用 `docker exec -i` + `cmd.Stdin = stdin`；K8s driver 用 SPDY exec 把 `Stdin: true` 写入 `PodExecOptions` 并把 reader 挂到 `StreamOptions.Stdin`。handler 调 `s.drv.ExecStdin(r.Context(), userID, strings.NewReader(payloadJSON), "node", "/opt/muad/xxx.mjs")`，**payload 永远不进入 argv**——避免出现在 `ps` / shell history / 审计日志 / cgroup 监控。新增需要传大 payload 或敏感数据的容器内命令，统一走 ExecStdin 模式，不要再加 `Exec` 变体塞参数。
- **[项目] 多通道热更：Go 端 diff + ExecStdin 注入 `openclaw.json` 的 `channels` 段** [internal/api/containers.go:537-580, bin/inject-channels.mjs]：用户编辑通道配置（`PUT /containers/{userId}/channels`）后，handler 拿 `oldChannels / oldConfigs` 与请求做 diff → 合并 `mergeChannelConfig`（空 secret 字段 = 保留旧值）→ 加密新 secret → 用 `wecom→wecom` / `wechat→openclaw-weixin` 通道 id 映射构造 `oclConfig` → `json.Marshal` → `ExecStdin` 跑 `/opt/muad/inject-channels.mjs`（stdin 收 JSON → enable + 覆盖配置 → 删 input 中没有的 key → 写回）→ Exec 成功后才更新 DB。**Exec 失败时 DB 保持原样**（user 已通过的 `TestUpdateChannels_ExecFailureDoesNotMutateDB` 覆盖）。通道 id 映射在 Go 侧而非 mjs 侧——mjs 看到的是 openclaw 内部 id，Go 看到的是外部 `wecom`/`wechat`，职责清晰。热更 ~200ms 生效，gateway 自动重载，**不重启容器**。

## Anti-Patterns
- 禁止在生产环境开启 `DEBUG` / 详细堆栈输出
- 禁止把 secret 写进代码库或 dev 配置文件
- 禁止破坏性 API 变更不通知调用方直接发布
- 禁止 feature flag 长期遗留，上线稳定后必须清理
- 禁止在 handler 里直接拼响应结构或硬编码错误 message，必须引用 `errors/` 常量并走 `success / fail` 封装

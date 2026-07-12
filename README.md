# muad-openclaw

多用户 **企业微信 + 个人微信** Agent 平台。每用户一个隔离容器：[openclaw](https://github.com/openclaw/openclaw) + 官方 WeCom / WeChat 插件 + Playwright + 任意 OpenAI 兼容 LLM。

容器 **可同时跑多通道**（一个容器里企微 + 个人微信并行），共享同一 LLM 会话记忆。通道增删改通过控制面热更（`openclaw.json` 走 ExecStdin 注入，~200ms 生效，无需重启容器）。

**所有复杂配置（浏览器/工具/渠道/provider）在构建镜像时已烤好，起来即用。**

> 设计文档：[`.code-flow/specs/`](.code-flow/specs/)
> 多 IM 通道方案：[`.code-flow/tasks/archived/2026-07-03/multi-im-channel/`](.code-flow/tasks/archived/2026-07-03/multi-im-channel/)

## 镜像里烤好了什么

- openclaw + **Chromium**（Playwright，含系统依赖）
- **WeCom 长连接插件** `@wecom/wecom-openclaw-plugin`（通道 id `wecom`，websocket 长连接 + 主动推送）
- **WeChat 插件** `@tencent-weixin/openclaw-weixin`（通道 id `openclaw-weixin`，扫码登录）
- PoC 验证的基线配置：`browser.mode=off` 本地启动、`noSandbox`、`tools.alsoAllow=[browser]`、`provider.api=openai-completions`

通道凭据（wecom botId/secret、wechat 走扫码）和 LLM key **不进镜像**，运行时经 env 注入。

## 构建镜像

推 git tag 即由 GitHub Actions 构建并推到 `ghcr.io/<owner>/muad-openclaw:<tag>`：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

本地构建：

```bash
docker build -t muad-openclaw:local .
# 基础版本固定为 2026.6.10；构建自检会拒绝其他版本。
```

## 用户容器管理（通过 `muad-console` 控制面）

[不再用 `provision-user.sh` CLI 起容器]，统一走 Web 控制台（`console/`）：建/删/启停/重读 channel/改 LLM/查日志/审计一条龙。

`muad-console` 是单 Go 二进制（内嵌 React 前端），通过 `RuntimeDriver` 抽象同时支持 Docker 和 Kubernetes：

```bash
# 启动 console（默认 docker driver）
cd console && cp config.example.yaml config.yaml
# 编辑 config.yaml 填 masterKey / adminPassword 等
go run ./cmd/console

# 或切换到 k8s driver（已写实）
# config.yaml: runtimeDriver: k8s + k8sNamespace: muad
```

打开 `http://localhost:8080`，管理员在 UI 上：

| 操作        | 说明                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| 创建容器    | 选多通道（wecom / wechat），填凭据 / 走扫码                              |
| 列表        | 看每个容器的多通道独立状态（🟢/🔴）、CPU/内存、最后活跃、回收倒计时      |
| 编辑通道    | 增/删/改通道配置 → 控制面走 ExecStdin 热更到 `openclaw.json`，容器不重启 |
| 删容器      | 可选同时删状态卷（记忆/会话）                                            |
| LLM         | 全局配置 + per-user 覆盖 + 连通性测试 + 批量应用                         |
| 审计 / 告警 | 管理员操作审计 + 容器健康告警（铃铛，30s 轮询）                          |

详细架构、配置表、API 列表、CI 流程见 **[`console/README.md`](console/README.md)**。

### 通道行为

- **wecom**：必填 `botId` + `secret`，通过 env 注入容器，openclaw 长连接企微
- **wechat**：免凭证（无 botId/secret），管理员创建后点「扫码」按钮 → 后端触发 `openclaw channels login` → 拉 ASCII 二维码到 UI → 用户用微信扫 → 完成登录
- **一容器可同时勾选多个通道**，openclaw 内部按 channel id 隔离 session
- **通道热更**：编辑保存 → 控制面对比新旧 channels/configs → `openclaw inject-channels.mjs` 解析 stdin JSON → 写 `openclaw.json` 的 `channels` 段 → gateway 自动 reload

## 开发

```bash
# 后端
cd console/backend
go test ./...                        # 69 个集成测试（test/ 黑盒）
go run ./cmd/console

# 前端
cd console/frontend
npm install
npm run dev                          # http://localhost:5173
npm run check                        # tsc --noEmit && eslint && prettier --check && vitest run
# 6 个 vitest 单元测试（test/ChannelForm.test.tsx）

# 整体
npx -y @douyinfe/semi-mcp            # 控制面 / 容器内 openclaw 知识查询
```

`/cf-task:prd` 走需求 → 设计 → 任务 → 实现 → 归档的工作流，详见 [`.opencode/commands/`](.opencode/commands/)。

## 注意

- **一通道一凭证**：同一通道（wecom/wechat）在多容器上配同一凭证会互踢（连接互斥）。但**不同通道可在同一容器并存**（wechat + wecom 各一凭证）。
- WeCom 主动推送要求用户先给 bot 发过一条消息（企微规则）。
- 浏览器 / exec 等特权 scope 已通过基线配置（本地启动）规避人工审批，无需在 UI 点批准。

## 结构

```
Dockerfile                  自包含 muad-openclaw 镜像（烤 Chromium + wecom/wechat 插件 + 基线配置）
baseline-config.json        内部固化配置（管理员不碰）
bin/
  ├── seed-config.mjs       构建期：合并基线
  ├── inject-env.mjs        运行期：注入 LLM/通道 env → openclaw.json
  └── inject-channels.mjs   运行期（热更）：stdin 收 JSON → 更新 openclaw.json 的 channels 段
entrypoint.sh               首启播种 + 注入 env + 起网关

console/                     管理控制面（Go 后端 + React 前端，详细见 console/README.md）
  ├── backend/              Go 单二进制，RuntimeDriver 抽象（docker + k8s）
  └── frontend/             React + Vite + Semi Design SPA

.code-flow/                 规范 + 任务档案
  ├── specs/                编码规范（backend / frontend / shared）
  └── tasks/                任务档案（含已归档的 multi-im-channel 等）

.opencode/                  opencode 命令 + plugin + skills（含 semi-design-guide）
.github/workflows/          build-image.yml / build-console.yml
```

## CI / 发布

| tag 格式     | 触发                | 推到                                            |
| ------------ | ------------------- | ----------------------------------------------- |
| `v*`         | `build-image.yml`   | `ghcr.io/<owner>/muad-openclaw`（用户容器镜像） |
| `console-v*` | `build-console.yml` | `ghcr.io/<owner>/muad-console`（控制台镜像）    |

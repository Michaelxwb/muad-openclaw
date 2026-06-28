# muad-openclaw

多用户企业微信 Agent 平台。每用户一个隔离容器：[openclaw](https://github.com/openclaw/openclaw) + 官方 WeCom 长连接插件 + Playwright + 任意 OpenAI 兼容 LLM。

**所有复杂配置（浏览器/工具/渠道/provider）在构建镜像时已烤好，起来即用。管理员只填一个配置文件。**

> 设计文档：`platform-command/.code-flow/tasks/2026-06-27/muad-agent-platform.design.md`

## 镜像里烤好了什么

- openclaw + **Chromium**（Playwright，含系统依赖）
- **WeCom 官方长连接插件** `@wecom/wecom-openclaw-plugin`（websocket 长连接 + 主动推送）
- PoC 验证的基线配置：`browser.mode=off` 本地启动、`noSandbox`、`tools.alsoAllow=[browser]`、`channels.wecom.connectionMode=websocket`、`provider.api=openai-completions`

凭证（bot secret / LLM key）**不进镜像**，运行时经 env 注入。

## 构建镜像

推 git tag 即由 GitHub Actions 构建并推到 `ghcr.io/<owner>/muad-openclaw:<tag>`：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

本地构建：

```bash
docker build -t muad-openclaw:local .
# 指定 openclaw 基础版本：docker build --build-arg OPENCLAW_VERSION=latest -t muad-openclaw:local .
```

## 管理员起一个用户（两步）

```bash
export MUAD_OC_IMAGE=ghcr.io/<owner>/muad-openclaw:v0.1.0   # 或 muad-openclaw:local

# 1) 生成配置模板 → 编辑填 bot 凭证 + LLM
./provision-user.sh alice --init
vi users/alice/config

# 2) 起容器（读 config，注入复杂配置，起来即用）
./provision-user.sh alice

# 看 WeCom 是否连上
docker logs -f muad-oc-alice | grep -i Authenticated
# 停（状态保留在卷）：./provision-user.sh alice --down
```

### 配置文件（`users/<user>/config`，管理员只填这些）

```ini
WECOM_BOT_ID=aib...
WECOM_SECRET=...
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-v4-pro
LLM_BASE_URL=https://api.deepseek.com
```

## 注意

- **一 bot 一容器**：每用户须独立企微 bot（同 bot 多连接会互踢）。
- WeCom 主动推送要求用户先给 bot 发过一条消息（企微规则）。
- 浏览器/exec 等特权 scope 已通过基线配置（本地启动）规避人工审批，无需在 UI 点批准。

## 结构

```
Dockerfile              自包含镜像（烤 Chromium + WeCom 插件 + 基线配置）
baseline-config.json    内部固化配置（管理员不碰）
bin/seed-config.mjs     构建期：合并基线
bin/inject-env.mjs      运行期：注入外部面 env → openclaw.json
entrypoint.sh           首启播种 + 注入 env + 起网关
compose.template.yml    每用户 compose 模板
provision-user.sh       管理员开通脚本（--init / 起 / --down）
users/_template.config  外部配置模板
.github/workflows/build-image.yml   tag → 构建推 GHCR
```

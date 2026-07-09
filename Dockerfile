# 多用户 openclaw 企微 Agent 平台镜像（自包含，CI 友好）。
# FROM 官方发布镜像 → 烤入：① Chromium（Playwright，含系统依赖）② WeCom 官方长连接插件
# ③ PoC 验证的基线配置（浏览器/工具/渠道/provider）→ 起来即用，管理员只填外部面凭证。
# 凭证一律不进镜像（NFR-SEC-02）：bot_id/secret、LLM key 运行时经 env 注入。
ARG OPENCLAW_VERSION=2026.6.10
FROM golang:1.26 AS muad-progress-builder

WORKDIR /src/tools/muad-progress
COPY tools/muad-progress/go.mod ./
COPY tools/muad-progress/cmd ./cmd
COPY tools/muad-progress/internal ./internal
RUN set -eux; \
    go test ./...; \
    go build -o /out/muad-progress ./cmd/muad-progress; \
    go build -o /out/muad-skill-check ./cmd/muad-skill-check

FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw \
    PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

# WeCom 官方长连接插件版本（与 PoC 验证版本对齐）。
ARG WECOM_PLUGIN_VERSION=2026.6.23

# 微信（个人）通道插件：腾讯官方 @tencent-weixin/openclaw-weixin，注册 channel id "wechat"。
# openclaw 核心不内置 wechat 通道（channels.wechat 会报 "unknown channel id" 直到装此插件），
# 与 wecom 一样需在构建期烤入种子。
ARG WECHAT_PLUGIN_VERSION=2.4.3

COPY baseline-config.json /opt/muad/baseline-config.json
COPY bin/seed-config.mjs  /opt/muad/seed-config.mjs
COPY seed/BOOTSTRAP.md    /opt/muad/BOOTSTRAP.md

# 烤浏览器 + 装插件 + 合并基线 → 快照为种子（运行时 per-user 卷为空时播种）
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb; \
    mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"; \
    node /app/node_modules/playwright-core/cli.js install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/*; \
    # setup 末尾会探网关健康（构建期网关未起）→ 退出非零，但 openclaw.json 已写好；容忍并校验
    su node -c "openclaw setup --non-interactive --accept-risk --mode local" || true; \
    test -f /home/node/.openclaw/openclaw.json || { echo "FATAL: setup 未生成 openclaw.json" >&2; exit 1; }; \
    su node -c "openclaw plugins install '@wecom/wecom-openclaw-plugin@${WECOM_PLUGIN_VERSION}'"; \
    su node -c "openclaw plugins install '@tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION}'"; \
    su node -c "node /opt/muad/seed-config.mjs"; \
    cp -a /home/node/.openclaw /opt/openclaw-seed; \
    chown -R node:node /opt/openclaw-seed "$PLAYWRIGHT_BROWSERS_PATH" /home/node/.cache; \
    # 留一个 node 拥有的空目录作挂载点：命名卷首挂时按它初始化 → 卷归 node，容器才写得进
    rm -rf /home/node/.openclaw; \
    install -d -m 0700 -o node -g node /home/node/.openclaw

COPY bin/inject-env.mjs      /opt/muad/inject-env.mjs
COPY bin/inject-channels.mjs /opt/muad/inject-channels.mjs
COPY --from=muad-progress-builder /out/muad-progress /usr/local/bin/muad-progress
COPY --from=muad-progress-builder /out/muad-skill-check /usr/local/bin/muad-skill-check
COPY tools/progress-adapters /opt/muad/progress-adapters
COPY tools/muad-run-skill /opt/muad/muad-run-skill
COPY skills /opt/openclaw-skills
COPY entrypoint.sh           /usr/local/bin/muad-entrypoint.sh
RUN chmod +x /usr/local/bin/muad-entrypoint.sh /usr/local/bin/muad-progress /usr/local/bin/muad-skill-check; \
    chown -R node:node /opt/muad/progress-adapters /opt/muad/muad-run-skill /opt/openclaw-skills
ENV MUAD_PROGRESS_ADAPTER_CMD="node /opt/muad/progress-adapters/openclaw/src/adapter.mjs"

USER node
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/muad-entrypoint.sh"]

# muad-openclaw 应用镜像
# 在基础镜像上叠加业务插件代码（bin/ tools/ skills/ entrypoint）
# 变更频率：每次业务代码发布
ARG BASE_TAG=latest
FROM muad-openclaw-base:${BASE_TAG}

LABEL io.muad.image.role="app"

USER root

# ── muad-progress（Go 编译） ──
FROM golang:1.26 AS muad-progress-builder

WORKDIR /src/tools/muad-progress
COPY tools/muad-progress/go.mod ./
COPY tools/muad-progress/cmd ./cmd
COPY tools/muad-progress/internal ./internal
RUN set -eux; \
    go test ./...; \
    go build -o /out/muad-progress ./cmd/muad-progress; \
    go build -o /out/muad-skill-check ./cmd/muad-skill-check

# ── session-manager（npm 编译） ──
FROM muad-openclaw-base:${BASE_TAG} AS session-manager-builder

USER root
WORKDIR /build/session-manager
COPY tools/session-manager/package.json tools/session-manager/package-lock.json tools/session-manager/tsconfig.json ./
RUN npm ci --include=dev
COPY tools/session-manager/src ./src
COPY tools/session-manager/test ./test
COPY tools/session-manager/fixtures ./fixtures
COPY tools/session-manager/openclaw-plugin.mjs tools/session-manager/openclaw.plugin.json ./
RUN npm test

# ── 最终镜像 ──
FROM muad-openclaw-base:${BASE_TAG}

USER root

COPY bin/inject-env.mjs bin/inject-multi-user-config.mjs bin/openclaw-config-renderer.mjs \
    bin/runtime-config-schema.mjs bin/runtime-config-transaction.mjs bin/runtime-image-self-check.mjs \
    bin/startup-context.mjs bin/private-skill-installer.mjs /opt/muad/
COPY bin/inject-channels.mjs /opt/muad/inject-channels.mjs

COPY --from=muad-progress-builder /out/muad-progress /usr/local/bin/muad-progress
COPY --from=muad-progress-builder /out/muad-skill-check /usr/local/bin/muad-skill-check

COPY --from=session-manager-builder /build/session-manager/dist /opt/muad/session-manager/dist
COPY tools/session-manager/package.json tools/session-manager/openclaw-plugin.mjs \
    tools/session-manager/openclaw.plugin.json /opt/muad/session-manager/

COPY tools/progress-adapters /opt/muad/progress-adapters
COPY tools/muad-run-skill/package.json tools/muad-run-skill/openclaw.plugin.json /opt/muad/muad-run-skill/
COPY tools/muad-run-skill/src /opt/muad/muad-run-skill/src
COPY tools/muad-runtime-guard/package.json tools/muad-runtime-guard/openclaw.plugin.json \
    /opt/muad/muad-runtime-guard/
COPY tools/muad-runtime-guard/src /opt/muad/muad-runtime-guard/src
COPY console/backend/internal/crypto/binding_code_spec.json /opt/muad/muad-runtime-guard/src/binding_code_spec.json
COPY tools/runtime-concurrency /opt/muad/runtime-concurrency
COPY skills /opt/openclaw-skills
COPY entrypoint.sh /usr/local/bin/muad-entrypoint.sh

RUN set -eux; \
    ln -s /opt/muad/session-manager/dist/cli.js /usr/local/bin/session-manager; \
    chmod 0755 /usr/local/bin/muad-entrypoint.sh /usr/local/bin/muad-progress \
      /usr/local/bin/muad-skill-check /opt/muad/session-manager/dist/cli.js \
      /opt/muad/runtime-image-self-check.mjs /opt/muad/private-skill-installer.mjs; \
    chmod -R a+rX /opt/muad/session-manager /opt/muad/muad-run-skill /opt/muad/muad-runtime-guard \
      /opt/muad/runtime-concurrency; \
    chown -R node:node /opt/muad/progress-adapters /opt/muad/session-manager \
      /opt/muad/muad-run-skill /opt/muad/muad-runtime-guard /opt/muad/runtime-concurrency \
      /opt/openclaw-skills; \
    su node -c "node /opt/muad/runtime-image-self-check.mjs --image-only"

ENV MUAD_PROGRESS_ADAPTER_CMD="node /opt/muad/progress-adapters/openclaw/src/adapter.mjs"

USER node
WORKDIR /app
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "const net=require('net');const s=net.connect(18789,'127.0.0.1');s.setTimeout(2000);s.once('connect',()=>{s.destroy();process.exit(0)});s.once('timeout',()=>process.exit(1));s.once('error',()=>process.exit(1));"
ENTRYPOINT ["/usr/local/bin/muad-entrypoint.sh"]

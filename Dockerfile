# muad-openclaw 应用镜像
# 在基础镜像上叠加业务插件代码（bin/ tools/ entrypoint）
# 变更频率：每次业务代码发布
#
# 构建参数:
#   BASE_IMAGE  基础镜像 registry 地址（默认 muad-openclaw-base，适用于本地构建）
#   BASE_TAG    基础镜像 tag（默认 latest）
ARG BASE_IMAGE=muad-openclaw-base
ARG BASE_TAG=latest

# ── session-manager（npm 编译） ──
FROM ${BASE_IMAGE}:${BASE_TAG} AS session-manager-builder

USER root
WORKDIR /build/session-manager
COPY tools/session-manager/package.json tools/session-manager/package-lock.json tools/session-manager/tsconfig.json ./
RUN npm ci --include=dev
COPY tools/session-manager/src ./src
COPY tools/session-manager/test ./test
COPY tools/session-manager/fixtures ./fixtures
COPY tools/session-manager/scripts ./scripts
COPY tools/session-manager/openclaw-plugin.mjs tools/session-manager/openclaw.plugin.json ./
# 仅供 builder stage 里的 smoke 测试使用，不 COPY 到最终镜像。
COPY tools/fake-business-platform /build/fake-business-platform
COPY skills /skills
RUN npm test

# ── muad-progress（npm 编译；对 Skill 暴露语言无关 CLI） ──
FROM ${BASE_IMAGE}:${BASE_TAG} AS muad-progress-builder

USER root
WORKDIR /build/muad-progress
COPY tools/muad-progress/package.json tools/muad-progress/package-lock.json tools/muad-progress/tsconfig.json ./
RUN npm ci --include=dev
COPY tools/muad-progress/src ./src
COPY tools/muad-progress/test ./test
# 模板集成测试只读加载实际 Shell/Python/Node 模板；不复制到最终镜像的 CLI 目录。
COPY skills /skills
RUN npm test

# ── runtime guard（锁定生产解析依赖） ──
FROM ${BASE_IMAGE}:${BASE_TAG} AS runtime-guard-deps

USER root
WORKDIR /build/runtime-guard
COPY tools/muad-runtime-guard/package.json tools/muad-runtime-guard/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── 最终镜像 ──
ARG BASE_IMAGE
ARG BASE_TAG
FROM ${BASE_IMAGE}:${BASE_TAG}

LABEL io.muad.image.role="app"

USER root

COPY bin/inject-env.mjs bin/inject-multi-user-config.mjs bin/openclaw-config-renderer.mjs \
    bin/runtime-config-schema.mjs bin/runtime-config-transaction.mjs bin/runtime-image-self-check.mjs \
    bin/startup-context.mjs bin/private-skill-installer.mjs bin/image-plugin-paths.mjs \
    bin/channel-config.mjs bin/prune-managed-plugin-installs.mjs /opt/muad/
COPY bin/inject-channels.mjs /opt/muad/inject-channels.mjs

# 业务 Python 依赖（脚本类 skill 运行时）；基础镜像已含 python3-pip。
# 变更 requirements.txt 只需重建 app 镜像，无需重建基础镜像。
# Skill Python SDK（muad-skill-http）也在其中，按固定版本从 PyPI 安装。
COPY requirements.txt /opt/muad/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages --timeout 60 --retries 5 \
    -i https://pypi.tuna.tsinghua.edu.cn/simple -r /opt/muad/requirements.txt \
    && python3 -c "import muad_skill_http; assert muad_skill_http.EXIT_REQUEST_LIMIT == 86"

# Skills keep using `import requests`; compat is activated per exec by the guard
# (MUAD_REQUESTS_COMPAT=1 + MUAD_BUSINESS_HOSTS) and is a no-op otherwise.
RUN python3 -c "import site, pathlib; p = pathlib.Path(site.getsitepackages()[0]) / 'muad_requests_compat.pth'; p.write_text('import muad_skill_http.compat\n', encoding='utf-8')"

COPY --from=session-manager-builder /build/session-manager/dist /opt/muad/session-manager/dist
COPY tools/session-manager/package.json tools/session-manager/openclaw-plugin.mjs \
    tools/session-manager/openclaw.plugin.json /opt/muad/session-manager/
COPY --from=muad-progress-builder /build/muad-progress/dist /opt/muad/muad-progress/dist
COPY tools/muad-progress/package.json /opt/muad/muad-progress/

COPY tools/muad-runtime-guard/package.json tools/muad-runtime-guard/openclaw.plugin.json \
    /opt/muad/muad-runtime-guard/
COPY tools/muad-runtime-guard/src /opt/muad/muad-runtime-guard/src
COPY --from=runtime-guard-deps /build/runtime-guard/node_modules /opt/muad/muad-runtime-guard/node_modules
COPY console/backend/internal/crypto/binding_code_spec.json /opt/muad/muad-runtime-guard/src/binding_code_spec.json
COPY tools/shared /opt/muad/shared
COPY entrypoint.sh /usr/local/bin/muad-entrypoint.sh

RUN set -eux; \
    ln -s /opt/muad/session-manager/dist/cli.js /usr/local/bin/session-manager; \
    ln -s /opt/muad/muad-progress/dist/cli.js /usr/local/bin/muad-progress; \
    chmod 0755 /usr/local/bin/muad-entrypoint.sh /opt/muad/session-manager/dist/cli.js \
      /opt/muad/muad-progress/dist/cli.js \
      /opt/muad/runtime-image-self-check.mjs /opt/muad/private-skill-installer.mjs \
      /opt/muad/prune-managed-plugin-installs.mjs; \
    chmod -R a+rX /opt/muad/session-manager /opt/muad/muad-progress \
      /opt/muad/muad-runtime-guard /opt/muad/shared; \
    chown -R node:node /opt/muad/session-manager /opt/muad/muad-progress /opt/muad/muad-runtime-guard \
      /opt/muad/shared; \
    su node -c "node /opt/muad/runtime-image-self-check.mjs --image-only"

USER node
WORKDIR /app
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "const net=require('net');const s=net.connect(18789,'127.0.0.1');s.setTimeout(2000);s.once('connect',()=>{s.destroy();process.exit(0)});s.once('timeout',()=>process.exit(1));s.once('error',()=>process.exit(1));"
ENTRYPOINT ["/usr/local/bin/muad-entrypoint.sh"]

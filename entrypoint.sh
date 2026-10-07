#!/usr/bin/env bash
# 多用户 Pod 入口：
#   ① Pod 卷为空 → 从镜像种子(/opt/openclaw-seed)播种基线状态（含通道插件 + 基线配置）
#   ② 注入外部面 env（bot 凭证 / LLM key / 网关 token）→ openclaw.json
#   ③ 启动网关
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
POD_ID="${MUAD_POD_ID:-${PC_USER:-}}"
[[ -n "${POD_ID}" ]] || { echo "[muad] FATAL: MUAD_POD_ID 未设置" >&2; exit 1; }

if [[ ! -f "${STATE_DIR}/openclaw.json" ]]; then
  echo "[muad] 首启：从镜像种子播种 → ${STATE_DIR}"
  mkdir -p "${STATE_DIR}"
  cp -r /opt/openclaw-seed/. "${STATE_DIR}/"
fi

node /opt/muad/inject-env.mjs
node /opt/muad/prune-managed-plugin-installs.mjs
node /opt/muad/runtime-image-self-check.mjs --skip-openclaw-cli

# ④ 目标版本状态迁移：官方容器入口会在启动 Gateway 前执行 Doctor；本项目覆盖了
#    ENTRYPOINT，必须显式承接，否则会话/配置迁移不会自动发生。fail-closed：无法
#    安全修复挂载状态时退出，由控制面停在 error（不自动回退）。
echo "[muad] pod=${POD_ID} 执行 Doctor 自动迁移（fail-closed）"
openclaw doctor --fix --non-interactive

# ⑤ 9.8 通道入口队列仅对 trusted-official 插件开放：mattermost 若以镜像路径加载
#    （origin=config）会被 PLUGIN_TRUST_REFUSED 拒绝并让通道退出，必须以官方 npm
#    安装。旧状态里可能仍带路径加载（旧渲染器输出），先本地剥离再安装；控制面后续
#    重渲染同样不再写入该路径。best-effort：失败仅降级 mattermost，不影响其它通道。
ensure_trusted_mattermost() {
  if openclaw plugins inspect mattermost --json 2>/dev/null | grep -q '"trusted-official"'; then
    return 0
  fi
  local version
  version="$(node -e 'try{console.log(require("/opt/openclaw-plugins/mattermost/package.json").version)}catch{}' 2>/dev/null)"
  if [[ -z "${version}" ]]; then
    echo "[muad] WARN: 无法读取镜像内 mattermost 版本，跳过可信安装" >&2
    return 0
  fi
  echo "[muad] mattermost 非 trusted-official，剥离路径加载并执行 npm 安装（${version}）"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    try {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      const paths = config?.plugins?.load?.paths;
      if (Array.isArray(paths)) {
        const kept = paths.filter((root) => !String(root).includes("/openclaw-plugins/mattermost"));
        if (kept.length !== paths.length) {
          config.plugins.load.paths = kept;
          fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
          console.log("[muad] 已从本地配置剥离 mattermost 路径加载");
        }
      }
    } catch (error) {
      console.error("[muad] 剥离 mattermost 路径失败: " + error.message);
    }
  ' "${STATE_DIR}/openclaw.json"
  openclaw plugins registry --refresh >/dev/null 2>&1 || true
  if openclaw plugins install "@openclaw/mattermost@${version}"; then
    echo "[muad] mattermost 已安装为可信插件（trusted-official）"
  else
    echo "[muad] WARN: mattermost npm 安装失败（网络不可用？）；该通道降级，其它通道不受影响" >&2
  fi
}
ensure_trusted_mattermost

# ⑥ 定时任务：用 openclaw 原生 cron——用户在企微让 bot 设定时任务，agent 自建并自动绑定该会话为投递目标。
# 无需外置 scheduler / 手动写 target（已验证 agent 的 cron 工具不撞 scope 门控）。

echo "[muad] pod=${POD_ID} 启动 openclaw gateway"
exec openclaw gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port 18789

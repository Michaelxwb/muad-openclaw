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
node /opt/muad/runtime-image-self-check.mjs

# ⑥ 定时任务：用 openclaw 原生 cron——用户在企微让 bot 设定时任务，agent 自建并自动绑定该会话为投递目标。
# 无需外置 scheduler / 手动写 target（已验证 agent 的 cron 工具不撞 scope 门控）。

echo "[muad] pod=${POD_ID} 启动 openclaw gateway"
exec openclaw gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port 18789

#!/usr/bin/env bash
# 每用户容器入口：
#   ① per-user 卷为空 → 从镜像种子(/opt/openclaw-seed)播种基线状态（含 WeCom 插件 + 基线配置）
#   ② 注入外部面 env（bot 凭证 / LLM key / 网关 token）→ openclaw.json
#   ③ 启动网关
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
[[ -n "${PC_USER:-}" ]] || { echo "[muad] FATAL: PC_USER 未设置" >&2; exit 1; }

if [[ ! -f "${STATE_DIR}/openclaw.json" ]]; then
  echo "[muad] 首启：从镜像种子播种 → ${STATE_DIR}"
  mkdir -p "${STATE_DIR}"
  cp -r /opt/openclaw-seed/. "${STATE_DIR}/"
fi

node /opt/muad/inject-env.mjs
# 设默认模型（写 agents.defaults.model.primary；CLI 产出合法 schema，无网关也可）
[[ -n "${LLM_MODEL:-}" ]] && openclaw models set "${LLM_PROVIDER:-deepseek}/${LLM_MODEL}" >/dev/null 2>&1 || true

# ⑥ 定时任务：用 openclaw 原生 cron——用户在企微让 bot 设定时任务，agent 自建并自动绑定该会话为投递目标。
# 无需外置 scheduler / 手动写 target（已验证 agent 的 cron 工具不撞 scope 门控）。

echo "[muad] user=${PC_USER} 启动 openclaw gateway"
exec openclaw gateway --bind "${OPENCLAW_GATEWAY_BIND:-lan}" --port 18789

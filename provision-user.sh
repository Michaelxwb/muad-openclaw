#!/usr/bin/env bash
# ⚠️ 已废弃：本脚本是旧版"每用户手动开通"流程，不再作为受支持部署路径。
# worker 镜像入口（entrypoint.sh → inject-env.mjs）要求 Console 下发的
# MUAD_RUNTIME_CONFIG Runtime DTO（含 agents/providers/guard 配置与 service
# token），本脚本无法生成——容器必然 CrashLoop。请改用 Console 的 Pod 管理
# （Docker/K8s RuntimeDriver）开通用户。
# 仅当你有完整 DTO 下发通道且确需保留旧流时，设 MUAD_ALLOW_LEGACY_PROVISION=1 强制运行。
#
# 历史用法：
#   1) ./provision-user.sh <userId> --init   # 生成 users/<userId>/config 模板，去填
#   2) ./provision-user.sh <userId>          # 读 config → 起容器（起来即用）
#   ./provision-user.sh <userId> --down      # 停该用户容器（状态保留在卷）
# 凭证只落 users/<userId>/{config,.env}（chmod 600），不进镜像/不入 git。
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${MUAD_ALLOW_LEGACY_PROVISION:-0}" != "1" ]]; then
  echo "FATAL: provision-user.sh 已废弃——worker 镜像要求 Console 下发的 Runtime DTO" >&2
  echo "       （entrypoint 依赖 MUAD_RUNTIME_CONFIG，手动脚本无法提供），容器必然 CrashLoop。" >&2
  echo "       请改用 Console 的 Pod 管理（Docker/K8s RuntimeDriver）开通用户。" >&2
  echo "       若确需保留旧流：export MUAD_ALLOW_LEGACY_PROVISION=1 后重试。" >&2
  exit 1
fi

USER_ID="${1:?用法: provision-user.sh <userId> [--init|--down]}"; shift || true
IMAGE="${MUAD_OC_IMAGE:-ghcr.io/${MUAD_OC_OWNER:-OWNER}/muad-openclaw:latest}"
ACTION="start"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --init) ACTION="init"; shift ;;
    --down) ACTION="down"; shift ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
[[ "${USER_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "FATAL: userId 非法: '${USER_ID}'" >&2; exit 1; }

DIR="$(pwd)/users/${USER_ID}"
COMPOSE="${DIR}/compose.yml"

# Parse KEY=VALUE config without shell-sourcing (rejects bare tokens / command injection).
load_user_config() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ "${line}" != *=* ]]; then
      echo "FATAL: config line must be KEY=VALUE (got: ${line})" >&2
      exit 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "FATAL: invalid config key: ${key}" >&2; exit 1; }
    printf -v "${key}" '%s' "${value}"
    export "${key}"
  done < "${file}"
}

case "${ACTION}" in
  init)
    [[ -e "${DIR}/config" ]] && { echo "已存在: ${DIR}/config" >&2; exit 2; }
    mkdir -p "${DIR}"; cp users/_template.config "${DIR}/config"; chmod 600 "${DIR}/config"
    echo "已生成: ${DIR}/config —— 填好 WECOM_*/LLM_* 后运行: ./provision-user.sh ${USER_ID}"
    ;;
  down)
    [[ -f "${COMPOSE}" ]] || { echo "FATAL: ${DIR} 未开通" >&2; exit 1; }
    docker compose -p "muad-oc-${USER_ID}" -f "${COMPOSE}" down
    echo "已停: muad-oc-${USER_ID}（状态留在卷 muad-oc-${USER_ID}-state）"
    ;;
  start)
    [[ -f "${DIR}/config" ]] || { echo "FATAL: 先 ./provision-user.sh ${USER_ID} --init 并填好 config" >&2; exit 1; }
    # KEY=VALUE only — never shell-source config (avoids bare sk- lines / injection)
    load_user_config "${DIR}/config"
    # LLM_* 已废弃（pod 侧无消费者，模型只能经 Console DTO 下发），只保留通道凭证校验。
    : "${WECOM_BOT_ID:?config 缺 WECOM_BOT_ID}" "${WECOM_SECRET:?config 缺 WECOM_SECRET}"
    # 合成运行时 .env = config + 生成的网关 token
    umask 077
    {
      while IFS= read -r line || [[ -n "${line}" ]]; do
        [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
        [[ "${line}" == *=* ]] || continue
        printf '%s\n' "${line}"
      done < "${DIR}/config"
      echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 16)"
    } > "${DIR}/.env"
    chmod 600 "${DIR}/.env"
    # 渲染 compose（| 作分隔符避开路径里的 /）；SKILLS_DIR=项目根共享 skill 目录（所有用户同一份）
    mkdir -p "$(pwd)/skills"
    sed -e "s|\${PC_USER}|${USER_ID}|g" -e "s|\${MUAD_IMAGE}|${IMAGE}|g" \
        -e "s|\${SKILLS_DIR}|$(pwd)/skills|g" \
        compose.template.yml > "${COMPOSE}"
    docker compose -p "muad-oc-${USER_ID}" -f "${COMPOSE}" up -d
    echo "已启动: muad-oc-${USER_ID}（image=${IMAGE}）"
    echo "  看 WeCom 连上: docker logs -f muad-oc-${USER_ID} | grep -i Authenticated"
    ;;
esac

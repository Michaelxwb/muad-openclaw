#!/usr/bin/env bash
# 管理员两步起一个用户容器：
#   1) ./provision-user.sh <userId> --init   # 生成 users/<userId>/config 模板，去填
#   2) ./provision-user.sh <userId>          # 读 config → 起容器（起来即用）
#   ./provision-user.sh <userId> --down      # 停该用户容器（状态保留在卷）
# 凭证只落 users/<userId>/{config,.env}（chmod 600），不进镜像/不入 git。
set -euo pipefail
cd "$(dirname "$0")"

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
    # 校验必填
    set -a; . "${DIR}/config"; set +a
    : "${WECOM_BOT_ID:?config 缺 WECOM_BOT_ID}" "${WECOM_SECRET:?config 缺 WECOM_SECRET}" "${LLM_API_KEY:?config 缺 LLM_API_KEY}"
    # 合成运行时 .env = config + 生成的网关 token
    umask 077
    { cat "${DIR}/config"; echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 16)"; } > "${DIR}/.env"
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

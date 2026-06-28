#!/usr/bin/env bash
# k8s 版开通（控制面 ③）。复用与 Docker 版完全相同的镜像 + env 契约，载体换成 k8s Secret。
# 用法:
#   provision-user-k8s.sh <userId> --init                 # 生成 users/<userId>/config 模板
#   provision-user-k8s.sh <userId> [--namespace ns]       # 读 config → 渲染清单 → kubectl apply
#   provision-user-k8s.sh <userId> --delete [--namespace ns]
set -euo pipefail
cd "$(dirname "$0")/.."   # 项目根

USER_ID="${1:?用法: provision-user-k8s.sh <userId> [--init|--delete]}"; shift || true
IMAGE="${MUAD_OC_IMAGE:-ghcr.io/${MUAD_OC_OWNER:-OWNER}/muad-openclaw:latest}"
NS="default"; ACTION="apply"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --init) ACTION="init"; shift ;;
    --delete) ACTION="delete"; shift ;;
    --namespace|-n) NS="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
[[ "${USER_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "FATAL: userId 非法" >&2; exit 1; }
DIR="$(pwd)/users/${USER_ID}"

case "${ACTION}" in
  init)
    [[ -e "${DIR}/config" ]] && { echo "已存在: ${DIR}/config" >&2; exit 2; }
    mkdir -p "${DIR}"; cp users/_template.config "${DIR}/config"; chmod 600 "${DIR}/config"
    echo "已生成: ${DIR}/config —— 填好后运行: $0 ${USER_ID} -n ${NS}"
    ;;
  delete)
    kubectl -n "${NS}" delete statefulset,secret -l "muad-user=${USER_ID}" --ignore-not-found
    echo "已删: muad-oc-${USER_ID}（PVC 默认保留，含状态；要连卷一起删手动 kubectl delete pvc -l muad-user=${USER_ID}）"
    ;;
  apply)
    [[ -f "${DIR}/config" ]] || { echo "FATAL: 先 $0 ${USER_ID} --init 填好 config" >&2; exit 1; }
    set -a; . "${DIR}/config"; set +a
    : "${WECOM_BOT_ID:?config 缺 WECOM_BOT_ID}" "${WECOM_SECRET:?缺 WECOM_SECRET}" "${LLM_API_KEY:?缺 LLM_API_KEY}"
    TOKEN="$(openssl rand -hex 16)"
    # 渲染模板（占位用 __KEY__，sed 替换；secret 经 Secret.stringData 注入，不落盘明文清单到 git）
    RENDERED="$(mktemp)"; trap 'rm -f "$RENDERED"' EXIT
    sed -e "s|__USER__|${USER_ID}|g" \
        -e "s|__IMAGE__|${IMAGE}|g" \
        -e "s|__WECOM_BOT_ID__|${WECOM_BOT_ID}|g" \
        -e "s|__WECOM_SECRET__|${WECOM_SECRET}|g" \
        -e "s|__LLM_PROVIDER__|${LLM_PROVIDER:-deepseek}|g" \
        -e "s|__LLM_API_KEY__|${LLM_API_KEY}|g" \
        -e "s|__LLM_MODEL__|${LLM_MODEL:-deepseek-v4-pro}|g" \
        -e "s|__LLM_BASE_URL__|${LLM_BASE_URL:-https://api.deepseek.com}|g" \
        -e "s|__GATEWAY_TOKEN__|${TOKEN}|g" \
        k8s/user.template.yaml > "${RENDERED}"
    kubectl -n "${NS}" apply -f "${RENDERED}"
    echo "已部署: muad-oc-${USER_ID} (ns=${NS})"
    echo "  看日志: kubectl -n ${NS} logs -f statefulset/muad-oc-${USER_ID} | grep -i Authenticated"
    ;;
esac

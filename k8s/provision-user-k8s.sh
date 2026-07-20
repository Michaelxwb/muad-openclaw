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
    key="${line%%=*}"; value="${line#*=}"
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
    echo "已生成: ${DIR}/config —— 填好后运行: $0 ${USER_ID} -n ${NS}"
    ;;
  delete)
    kubectl -n "${NS}" delete statefulset,secret -l "muad-user=${USER_ID}" --ignore-not-found
    echo "已删: muad-oc-${USER_ID}（PVC 默认保留，含状态；要连卷一起删手动 kubectl delete pvc -l muad-user=${USER_ID}）"
    ;;
  apply)
    [[ -f "${DIR}/config" ]] || { echo "FATAL: 先 $0 ${USER_ID} --init 填好 config" >&2; exit 1; }
    load_user_config "${DIR}/config"
    : "${WECOM_BOT_ID:?config 缺 WECOM_BOT_ID}" "${WECOM_SECRET:?缺 WECOM_SECRET}" "${LLM_API_KEY:?缺 LLM_API_KEY}"
    TOKEN="$(openssl rand -hex 16)"
    # Prefer --from-literal for secrets (no shell-source, no sed of secret values into YAML).
    kubectl -n "${NS}" create secret generic "muad-oc-${USER_ID}" \
      --from-literal=WECOM_BOT_ID="${WECOM_BOT_ID}" \
      --from-literal=WECOM_SECRET="${WECOM_SECRET}" \
      --from-literal=LLM_PROVIDER="${LLM_PROVIDER:-deepseek}" \
      --from-literal=LLM_API_KEY="${LLM_API_KEY}" \
      --from-literal=LLM_MODEL="${LLM_MODEL:-deepseek-v4-pro}" \
      --from-literal=LLM_BASE_URL="${LLM_BASE_URL:-https://api.deepseek.com}" \
      --from-literal=OPENCLAW_GATEWAY_TOKEN="${TOKEN}" \
      --dry-run=client -o yaml | kubectl -n "${NS}" label --local -f - \
        app=muad-openclaw "muad-user=${USER_ID}" -o yaml | kubectl -n "${NS}" apply -f -
    RENDERED="$(mktemp)"; trap 'rm -f "$RENDERED"' EXIT
    # Apply workload only (Secret already applied above).
    awk '
      function flush() {
        if (doc == "") return
        if (doc !~ /(^|\n)kind:[[:space:]]*Secret([[:space:]]|$)/) printf "%s", doc
        doc = ""
      }
      /^---$/ { flush(); doc = $0 ORS; next }
      doc != "" { doc = doc $0 ORS; next }
      { print }
      END { flush() }
    ' k8s/user.template.yaml \
      | sed -e "s|__USER__|${USER_ID}|g" -e "s|__IMAGE__|${IMAGE}|g" > "${RENDERED}"
    kubectl -n "${NS}" apply -f "${RENDERED}"
    echo "已部署: muad-oc-${USER_ID} (ns=${NS})"
    echo "  看日志: kubectl -n ${NS} logs -f statefulset/muad-oc-${USER_ID} | grep -i Authenticated"
    ;;
esac

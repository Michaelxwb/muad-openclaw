#!/usr/bin/env bash
# ⚠️ 已废弃：与 provision-user.sh 相同，本脚本无法提供 worker 镜像入口要求的
# MUAD_RUNTIME_CONFIG Runtime DTO（含 agents/providers/guard 配置与 service token），
# 按此开通的 StatefulSet 必然 CrashLoopBackOff。请改用 Console 的 Pod 管理（K8s
# RuntimeDriver）。确需保留旧流时设 MUAD_ALLOW_LEGACY_PROVISION=1。
# 历史用法:
#   provision-user-k8s.sh <userId> --init                 # 生成 users/<userId>/config 模板
#   provision-user-k8s.sh <userId> [--namespace ns]       # 读 config → 渲染清单 → kubectl apply
#   provision-user-k8s.sh <userId> --delete [--namespace ns]
set -euo pipefail
cd "$(dirname "$0")/.."   # 项目根

if [[ "${MUAD_ALLOW_LEGACY_PROVISION:-0}" != "1" ]]; then
  echo "FATAL: provision-user-k8s.sh 已废弃——worker 镜像要求 Console 下发的 Runtime DTO，" >&2
  echo "       手动脚本无法提供，StatefulSet 必然 CrashLoopBackOff。请改用 Console 的" >&2
  echo "       K8s RuntimeDriver 开通用户。确需保留旧流：export MUAD_ALLOW_LEGACY_PROVISION=1" >&2
  exit 1
fi

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
    : "${WECOM_BOT_ID:?config 缺 WECOM_BOT_ID}" "${WECOM_SECRET:?缺 WECOM_SECRET}"
    TOKEN="$(openssl rand -hex 16)"
    # Prefer --from-literal for secrets (no shell-source, no sed of secret values into YAML).
    # LLM_* 已废弃（pod 侧无消费者，模型只能经 Console DTO 下发），不再注入。
    kubectl -n "${NS}" create secret generic "muad-oc-${USER_ID}" \
      --from-literal=WECOM_BOT_ID="${WECOM_BOT_ID}" \
      --from-literal=WECOM_SECRET="${WECOM_SECRET}" \
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

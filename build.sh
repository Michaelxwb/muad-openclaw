#!/usr/bin/env bash
# muad-openclaw 分层构建脚本
#
# 用法:
#   ./build.sh base [tag]                    # 构建基础镜像
#   ./build.sh app [base-tag] [app-tag]      # 构建应用镜像
#   ./build.sh all [base-tag] [app-tag]      # 全量构建
#
# 基础镜像包含 OpenClaw + Chromium/Playwright + 通道插件，变更频率低。
# 应用镜像在基础镜像上叠加业务插件代码，每次发布都重新构建。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

build_base() {
  local tag="${1:-latest}"
  echo "==> 构建基础镜像 muad-openclaw-base:${tag}"
  docker build -f "${SCRIPT_DIR}/Dockerfile.base" -t "muad-openclaw-base:${tag}" "${SCRIPT_DIR}"
  echo "==> 基础镜像构建完成: muad-openclaw-base:${tag}"
}

build_app() {
  local base_tag="${1:-latest}"
  local app_tag="${2:-latest}"
  echo "==> 构建应用镜像 muad-openclaw:${app_tag}（基于 muad-openclaw-base:${base_tag}）"
  docker build -f "${SCRIPT_DIR}/Dockerfile" \
    --build-arg "BASE_TAG=${base_tag}" \
    -t "muad-openclaw:${app_tag}" \
    "${SCRIPT_DIR}"
  echo "==> 应用镜像构建完成: muad-openclaw:${app_tag}"
}

case "${1:-}" in
  base)
    build_base "${2:-latest}"
    ;;
  app)
    build_app "${2:-latest}" "${3:-latest}"
    ;;
  all)
    base_tag="${2:-latest}"
    app_tag="${3:-latest}"
    build_base "${base_tag}"
    build_app "${base_tag}" "${app_tag}"
    ;;
  *)
    echo "用法: $0 {base|app|all} [arg...]"
    echo ""
    echo "  base [tag]                    构建基础镜像"
    echo "  app [base-tag] [app-tag]      构建应用镜像"
    echo "  all [base-tag] [app-tag]      全量构建"
    echo ""
    echo "示例:"
    echo "  $0 base 1.0                   # 构建 base:1.0"
    echo "  $0 app v2.3.0                 # 基于 base:latest 构建 app:v2.3.0"
    echo "  $0 app 1.0 v2.3.0             # 基于 base:1.0 构建 app:v2.3.0"
    echo "  $0 all 1.0 v2.3.0             # 全量构建"
    exit 1
    ;;
esac

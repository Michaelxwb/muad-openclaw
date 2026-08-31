#!/bin/bash
# muad-openclaw runtime CLI 构建脚本（千流 Task0，mss-fe-node:20.9.0 镜像内执行）
#
# 仓库：git.sangfor.com/53842/muad-openclaw（千流已 checkout 整个仓库）
#       工作目录下 tools/session-manager/ 与 tools/muad-progress/ 已就绪
#
# 步骤：分别 npm install → npm run build → 放到 /tmp/muad-openclaw-session-manager/（千流缓存上传）
#
# 不跑 npm test：mss-fe-node:20.9.0 镜像不含 python3，cross-language 合约测试会失败
# 与 console task1-frontend.sh 范式一致（只 build 不 test），CI 目的是产出 dist
# 跨语言 CLI 合约测试由开发本地或专门测试流水线负责
#
# 与 task1-frontend.sh 的区别：
#   - task1 构建 console 前端，缓存目录 /tmp/muad-console-frontend/
#   - 本脚本构建 session-manager 与 muad-progress，缓存目录 /tmp/muad-openclaw-session-manager/
#   - 两者都是 npm 任务，可并行（Task0 与 Task1 needs: []）
#
# 千流缓存：
#   Task0 配置「缓存上传路径」为 /tmp/muad-openclaw-session-manager/
#   千流 task 结束后会自动把该目录打包上传到缓存服务
#   Task4 配置「缓存下载路径」为 /tmp/muad-openclaw-session-manager/，启动时自动解压
set -e

DIST_VERSION=$(date +%s)
CACHE_DIR="/tmp/muad-openclaw-session-manager"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
SESSION_MANAGER_DIR="${REPO_ROOT}/tools/session-manager"
PROGRESS_DIR="${REPO_ROOT}/tools/muad-progress"

log_section() { echo "==========================================="; echo "$1"; echo "==========================================="; }
log_info()    { echo "[INFO] $1"; }

build_package() {
    local package_name="$1"
    local package_dir="$2"
    log_section "安装依赖并构建 ${package_name}"
    (
      cd "${package_dir}"
      log_info "${package_name} 开始安装依赖: $(date)"
      npm install --registry=http://npm.uedc.sangfor.com.cn/
      log_info "${package_name} 安装依赖完成: $(date)"
    # 不跑 npm test：mss-fe-node:20.9.0 镜像不含 python3，cross-language 合约测试会失败
    # 与 console task1-frontend.sh 范式一致（只 build 不 test），CI 目的是产出 dist
      log_info "${package_name} 开始构建: $(date)"
      npm run build
      log_info "${package_name} 构建完成: $(date)"
      ls -la dist/
    )
}

build_code() {
    node --version && npm --version
    build_package "session-manager" "${SESSION_MANAGER_DIR}"
    build_package "muad-progress" "${PROGRESS_DIR}"
    test -f "${REPO_ROOT}/tools/muad-progress/dist/cli.js"
}

stage_artifacts() {
    log_section "打包 runtime CLI dist 并放到千流缓存目录"
    # 清空缓存目录再写入，避免多次构建后旧 tar 堆积
    mkdir -p "${CACHE_DIR}"
    rm -rf "${CACHE_DIR:?}/"*
    tar -czf "${CACHE_DIR}/session-manager-dist-${DIST_VERSION}.tar.gz" \
      -C "${SESSION_MANAGER_DIR}/dist" .
    # 保留原 dist 路径兼容既有 Task4，并为 muad-progress 使用独立缓存子目录。
    mkdir -p "${CACHE_DIR}/dist" "${CACHE_DIR}/muad-progress-dist"
    cp -r "${SESSION_MANAGER_DIR}/dist/." "${CACHE_DIR}/dist/"
    cp -r "${PROGRESS_DIR}/dist/." "${CACHE_DIR}/muad-progress-dist/"
    test -f "${CACHE_DIR}/muad-progress-dist/cli.js"
    # 把 DIST_VERSION 写到缓存目录的固定文件，供 Task4 读取
    echo "${DIST_VERSION}" > "${CACHE_DIR}/DIST_VERSION"
    log_info "已写入缓存目录: ${CACHE_DIR}/session-manager-dist-${DIST_VERSION}.tar.gz"
    log_info "已展开 dist 到: ${CACHE_DIR}/dist/"
    log_info "已展开 muad-progress dist 到: ${CACHE_DIR}/muad-progress-dist/"
    log_info "已写入缓存目录: ${CACHE_DIR}/DIST_VERSION"
    log_info "千流将自动上传该目录到缓存服务，供 Task4 下载使用"
    echo "==========================================="
    echo "DIST_VERSION=${DIST_VERSION}"
    echo "==========================================="
}

main() {
    log_section "Task0: runtime CLI 构建开始"
    log_info "DIST_VERSION:  ${DIST_VERSION}"
    log_info "CACHE_DIR:     ${CACHE_DIR}"
    build_code
    stage_artifacts
    log_section "Task0: 脚本执行完成"
}

main "$@"

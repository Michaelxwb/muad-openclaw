#!/bin/bash
# muad-console 后端编译脚本（被 task2-backend.sh 调用）
#
# 步骤：从千流缓存读前端 dist → 解压到 embed 目录 → go build → 输出二进制到当前目录
# 产物：./muad-console（静态二进制，已内嵌前端 dist）
#
# 输入环境变量：
#   DIST_VERSION      - 前端制品版本号（与 task1 一致）
#
# 千流缓存：
#   Task2 启动时千流自动把 Task1 上传的 /tmp/muad-console-frontend/ 解压到本地同名路径
#   本脚本直接从该路径读 frontend-dist-<DIST_VERSION>.tar.gz，无需 sfspm
set -e

CUR_PATH=$(pwd)
echo "开始编译..."
ls -alt ./

# 1. 从千流缓存目录读前端 dist 并解压到 embed 目录
FRONTEND_CACHE_DIR="/tmp/muad-console-frontend"
FRONTEND_TAR="${FRONTEND_CACHE_DIR}/frontend-dist-${DIST_VERSION}.tar.gz"
if [ ! -f "${FRONTEND_TAR}" ]; then
    echo "[ERROR] 前端 dist 缓存缺失: ${FRONTEND_TAR}"
    echo "请检查 Task1 缓存上传路径与 Task2 缓存下载路径是否一致配置为 ${FRONTEND_CACHE_DIR}"
    exit 1
fi
mkdir -p ./console/backend/internal/web/dist
tar -xzf ${FRONTEND_TAR} -C ./console/backend/internal/web/dist
log_info() { echo "[INFO] $1"; }
log_info "前端 dist 已从缓存解压到 embed 目录"

# 2. go build（启用 prod tag 触发 embed）
cd ./console/backend
export GOPROXY=http://mirrors.sangfor.org/nexus/repository/go-proxy-group
export GOSUMDB=off
# 禁用 toolchain 自动下载：go-compiler 镜像里是 1.25.10，go.mod 写 1.26.0 会触发下载 1.26.0 toolchain，
# 但 GOSUMDB=off 会导致 toolchain 模块校验失败。强制用镜像自带的 go 二进制即可（向后兼容 1.26.0 代码）
export GOTOOLCHAIN=local
CGO_ENABLED=0 go build -tags prod -ldflags="-s -w" -o ${CUR_PATH}/muad-console ./cmd/console

cd ${CUR_PATH}
ls -alt ./
echo "编译完成: ${CUR_PATH}/muad-console"

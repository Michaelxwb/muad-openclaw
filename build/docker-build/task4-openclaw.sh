#!/bin/bash
# muad-openclaw 应用镜像构建脚本（千流 Task4，docker:latest 镜像内执行）
#
# 与 task3-assemble.sh 的区别：
#   - task3 构建 muad-console 镜像 + helm package + sfspm upload tar
#   - 本脚本只构建 muad-openclaw 应用镜像并推送，不构建 helm，不上传 generic tar
#   - 原因：openclaw 镜像通过 runtime.defaultImage 被 console 后端动态拉起，
#          不走 helm 部署链路，无需 helm package
#
# 步骤：
#   1. 分支路由决定仓库（mss-dev / mss-release）
#   2. docker login
#   3. 从千流缓存读取 Task0 预构建的 session-manager 与 muad-progress dist，
#      分别复制到工作区 tools/ 下的对应 dist/
#   4. docker build -f build/docker-build/Dockerfile.openclaw（上下文=仓库根，直接 COPY 已构建的 dist）
#   5. docker tag + push 到 docker.sangfor.com/<repo>/muad-openclaw:<tag>
#
# 依赖：Task0（npm 构建 session-manager 与 muad-progress，产出 dist 到缓存目录）
#
# 输入环境变量：
#   CI_COMMIT_BRANCH  - 千流注入的分支名
#   CI_COMMIT_TAG     - 千流注入的 tag 名（如有，优先用 mss-release）
#   CI_PROJECT_NAME    - 千流注入的项目名（如 muad-openclaw）
#   DOCKER_USER        - 内网仓库账号（必填，由千流 secret 注入）
#   DOCKER_PASS        - 内网仓库密码（必填，由千流 secret 注入）
#
# 千流缓存：
#   Task4 配置「缓存下载路径」为 /tmp/muad-openclaw-session-manager/（接收 Task0 的 dist）
#   Task4 不需要缓存上传（已是最末端 task）
set -e

CUR_PATH=$(pwd)
cd ${CUR_PATH}

# ============================================================
# 0. 项目名硬编码（不读 CI_PROJECT_NAME）
# ============================================================
# 千流会按流水线项目自动注入 CI_PROJECT_NAME，而 muad-openclaw 与 muad-console
# 共用同一条流水线（同一仓库根），注入值是 muad-console，${VAR:-default} 兜底
# 不会生效。这里硬编码为 muad-openclaw，确保镜像推到正确的仓库命名空间。
export CI_PROJECT_NAME="muad-openclaw"

# ============================================================
# 1. 分支路由：决定 docker 仓库名
# ============================================================
if echo "${CI_COMMIT_BRANCH}" | grep -qE '^feature|^bug' ; then
  remote_repository_docker="mss-dev"
elif echo "${CI_COMMIT_BRANCH}" | grep -qE '^patch|master|release' ; then
  remote_repository_docker="mss-release"
else
  remote_repository_docker="mss-dev"
fi

if echo "${CI_COMMIT_TAG}" | grep -qE '^v' ; then
  remote_repository_docker="mss-release"
fi
export DEVOPS_PLATFORM="${remote_repository_docker}"

echo "项目: ${CI_PROJECT_NAME}"
echo "分支: ${CI_COMMIT_BRANCH}"
echo "Tag:  ${CI_COMMIT_TAG}"
echo "仓库: ${DEVOPS_PLATFORM}"

# ============================================================
# 2. docker login
# ============================================================
: "${DOCKER_USER:?DOCKER_USER is required}"
: "${DOCKER_PASS:?DOCKER_PASS is required}"
printf '%s' "${DOCKER_PASS}" | docker login docker.sangfor.com \
  --username "${DOCKER_USER}" --password-stdin

# ============================================================
# 3. 从缓存目录读取 Task0 预构建的 runtime CLI dist
# ============================================================
CACHE_DIR="/tmp/muad-openclaw-session-manager"
SESSION_MANAGER_CACHE="${CACHE_DIR}/dist"
SESSION_MANAGER_DEST="${CUR_PATH}/tools/session-manager/dist"
PROGRESS_CACHE="${CACHE_DIR}/muad-progress-dist"
PROGRESS_DEST="${CUR_PATH}/tools/muad-progress/dist"

copy_dist() {
  local package_name="$1"
  local source_dir="$2"
  local destination_dir="$3"
  if [ ! -f "${source_dir}/cli.js" ]; then
    echo "[ERROR] ${package_name} 缓存入口缺失: ${source_dir}/cli.js"
    echo "[ERROR] 请检查 Task0 和 Task4 的缓存路径配置: ${CACHE_DIR}"
    exit 1
  fi
  echo "[INFO] 恢复 ${package_name} dist: ${source_dir} -> ${destination_dir}"
  rm -rf "${destination_dir}"
  mkdir -p "${destination_dir}"
  cp -r "${source_dir}/." "${destination_dir}/"
  ls -la "${destination_dir}/"
}

copy_dist "session-manager" "${SESSION_MANAGER_CACHE}" "${SESSION_MANAGER_DEST}"
copy_dist "muad-progress" "${PROGRESS_CACHE}" "${PROGRESS_DEST}"
test -f "${CUR_PATH}/tools/muad-progress/dist/cli.js"
echo "[INFO] runtime CLI dist 读取完成"

# ============================================================
# 4. 构建镜像（上下文=仓库根，Dockerfile 在 build/docker-build/ 下）
# ============================================================
DOCKERFILE_PATH="build/docker-build/Dockerfile.openclaw"
if [ ! -f "${DOCKERFILE_PATH}" ]; then
  echo "[ERROR] Dockerfile 缺失: ${DOCKERFILE_PATH}"
  exit 1
fi

CURRENT_TIME=$(date "+%y%m%d%H%M")
TAG="${CURRENT_TIME}"
if [ -n "${CI_COMMIT_TAG}" ]; then
  TAG="${CI_COMMIT_TAG}"
elif [ -n "${CI_COMMIT_BRANCH}" ]; then
  TAG="${TAG}${CI_COMMIT_BRANCH}"
fi

IMAGE="docker.sangfor.com/${DEVOPS_PLATFORM}/${CI_PROJECT_NAME}:${TAG}"
echo "[INFO] 开始构建镜像: ${IMAGE}"
docker build -t "${IMAGE}" -f "${DOCKERFILE_PATH}" .

# ============================================================
# 5. push 镜像
# ============================================================
docker push "${IMAGE}"
echo "==========================================="
echo "镜像已推送: ${IMAGE}"
echo "==========================================="

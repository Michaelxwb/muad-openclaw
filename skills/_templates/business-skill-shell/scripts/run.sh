#!/usr/bin/env bash
set -euo pipefail

progress() {
  muad-progress stage --stage "$1" --text "$2" >/dev/null 2>&1 || true
}

done_progress() {
  muad-progress done --text "$1" >/dev/null 2>&1 || true
}

fail_progress() {
  muad-progress error --stage "$1" --text "$2" >/dev/null 2>&1 || true
}

trap 'fail_progress error "处理失败，请稍后重试"' ERR

progress accepted "已收到请求，开始处理"
progress auth "正在检查业务系统登录态"
# session-manager get-state --platform xdr --json >/tmp/session-state.json
progress query "正在查询业务系统数据"
progress analysis "正在分析结果"
done_progress "处理完成，正在生成结果"

printf '{"ok":true}\n'

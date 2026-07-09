#!/usr/bin/env bash
set -euo pipefail

STEP_DELAY="${MUAD_EXAMPLE_STEP_DELAY:-2}"

wait_next_step() {
  sleep "$STEP_DELAY"
}

muad-progress stage --stage accepted --text "阶段 1 - accepted：已收到请求，开始处理" >/dev/null 2>&1 || true
wait_next_step
muad-progress stage --stage auth --text "阶段 2 - auth：正在检查业务系统登录态" >/dev/null 2>&1 || true
wait_next_step
# session-manager get-state --platform xdr --json >/tmp/session-state.json
muad-progress stage --stage query --text "阶段 3 - query：正在查询业务系统数据" >/dev/null 2>&1 || true
wait_next_step
muad-progress stage --stage analysis --text "阶段 4 - analysis：正在分析结果" >/dev/null 2>&1 || true
wait_next_step
muad-progress done --text "阶段 5 - done：处理完成，正在生成结果" >/dev/null 2>&1 || true
printf '{"ok":true,"skill":"example-long-task"}\n'

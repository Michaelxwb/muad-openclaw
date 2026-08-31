#!/usr/bin/env bash
set -euo pipefail

skill_name="business-skill-shell-template"
session_state_file="$(mktemp)"

progress() {
  if ! muad-progress "$@" >/dev/null 2>&1; then
    printf '[business-skill-shell-template] progress unavailable\n' >&2
  fi
}

cleanup() {
  rm -f "$session_state_file"
}

trap cleanup EXIT

progress stage --stage execute --text "开始处理业务请求"
if ! session-manager get-state --skill-name "$skill_name" >"$session_state_file"; then
  progress error --stage execute --text "业务处理失败，请稍后重试" --code business_failed
  printf '{"ok":false,"error":"处理失败，请稍后重试"}\n' >&2
  exit 1
fi

# 写文件用 SKILL_OUTPUT_DIR（guard 注入的 per-agent 目录）；别写 Skill 根目录（只读）或 /tmp
out_dir="${SKILL_OUTPUT_DIR:-}"
if [ -n "$out_dir" ]; then
  mkdir -p "$out_dir"
  printf '{"ok":true}\n' > "$out_dir/result.json"
fi

progress done --stage execute --text "业务处理已完成"
printf '{"ok":true}\n'
